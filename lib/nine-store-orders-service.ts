import { HttpError, requirePermission, type UserContext } from './db';
import {
  nineStorePageSize, nineStoreRoster, nineStoreSnapshotMaxBytes, type NineStoreCoverage, type NineStoreOrderQuery,
  type NineStoreFeedRows, type NineStoreHistoryMetadata, type NineStoreOrderResponse, type NineStoreOrderSnapshot,
} from './nine-store-orders-contract';

const shanghaiDay = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
});

export async function storeNineStoreOrderSnapshot(
  db: D1Database, tenantId: string, input: NineStoreOrderSnapshot, now = new Date(), importer?: Pick<UserContext, 'id' | 'email'>,
) {
  const observedAt = new Date(input.observedAt).toISOString();
  if (Date.parse(observedAt) > now.getTime() + 60_000) throw new HttpError(400, '采集时间晚于当前时间', 'NINE_STORE_TIME_INVALID');
  const snapshot = { ...input, observedAt,
    stores: [...input.stores].sort((a, b) => a.key.localeCompare(b.key)),
    tables: [...input.tables].sort((a, b) => a.kind.localeCompare(b.kind)),
    orders: [...input.orders].sort((a, b) => a.storeKey.localeCompare(b.storeKey) || a.recordId.localeCompare(b.recordId)),
    refunds: [...input.refunds].sort((a, b) => a.storeKey.localeCompare(b.storeKey) || a.recordId.localeCompare(b.recordId)),
  };
  const payloadJson = JSON.stringify(snapshot);
  const encoder = new TextEncoder();
  if (encoder.encode(payloadJson).length > nineStoreSnapshotMaxBytes) throw new HttpError(413, '订单快照超出大小限制', 'NINE_STORE_SNAPSHOT_TOO_LARGE');
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(JSON.stringify({ ...snapshot, observedAt: null })));
  const payloadHash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  const importedAt = now.toISOString();
  const upsert = db.prepare(`
    INSERT INTO nine_store_order_snapshots (tenant_id, observed_at, payload_hash, payload_json, imported_at)
    SELECT id, ?, ?, ?, ? FROM tenants WHERE id = ?
    ON CONFLICT (tenant_id) DO UPDATE SET
      observed_at = excluded.observed_at, payload_hash = excluded.payload_hash,
      payload_json = excluded.payload_json, imported_at = excluded.imported_at
    WHERE excluded.observed_at > nine_store_order_snapshots.observed_at
      AND NOT EXISTS (
        SELECT 1 FROM json_each(nine_store_order_snapshots.payload_json, '$.tables') before
        JOIN json_each(excluded.payload_json, '$.tables') after
          ON json_extract(before.value, '$.kind') = json_extract(after.value, '$.kind')
        WHERE CAST(json_extract(after.value, '$.revision') AS INTEGER)
          < CAST(json_extract(before.value, '$.revision') AS INTEGER)
      )
  `).bind(observedAt, payloadHash, payloadJson, importedAt, tenantId);
  const saved = importer ? (await db.batch([
    upsert,
    db.prepare(`
      INSERT INTO audit_logs (
        id, tenant_id, actor_id, actor_email, action, entity_type, entity_id,
        before_json, after_json, request_id, idempotency_key, source, created_at
      )
      SELECT ?, ?, ?, ?, 'IMPORT_OPENING_ORDERS', 'nine_store_order_snapshot', ?, NULL, ?, ?, ?, 'human', ?
      WHERE changes() = 1
    `).bind(crypto.randomUUID(), tenantId, importer.id, importer.email, observedAt,
      JSON.stringify({ observedAt, orders: snapshot.orders.length, refunds: snapshot.refunds.length }),
      crypto.randomUUID(), crypto.randomUUID(), importedAt),
  ]))[0] : await upsert.run();
  if (Number(saved.meta.changes) === 1) return { observedAt, replayed: false };
  const persisted = await db.prepare('SELECT observed_at, payload_hash FROM nine_store_order_snapshots WHERE tenant_id = ?')
    .bind(tenantId).first<{ observed_at: string; payload_hash: string }>();
  if (persisted?.observed_at === observedAt && persisted.payload_hash === payloadHash) return { observedAt, replayed: true };
  throw new HttpError(409, '订单快照过期或工作区尚未初始化', 'NINE_STORE_SNAPSHOT_OUTDATED');
}

export async function readNineStoreOrders(db: D1Database, user: UserContext, query: NineStoreOrderQuery): Promise<NineStoreOrderResponse> {
  const scope = user.channelScope;
  requirePermission(user, scope ? 'channels:read' : 'orders:read');
  const allowedStores = scope ? new Set<string>(nineStoreRoster
    .filter(([, platform]) => platform === scope).map(([key]) => key)) : null;
  if (allowedStores && (!allowedStores.size || query.store && !allowedStores.has(query.store))) {
    throw new HttpError(403, '当前账号无权查看此平台的店铺', 'CHANNEL_SCOPE_DENIED');
  }
  const stored = await db.prepare(`SELECT payload_json, observed_at, imported_at
    FROM nine_store_order_snapshots WHERE tenant_id = ?`).bind(user.tenantId)
    .first<{ payload_json: string; observed_at: string; imported_at: string }>();
  const section = query.section;
  if (!stored) return { ok: true, snapshot: null, section, total: 0, rows: [] };
  const snapshot = JSON.parse(stored.payload_json) as NineStoreOrderSnapshot;
  const scopedStores = snapshot.stores.filter((entry) => !allowedStores || allowedStores.has(entry.key) && entry.platform === scope);
  const byStore = new Map<string, NineStoreCoverage & { orderNumbers: Set<string> }>(scopedStores.map((entry) => [entry.key, {
    ...entry, orderLines: 0, uniqueOrders: 0, fulfillmentKnown: 0, refundLines: 0, orderNumbers: new Set<string>(),
  }]));
  for (const order of snapshot.orders) {
    const merchant = byStore.get(order.storeKey);
    if (!merchant) continue;
    merchant.orderLines += 1;
    merchant.orderNumbers.add(order.orderNo.toUpperCase());
    if (order.fulfillment) merchant.fulfillmentKnown += 1;
  }
  for (const refund of snapshot.refunds) {
    const merchant = byStore.get(refund.storeKey);
    if (merchant) merchant.refundLines += 1;
  }
  const stores = Array.from(byStore.values(), ({ orderNumbers, ...entry }) => ({ ...entry, uniqueOrders: orderNumbers.size }));
  const snapshotMetadata = {
    observedAt: stored.observed_at, importedAt: stored.imported_at, stores,
    // Refund/source counters aggregate stores outside the assigned platform.
    tables: allowedStores ? [] : snapshot.tables,
  };
  if (query.scope === 'history') {
    return { ok: true, section, snapshot: snapshotMetadata, ...await readArchivedRows(
      db, user.tenantId, stored.observed_at, query, allowedStores, scope,
    ) };
  }

  const collectedDay = shanghaiDay.format(new Date(stored.observed_at));
  const dateOf = (row: NineStoreOrderSnapshot['orders'][number] | NineStoreOrderSnapshot['refunds'][number]) => {
    const date = 'orderDate' in row ? row.orderDate : row.refundDate;
    return date && date <= collectedDay ? date : null;
  };
  const search = query.search.toLowerCase();
  const tableRows = snapshot[section].filter((row) => {
    const date = dateOf(row);
    return (!allowedStores || byStore.has(row.storeKey)) && (!query.store || row.storeKey === query.store)
      && (!search || row.orderNo.toLowerCase().includes(search) || row.sku?.toLowerCase().includes(search))
      && (!query.from || (date && date >= query.from)) && (!query.through || (date && date <= query.through))
      && (!query.fulfillment || ('fulfillment' in row && (row.fulfillment ?? 'unknown') === query.fulfillment));
  });
  tableRows.sort((a, b) => (dateOf(b) ?? '').localeCompare(dateOf(a) ?? '') || a.storeKey.localeCompare(b.storeKey)
    || a.orderNo.localeCompare(b.orderNo) || a.recordId.localeCompare(b.recordId));
  const rows = tableRows.slice((query.page - 1) * nineStorePageSize, query.page * nineStorePageSize).map((row) => {
    const fields = { storeKey: row.storeKey, orderNo: row.orderNo, sku: row.sku };
    return 'orderDate' in row ? { ...fields, orderDate: dateOf(row), quantity: row.quantity, fulfillment: row.fulfillment }
      : { ...fields, refundDate: dateOf(row) };
  });
  return { ok: true, section, total: tableRows.length, rows, snapshot: snapshotMetadata };
}

type ArchivedRow = {
  storeKey: string; orderNo: string; sku: string | null; eventDate: string | null;
  quantity: number | null; fulfillment: NineStoreFeedRows['orders'][number]['fulfillment']; history: NineStoreHistoryMetadata;
};

async function readArchivedRows(
  db: D1Database, tenantId: string, latestObservedAt: string, query: NineStoreOrderQuery,
  allowedStores: ReadonlySet<string> | null, scope: UserContext['channelScope'],
) {
  const source = query.section === 'orders' ? "source_table <> 'refunds'" : "source_table = 'refunds'";
  const conditions = ['tenant_id = ?', 'archived_at <= ?', source];
  const params: Array<string | number> = [tenantId, latestObservedAt];
  if (allowedStores) {
    conditions.push('store_key IN (SELECT value FROM json_each(?))');
    params.push(JSON.stringify([...allowedStores]));
  }
  if (scope && query.section === 'orders') {
    conditions.push('source_table = ?');
    params.push(`${scope}-orders`);
  }
  if (query.store) {
    conditions.push('store_key = ?');
    params.push(query.store);
  }
  if (query.search) {
    conditions.push('(instr(lower(order_no), lower(?)) > 0 OR instr(lower(sku), lower(?)) > 0)');
    params.push(query.search, query.search);
  }
  if (query.fulfillment === 'unknown') conditions.push('fulfillment IS NULL');
  else if (query.fulfillment) {
    conditions.push('fulfillment = ?');
    params.push(query.fulfillment);
  }
  const dateConditions: string[] = [];
  if (query.from) {
    dateConditions.push('event_day >= ?');
    params.push(query.from);
  }
  if (query.through) {
    dateConditions.push('event_day <= ?');
    params.push(query.through);
  }
  const result = await db.prepare(`
    WITH archive_rows AS (
      SELECT *, CASE WHEN event_date <= date(observed_at, '+8 hours') THEN event_date END AS event_day
      FROM nine_store_order_history WHERE ${conditions.join(' AND ')}
    ), matched_rows AS (
      SELECT * FROM archive_rows ${dateConditions.length ? `WHERE ${dateConditions.join(' AND ')}` : ''}
    ), page_rows AS (
      SELECT * FROM matched_rows
      ORDER BY archived_at DESC, event_day DESC, store_key, order_no, source_record_id, observed_at DESC
      LIMIT ? OFFSET ?
    )
    SELECT (SELECT count(*) FROM matched_rows) AS total,
      json_group_array(json_object('storeKey', store_key, 'orderNo', order_no, 'sku', sku,
        'eventDate', event_day, 'quantity', quantity, 'fulfillment', fulfillment,
        'history', json_object('observedAt', observed_at, 'archivedAt', archived_at, 'change', change))) AS rows_json
    FROM page_rows
  `).bind(...params, nineStorePageSize, (query.page - 1) * nineStorePageSize).first<{ total: number; rows_json: string }>();
  if (!result) return { total: 0, rows: [] };
  const archived = JSON.parse(result.rows_json) as ArchivedRow[];
  const rows = archived.map(({ eventDate, quantity, fulfillment, ...shared }) => query.section === 'orders'
    ? { ...shared, orderDate: eventDate, quantity, fulfillment } : { ...shared, refundDate: eventDate });
  return { total: result.total, rows };
}
