import type { MukuDashboardClient } from './connectors/muku/client';
import type {
  MukuBusinessDatasetId,
  MukuDatasetExport,
  MukuManifestResponse,
  MukuRecord,
} from './connectors/muku/types';
import { HttpError, requirePermission, type UserContext } from './db';

export const MUKU_SYNC_DATASETS = [
  'inventory',
  'inventory-details',
  'inventory-risk',
  'source-status',
] as const satisfies readonly MukuBusinessDatasetId[];

export type MukuSyncDataset = (typeof MUKU_SYNC_DATASETS)[number];

type MukuClient = Pick<MukuDashboardClient, 'verifyManifest' | 'getAllPages'>;
type RecordProjection = {
  stableKey: string;
  rawJson: string;
  rawHash: string;
  sourceUpdatedAt: string | null;
  ingestedAt: string | null;
  value: MukuRecord;
};

type RunRow = {
  id: string;
  dataset: string;
  snapshot_id: string | null;
  status: 'running' | 'succeeded' | 'unchanged' | 'failed';
  idempotency_key: string;
  request_hash: string;
  page_count: number;
  record_count: number;
  content_hash: string | null;
  error_code: string | null;
  started_at: string;
  finished_at: string | null;
};

export async function testMukuConnection(client: MukuClient) {
  const manifest = await client.verifyManifest();
  return sanitizeManifest(manifest);
}

export async function syncMukuDatasets(input: {
  db: D1Database;
  user: UserContext;
  client: MukuClient;
  datasets: MukuSyncDataset[];
  idempotencyKey: string;
}) {
  requirePermission(input.user, 'connectors:sync');
  validateIdempotencyKey(input.idempotencyKey);
  const datasets = normalizeDatasets(input.datasets);
  const requestHash = await sha256(stableJson({ datasets }));
  const manifest = await input.client.verifyManifest();
  const manifestSummary = sanitizeManifest(manifest);
  for (const dataset of datasets) {
    if (!manifestSummary.datasets.includes(dataset)) {
      throw new HttpError(409, `MUKU 当前未提供 ${dataset} 数据集`, 'MUKU_DATASET_UNAVAILABLE');
    }
  }

  const results = [];
  for (const dataset of datasets) {
    results.push(await syncOneDataset({ ...input, dataset, requestHash }));
  }
  return {
    ok: results.every((result) => result.status !== 'failed'),
    apiVersion: manifestSummary.apiVersion,
    readOnly: true,
    results,
  };
}

async function syncOneDataset(input: {
  db: D1Database;
  user: UserContext;
  client: MukuClient;
  dataset: MukuSyncDataset;
  idempotencyKey: string;
  requestHash: string;
}) {
  const replay = await readRunByIdempotency(
    input.db,
    input.user.tenantId,
    input.dataset,
    input.idempotencyKey,
  );
  if (replay) {
    if (replay.request_hash !== input.requestHash) {
      throw new HttpError(409, '同一幂等键不能用于不同的 MUKU 同步参数', 'IDEMPOTENCY_CONFLICT');
    }
    return mapRun(replay, true);
  }

  const start = await startRun(input.db, input.user, input.dataset, input.idempotencyKey, input.requestHash);
  if ('replay' in start) return mapRun(start.replay, true);
  const run = start;
  try {
    const exported = await input.client.getAllPages<MukuRecord>(input.dataset, {}, {
      pageSize: 500,
      maxPages: 10_000,
    });
    validateExport(input.dataset, exported);
    if (exported.data.length === 0) {
      throw new MukuSyncDataError('MUKU_EMPTY_DATASET', 'MUKU 返回空数据，本次不替换旧快照');
    }
    const projections = await projectRecords(input.dataset, exported.data);
    const contentHash = await sha256(stableJson(
      projections.map((record) => [record.stableKey, record.rawHash]).sort((a, b) => a[0].localeCompare(b[0])),
    ));
    const state = await readDatasetState(input.db, input.user.tenantId, input.dataset);
    const currentSnapshot = state?.active_snapshot_id
      ? await input.db.prepare(`
          SELECT id, content_hash FROM muku_snapshots
          WHERE id = ? AND tenant_id = ? AND dataset = ? LIMIT 1
        `).bind(state.active_snapshot_id, input.user.tenantId, input.dataset).first<{
          id: string; content_hash: string;
        }>()
      : null;

    if (currentSnapshot?.content_hash === contentHash) {
      await finishUnchanged(
        input.db,
        input.user,
        run.id,
        run.leaseId,
        input.dataset,
        exported,
        contentHash,
        input.idempotencyKey,
      );
      return mapRun((await getRun(input.db, input.user.tenantId, run.id)), false);
    }

    const snapshotId = crypto.randomUUID();
    const now = new Date().toISOString();
    await input.db.batch([
      input.db.prepare(`
        INSERT INTO muku_snapshots (
          id, tenant_id, dataset, status, api_version, generated_at, source, grain,
          business_timezone, refresh_cadence, zero_semantics, filters_json, content_hash,
          page_count, record_count, expected_total, source_updated_at, ingested_at,
          activated_at, created_at
        ) VALUES (?, ?, ?, 'staging', ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?, ?, ?, NULL, ?)
      `).bind(
        snapshotId, input.user.tenantId, input.dataset, exported.apiVersion, exported.generatedAt,
        exported.source ?? null, exported.grain ?? null, exported.businessTimezone ?? null,
        exported.refreshCadence ?? null, exported.zeroSemantics ?? null, contentHash,
        exported.pageCount, projections.length, exported.total,
        maxTimestamp(projections.map((record) => record.sourceUpdatedAt)), now, now,
      ),
      input.db.prepare(`
        UPDATE muku_sync_runs SET snapshot_id = ?, page_count = ?, record_count = ?, content_hash = ?
        WHERE id = ? AND tenant_id = ? AND status = 'running' AND lease_id = ?
      `).bind(snapshotId, exported.pageCount, projections.length, contentHash, run.id, input.user.tenantId, run.leaseId),
    ]);

    const statements = projections.map((record) => buildRecordInsert(
      input.db,
      input.user.tenantId,
      snapshotId,
      input.dataset,
      record,
      now,
    ));
    for (let offset = 0; offset < statements.length; offset += 50) {
      await input.db.batch(statements.slice(offset, offset + 50));
    }
    await activateSnapshot({
      db: input.db,
      user: input.user,
      dataset: input.dataset,
      runId: run.id,
      leaseId: run.leaseId,
      snapshotId,
      exported,
      contentHash,
      idempotencyKey: input.idempotencyKey,
      now,
    });
    return mapRun((await getRun(input.db, input.user.tenantId, run.id)), false);
  } catch (error) {
    const safe = safeSyncError(error);
    await failRun(input.db, input.user, run.id, run.leaseId, input.dataset, safe.code, safe.message);
    return mapRun((await getRun(input.db, input.user.tenantId, run.id)), false);
  }
}

async function startRun(
  db: D1Database,
  user: UserContext,
  dataset: MukuSyncDataset,
  idempotencyKey: string,
  requestHash: string,
): Promise<{ id: string; leaseId: string } | { replay: RunRow }> {
  const now = new Date();
  const nowIso = now.toISOString();
  const leaseId = crypto.randomUUID();
  const leaseExpiresAt = new Date(now.getTime() + 10 * 60_000).toISOString();
  const runId = crypto.randomUUID();
  try {
    await db.batch([
      db.prepare(`
        UPDATE muku_sync_runs
        SET status = 'failed', error_code = 'MUKU_SYNC_LEASE_EXPIRED',
            error_message = '上一次同步租约已过期', finished_at = ?
        WHERE tenant_id = ? AND dataset = ? AND status = 'running' AND lease_expires_at <= ?
      `).bind(nowIso, user.tenantId, dataset, nowIso),
      db.prepare(`
        INSERT INTO muku_sync_runs (
          id, tenant_id, dataset, snapshot_id, status, idempotency_key, request_hash,
          lease_id, lease_expires_at, page_count, record_count, content_hash,
          error_code, error_message, started_at, finished_at
        ) VALUES (?, ?, ?, NULL, 'running', ?, ?, ?, ?, 0, 0, NULL, NULL, NULL, ?, NULL)
      `).bind(runId, user.tenantId, dataset, idempotencyKey, requestHash, leaseId, leaseExpiresAt, nowIso),
      db.prepare(`
        INSERT INTO muku_dataset_state (
          id, tenant_id, dataset, active_snapshot_id, status, api_version, generated_at,
          source, grain, business_timezone, refresh_cadence, zero_semantics, record_count,
          page_count, last_run_id, last_success_at, last_error_code, last_error_at, updated_at
        ) VALUES (?, ?, ?, NULL, 'running', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, NULL, NULL, NULL, ?)
        ON CONFLICT(tenant_id, dataset) DO UPDATE SET
          status = 'running', last_run_id = excluded.last_run_id, updated_at = excluded.updated_at
      `).bind(crypto.randomUUID(), user.tenantId, dataset, runId, nowIso),
    ]);
  } catch (error) {
    const replay = await readRunByIdempotency(db, user.tenantId, dataset, idempotencyKey);
    if (replay) {
      if (replay.request_hash !== requestHash) {
        throw new HttpError(409, '同一幂等键不能用于不同的 MUKU 同步参数', 'IDEMPOTENCY_CONFLICT');
      }
      return { replay };
    }
    if (String(error).includes('uq_muku_sync_runs_running') || String(error).includes('UNIQUE constraint failed')) {
      throw new HttpError(409, `${dataset} 已有同步任务正在运行`, 'MUKU_SYNC_ALREADY_RUNNING');
    }
    throw error;
  }
  return { id: runId, leaseId };
}

async function activateSnapshot(input: {
  db: D1Database;
  user: UserContext;
  dataset: MukuSyncDataset;
  runId: string;
  leaseId: string;
  snapshotId: string;
  exported: MukuDatasetExport<MukuRecord>;
  contentHash: string;
  idempotencyKey: string;
  now: string;
}) {
  const auditKey = await auditIdempotencyKey(input.idempotencyKey, input.dataset);
  const results = await input.db.batch([
    input.db.prepare(`
      UPDATE muku_snapshots SET status = 'superseded'
      WHERE tenant_id = ? AND dataset = ? AND status = 'active' AND id <> ?
        AND EXISTS (
          SELECT 1 FROM muku_snapshots target
          JOIN muku_sync_runs run ON run.snapshot_id = target.id
          WHERE target.id = ? AND target.tenant_id = ? AND target.dataset = ?
            AND target.status = 'staging' AND run.id = ? AND run.tenant_id = ?
            AND run.status = 'running' AND run.lease_id = ?
            AND EXISTS (
              SELECT 1 FROM muku_dataset_state state
              WHERE state.tenant_id = ? AND state.dataset = ? AND state.last_run_id = ?
            )
        )
    `).bind(
      input.user.tenantId, input.dataset, input.snapshotId,
      input.snapshotId, input.user.tenantId, input.dataset,
      input.runId, input.user.tenantId, input.leaseId,
      input.user.tenantId, input.dataset, input.runId,
    ),
    input.db.prepare(`
      UPDATE muku_snapshots SET status = 'active', activated_at = ?
      WHERE id = ? AND tenant_id = ? AND dataset = ? AND status = 'staging'
        AND EXISTS (
          SELECT 1 FROM muku_sync_runs
          WHERE id = ? AND tenant_id = ? AND status = 'running' AND lease_id = ?
            AND EXISTS (
              SELECT 1 FROM muku_dataset_state
              WHERE tenant_id = ? AND dataset = ? AND last_run_id = ?
            )
        )
    `).bind(
      input.now, input.snapshotId, input.user.tenantId, input.dataset,
      input.runId, input.user.tenantId, input.leaseId,
      input.user.tenantId, input.dataset, input.runId,
    ),
    input.db.prepare(`
      UPDATE muku_dataset_state SET
        active_snapshot_id = ?, status = 'ready', api_version = ?, generated_at = ?,
        source = ?, grain = ?, business_timezone = ?, refresh_cadence = ?, zero_semantics = ?,
        record_count = ?, page_count = ?, last_run_id = ?, last_success_at = ?,
        last_error_code = NULL, last_error_at = NULL, updated_at = ?
      WHERE tenant_id = ? AND dataset = ? AND last_run_id = ?
        AND EXISTS (
          SELECT 1 FROM muku_snapshots
          WHERE id = ? AND tenant_id = ? AND dataset = ? AND status = 'active'
        )
    `).bind(
      input.snapshotId, input.exported.apiVersion, input.exported.generatedAt,
      input.exported.source ?? null, input.exported.grain ?? null,
      input.exported.businessTimezone ?? null, input.exported.refreshCadence ?? null,
      input.exported.zeroSemantics ?? null, input.exported.data.length, input.exported.pageCount,
      input.runId, input.now, input.now, input.user.tenantId, input.dataset, input.runId,
      input.snapshotId, input.user.tenantId, input.dataset,
    ),
    input.db.prepare(`
      UPDATE muku_sync_runs SET status = 'succeeded', snapshot_id = ?, page_count = ?,
        record_count = ?, content_hash = ?, finished_at = ?
      WHERE id = ? AND tenant_id = ? AND status = 'running' AND lease_id = ?
        AND EXISTS (
          SELECT 1 FROM muku_dataset_state
          WHERE tenant_id = ? AND dataset = ? AND active_snapshot_id = ? AND last_run_id = ?
        )
    `).bind(
      input.snapshotId, input.exported.pageCount, input.exported.data.length, input.contentHash,
      input.now, input.runId, input.user.tenantId, input.leaseId,
      input.user.tenantId, input.dataset, input.snapshotId, input.runId,
    ),
    auditInsertForRun(input.db, input.user, {
      action: 'SYNC_MUKU_DATASET',
      entityId: input.dataset,
      idempotencyKey: auditKey,
      afterJson: stableJson({
        dataset: input.dataset,
        snapshotId: input.snapshotId,
        pageCount: input.exported.pageCount,
        recordCount: input.exported.data.length,
        contentHash: input.contentHash,
      }),
      now: input.now,
      runId: input.runId,
      runStatus: 'succeeded',
    }),
  ]);
  if (Number(results[1]?.meta?.changes ?? 0) !== 1
    || Number(results[2]?.meta?.changes ?? 0) !== 1
    || Number(results[3]?.meta?.changes ?? 0) !== 1
    || Number(results[4]?.meta?.changes ?? 0) !== 1) {
    throw new MukuSyncDataError('MUKU_SYNC_STATE_CHANGED', '同步状态已变化，本次没有切换有效快照');
  }
}

async function finishUnchanged(
  db: D1Database,
  user: UserContext,
  runId: string,
  leaseId: string,
  dataset: MukuSyncDataset,
  exported: MukuDatasetExport<MukuRecord>,
  contentHash: string,
  idempotencyKey: string,
) {
  const now = new Date().toISOString();
  const auditKey = await auditIdempotencyKey(idempotencyKey, dataset);
  const results = await db.batch([
    db.prepare(`
      UPDATE muku_dataset_state SET status = 'ready', api_version = ?, generated_at = ?,
        source = ?, grain = ?, business_timezone = ?, refresh_cadence = ?, zero_semantics = ?,
        page_count = ?, record_count = ?, last_run_id = ?, last_success_at = ?,
        last_error_code = NULL, last_error_at = NULL, updated_at = ?
      WHERE tenant_id = ? AND dataset = ? AND last_run_id = ?
        AND EXISTS (
          SELECT 1 FROM muku_sync_runs
          WHERE id = ? AND tenant_id = ? AND status = 'running' AND lease_id = ?
        )
    `).bind(
      exported.apiVersion, exported.generatedAt, exported.source ?? null, exported.grain ?? null,
      exported.businessTimezone ?? null, exported.refreshCadence ?? null, exported.zeroSemantics ?? null,
      exported.pageCount, exported.data.length, runId, now, now, user.tenantId, dataset, runId,
      runId, user.tenantId, leaseId,
    ),
    db.prepare(`
      UPDATE muku_sync_runs SET status = 'unchanged', page_count = ?, record_count = ?,
        content_hash = ?, finished_at = ?
      WHERE id = ? AND tenant_id = ? AND status = 'running' AND lease_id = ?
        AND EXISTS (
          SELECT 1 FROM muku_dataset_state
          WHERE tenant_id = ? AND dataset = ? AND active_snapshot_id IS NOT NULL AND last_run_id = ?
        )
    `).bind(
      exported.pageCount, exported.data.length, contentHash, now, runId, user.tenantId, leaseId,
      user.tenantId, dataset, runId,
    ),
    auditInsertForRun(db, user, {
      action: 'SYNC_MUKU_DATASET_UNCHANGED',
      entityId: dataset,
      idempotencyKey: auditKey,
      afterJson: stableJson({ dataset, pageCount: exported.pageCount, recordCount: exported.data.length, contentHash }),
      now,
      runId,
      runStatus: 'unchanged',
    }),
  ]);
  if (results.some((result) => Number(result.meta?.changes ?? 0) !== 1)) {
    throw new MukuSyncDataError('MUKU_SYNC_STATE_CHANGED', '同步状态已变化，本次没有更新有效快照');
  }
}

async function failRun(
  db: D1Database,
  user: UserContext,
  runId: string,
  leaseId: string,
  dataset: MukuSyncDataset,
  errorCode: string,
  errorMessage: string,
) {
  const now = new Date().toISOString();
  await db.batch([
    db.prepare(`
      UPDATE muku_sync_runs SET status = 'failed', error_code = ?, error_message = ?, finished_at = ?
      WHERE id = ? AND tenant_id = ? AND status = 'running' AND lease_id = ?
    `).bind(errorCode, errorMessage, now, runId, user.tenantId, leaseId),
    db.prepare(`
      UPDATE muku_dataset_state SET
        status = CASE WHEN active_snapshot_id IS NULL THEN 'failed' ELSE 'delayed' END,
        last_run_id = ?, last_error_code = ?, last_error_at = ?, updated_at = ?
      WHERE tenant_id = ? AND dataset = ? AND last_run_id = ?
    `).bind(runId, errorCode, now, now, user.tenantId, dataset, runId),
    db.prepare(`
      UPDATE muku_snapshots SET status = 'failed'
      WHERE tenant_id = ? AND dataset = ? AND status = 'staging'
        AND id = (SELECT snapshot_id FROM muku_sync_runs WHERE id = ? AND tenant_id = ?)
    `).bind(user.tenantId, dataset, runId, user.tenantId),
  ]);
}

export async function getMukuStatus(db: D1Database, user: UserContext) {
  requirePermission(user, 'connectors:read');
  const [states, sourceStatuses] = await Promise.all([
    db.prepare(`
      SELECT dataset, active_snapshot_id, status, api_version, generated_at, source, grain,
             business_timezone, refresh_cadence, zero_semantics, record_count, page_count,
             last_run_id, last_success_at, last_error_code, last_error_at, updated_at
      FROM muku_dataset_state WHERE tenant_id = ? ORDER BY dataset
    `).bind(user.tenantId).all<Record<string, unknown>>(),
    db.prepare(`
      SELECT r.source_kind, r.source_id, r.status, r.business_date, r.message, r.record_count,
             r.source_updated_at, r.ingested_at
      FROM muku_source_status_records r
      JOIN muku_dataset_state s ON s.active_snapshot_id = r.snapshot_id
      WHERE r.tenant_id = ? AND s.tenant_id = r.tenant_id AND s.dataset = 'source-status'
      ORDER BY r.source_kind, r.source_id, r.business_date DESC LIMIT 500
    `).bind(user.tenantId).all<Record<string, unknown>>(),
  ]);
  return {
    ok: true,
    readOnly: true,
    datasets: states.results.map(mapState),
    sourceStatuses: sourceStatuses.results.map(camelizeRecord),
  };
}

export async function getMukuInventory(
  db: D1Database,
  user: UserContext,
  query: { sku?: string; warehouse?: string; page: number; pageSize: number },
) {
  requirePermission(user, 'connectors:read');
  return querySnapshotRecords(db, user, 'inventory', 'muku_inventory_records', query, [
    'sku', 'warehouse_code', 'warehouse_name',
  ]);
}

export async function getMukuInventoryDetails(
  db: D1Database,
  user: UserContext,
  query: { sku?: string; warehouse?: string; page: number; pageSize: number },
) {
  requirePermission(user, 'connectors:read');
  return querySnapshotRecords(db, user, 'inventory-details', 'muku_inventory_detail_records', query, [
    'sku', 'warehouse_code', 'warehouse_name',
  ]);
}

export async function getMukuInventoryRisk(
  db: D1Database,
  user: UserContext,
  query: { sku?: string; page: number; pageSize: number },
) {
  requirePermission(user, 'connectors:read');
  return querySnapshotRecords(db, user, 'inventory-risk', 'muku_inventory_risk_records', query, ['sku']);
}

export async function getMukuRuns(
  db: D1Database,
  user: UserContext,
  query: { dataset?: string; page: number; pageSize: number },
) {
  requirePermission(user, 'connectors:read');
  const where = ['tenant_id = ?'];
  const bindings: unknown[] = [user.tenantId];
  if (query.dataset) {
    where.push('dataset = ?');
    bindings.push(query.dataset);
  }
  const offset = (query.page - 1) * query.pageSize;
  const [rows, count] = await Promise.all([
    db.prepare(`
      SELECT id, dataset, snapshot_id, status, page_count, record_count, content_hash,
             error_code, started_at, finished_at
      FROM muku_sync_runs WHERE ${where.join(' AND ')}
      ORDER BY started_at DESC LIMIT ? OFFSET ?
    `).bind(...bindings, query.pageSize, offset).all<Record<string, unknown>>(),
    db.prepare(`SELECT COUNT(*) AS count FROM muku_sync_runs WHERE ${where.join(' AND ')}`)
      .bind(...bindings).first<{ count: number }>(),
  ]);
  return paginated(rows.results.map(camelizeRecord), Number(count?.count ?? 0), query.page, query.pageSize);
}

async function querySnapshotRecords(
  db: D1Database,
  user: UserContext,
  dataset: MukuSyncDataset,
  table: string,
  query: { sku?: string; warehouse?: string; page: number; pageSize: number },
  allowedColumns: string[],
) {
  const state = await readDatasetState(db, user.tenantId, dataset);
  if (!state?.active_snapshot_id) {
    return { ok: true, dataset, state: state ? mapState(state) : null, ...paginated([], 0, query.page, query.pageSize) };
  }
  const where = ['tenant_id = ?', 'snapshot_id = ?'];
  const bindings: unknown[] = [user.tenantId, state.active_snapshot_id];
  if (query.sku && allowedColumns.includes('sku')) {
    where.push(`LOWER(REPLACE(sku, ' ', '')) = LOWER(REPLACE(?, ' ', ''))`);
    bindings.push(query.sku);
  }
  if (query.warehouse && allowedColumns.includes('warehouse_code')) {
    where.push('(LOWER(warehouse_code) = LOWER(?) OR LOWER(warehouse_name) = LOWER(?))');
    bindings.push(query.warehouse, query.warehouse);
  }
  const offset = (query.page - 1) * query.pageSize;
  const [rows, count] = await Promise.all([
    db.prepare(`SELECT * FROM ${table} WHERE ${where.join(' AND ')} ORDER BY stable_key LIMIT ? OFFSET ?`)
      .bind(...bindings, query.pageSize, offset).all<Record<string, unknown>>(),
    db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where.join(' AND ')}`)
      .bind(...bindings).first<{ count: number }>(),
  ]);
  return {
    ok: true,
    dataset,
    state: mapState(state),
    ...paginated(rows.results.map((row) => {
      const mapped = camelizeRecord(row);
      delete mapped.tenantId;
      delete mapped.id;
      delete mapped.rawJson;
      delete mapped.rawHash;
      delete mapped.createdAt;
      return mapped;
    }), Number(count?.count ?? 0), query.page, query.pageSize),
  };
}

function buildRecordInsert(
  db: D1Database,
  tenantId: string,
  snapshotId: string,
  dataset: MukuSyncDataset,
  record: RecordProjection,
  now: string,
) {
  const value = record.value;
  const common = [crypto.randomUUID(), tenantId, snapshotId, record.stableKey];
  if (dataset === 'inventory') {
    return db.prepare(`
      INSERT INTO muku_inventory_records (
        id, tenant_id, snapshot_id, stable_key, record_key, source_id, source_snapshot_id,
        inventory_kind, warehouse_code, warehouse_name, region, sku, available_qty,
        locked_qty, on_hand_qty, inbound_qty, age_days, source_updated_at, ingested_at,
        raw_json, raw_hash, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(...common, stringValue(value.recordKey), stringValue(value.sourceId), stringValue(value.snapshotId),
      stringValue(value.inventoryKind), stringValue(value.warehouseCode), stringValue(value.warehouseName),
      stringValue(value.region), stringValue(value.sku), integerValue(value.availableQty),
      integerValue(value.lockedQty), integerValue(value.onHandQty), integerValue(value.inboundQty),
      integerValue(value.ageDays), record.sourceUpdatedAt, record.ingestedAt, record.rawJson, record.rawHash, now);
  }
  if (dataset === 'inventory-details') {
    return db.prepare(`
      INSERT INTO muku_inventory_detail_records (
        id, tenant_id, snapshot_id, stable_key, record_key, source_id, source_snapshot_id,
        source_kind, warehouse_code, warehouse_name, region, sku, cabinet_no, received_at,
        note, stock_status, package_barcode, product_dimensions, package_dimensions,
        product_color_style, packaging_type,
        reserved_order_no, inbound_batch, sequence_no, parent_spu, parent_record, category,
        estimated_arrival_at, age_days, quantity, stock_unit_qty, source_updated_at, ingested_at,
        raw_json, raw_hash, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(...common, stringValue(value.recordKey), stringValue(value.sourceId), stringValue(value.snapshotId),
      stringValue(value.sourceKind), stringValue(value.warehouseCode), stringValue(value.warehouseName),
      stringValue(value.region), stringValue(value.sku), stringValue(value.cabinetNo), stringValue(value.receivedAt),
      stringValue(value.note), stringValue(value.stockStatus), stringValue(value.packageBarcode),
      stringValue(value.productDimensions), stringValue(value.packageDimensions),
      stringValue(value.productColorStyle), stringValue(value.packagingType),
      stringValue(value.reservedOrderNo), stringValue(value.inboundBatch), stringValue(value.sequenceNo),
      stringValue(value.parentSpu), stringValue(value.parentRecord), stringValue(value.category),
      stringValue(value.estimatedArrivalAt), integerValue(value.ageDays), integerValue(value.quantity),
      integerValue(value.stockUnitQty), record.sourceUpdatedAt, record.ingestedAt, record.rawJson, record.rawHash, now);
  }
  if (dataset === 'inventory-risk') {
    return db.prepare(`
      INSERT INTO muku_inventory_risk_records (
        id, tenant_id, snapshot_id, stable_key, sku, sales_30d, available_qty, locked_qty,
        on_hand_qty, inbound_qty, warehouse_count, max_age_days, slow_moving, over_age,
        active_low_stock, matched_by, source_updated_at, raw_json, raw_hash, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(...common, stringValue(value.sku), integerValue(value.sales30d), integerValue(value.available),
      integerValue(value.locked), integerValue(value.onHand), integerValue(value.inbound),
      integerValue(value.warehouseCount), integerValue(value.maxAgeDays), booleanInteger(value.slowMoving),
      booleanInteger(value.overAge), booleanInteger(value.activeLowStock), stringValue(value.matchedBy),
      record.sourceUpdatedAt, record.rawJson, record.rawHash, now);
  }
  return db.prepare(`
    INSERT INTO muku_source_status_records (
      id, tenant_id, snapshot_id, stable_key, source_kind, source_id, status,
      business_date, message, record_count, source_updated_at, ingested_at,
      raw_json, raw_hash, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(...common, stringValue(value.sourceKind), stringValue(value.sourceId), stringValue(value.status),
    stringValue(value.businessDate), stringValue(value.message), integerValue(value.recordCount),
    record.sourceUpdatedAt, record.ingestedAt, record.rawJson, record.rawHash, now);
}

async function projectRecords(dataset: MukuSyncDataset, records: MukuRecord[]) {
  const projected: RecordProjection[] = [];
  const seen = new Set<string>();
  for (const value of records) {
    const stableKey = stableRecordKey(dataset, value);
    if (seen.has(stableKey)) {
      throw new MukuSyncDataError('MUKU_DUPLICATE_STABLE_KEY', `MUKU ${dataset} 返回重复业务键`);
    }
    seen.add(stableKey);
    const rawJson = stableJson(value);
    projected.push({
      stableKey,
      rawJson,
      rawHash: await sha256(rawJson),
      sourceUpdatedAt: stringValue(value.sourceUpdatedAt),
      ingestedAt: stringValue(value.ingestedAt),
      value,
    });
  }
  return projected;
}

function stableRecordKey(dataset: MukuSyncDataset, value: MukuRecord) {
  if (dataset === 'inventory' || dataset === 'inventory-details') {
    const recordKey = stringValue(value.recordKey);
    if (!recordKey) throw new MukuSyncDataError('MUKU_MISSING_STABLE_KEY', `${dataset} 缺少 recordKey`);
    return recordKey;
  }
  if (dataset === 'inventory-risk') {
    const sku = stringValue(value.sku);
    if (!sku) throw new MukuSyncDataError('MUKU_MISSING_STABLE_KEY', 'inventory-risk 缺少 sku');
    return sku.trim().toUpperCase();
  }
  const sourceKind = stringValue(value.sourceKind);
  const sourceId = stringValue(value.sourceId);
  if (!sourceKind || !sourceId) {
    throw new MukuSyncDataError('MUKU_MISSING_STABLE_KEY', 'source-status 缺少 sourceKind 或 sourceId');
  }
  return stableJson([sourceKind, sourceId, stringValue(value.businessDate)]);
}

function validateExport(dataset: MukuSyncDataset, exported: MukuDatasetExport<MukuRecord>) {
  if (exported.dataset !== dataset || exported.apiVersion !== 'v1') {
    throw new MukuSyncDataError('MUKU_RESPONSE_CONTRACT_MISMATCH', 'MUKU 响应版本或数据集不一致');
  }
  if (!Number.isInteger(exported.pageCount) || exported.pageCount < 1
    || !Number.isInteger(exported.total) || exported.total < 0
    || exported.total !== exported.data.length) {
    throw new MukuSyncDataError('MUKU_PAGINATION_INCOMPLETE', 'MUKU 分页记录数不完整');
  }
}

function sanitizeManifest(manifest: MukuManifestResponse) {
  const manifestDatasets = Array.isArray(manifest.datasets)
    ? manifest.datasets.map((entry) => {
        if (typeof entry === 'string') return entry;
        if (entry && typeof entry === 'object') {
          const record = entry as Record<string, unknown>;
          return stringValue(record.id) ?? stringValue(record.dataset) ?? stringValue(record.name);
        }
        return null;
      }).filter((entry): entry is string => Boolean(entry))
    : [];
  const datasets = [...new Set([
    ...(Array.isArray(manifest.datasetIds) ? manifest.datasetIds : []),
    ...manifestDatasets,
  ])].sort();
  return {
    ok: true as const,
    apiVersion: manifest.apiVersion,
    generatedAt: manifest.generatedAt,
    datasets,
    datasetCount: datasets.length,
    readOnly: true as const,
  };
}

async function readRunByIdempotency(db: D1Database, tenantId: string, dataset: string, key: string) {
  return db.prepare(`
    SELECT id, dataset, snapshot_id, status, idempotency_key, request_hash,
           page_count, record_count, content_hash, error_code, started_at, finished_at
    FROM muku_sync_runs WHERE tenant_id = ? AND dataset = ? AND idempotency_key = ? LIMIT 1
  `).bind(tenantId, dataset, key).first<RunRow>();
}

async function getRun(db: D1Database, tenantId: string, id: string) {
  const row = await db.prepare(`
    SELECT id, dataset, snapshot_id, status, idempotency_key, request_hash,
           page_count, record_count, content_hash, error_code, started_at, finished_at
    FROM muku_sync_runs WHERE tenant_id = ? AND id = ? LIMIT 1
  `).bind(tenantId, id).first<RunRow>();
  if (!row) throw new HttpError(404, 'MUKU 同步记录不存在', 'MUKU_SYNC_RUN_NOT_FOUND');
  return row;
}

async function readDatasetState(db: D1Database, tenantId: string, dataset: string) {
  return db.prepare(`
    SELECT dataset, active_snapshot_id, status, api_version, generated_at, source, grain,
           business_timezone, refresh_cadence, zero_semantics, record_count, page_count,
           last_run_id, last_success_at, last_error_code, last_error_at, updated_at
    FROM muku_dataset_state WHERE tenant_id = ? AND dataset = ? LIMIT 1
  `).bind(tenantId, dataset).first<Record<string, unknown> & { active_snapshot_id: string | null }>();
}

function mapRun(row: RunRow, replayed: boolean) {
  return {
    id: row.id,
    dataset: row.dataset,
    snapshotId: row.snapshot_id,
    status: row.status,
    pageCount: Number(row.page_count),
    recordCount: Number(row.record_count),
    contentHash: row.content_hash,
    errorCode: row.error_code,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    replayed,
  };
}

function mapState(row: Record<string, unknown>) {
  return camelizeRecord(row);
}

function camelizeRecord(row: Record<string, unknown>) {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    result[key.replace(/_([a-z0-9])/g, (_, char: string) => char.toUpperCase())] = value;
  }
  return result;
}

function paginated<T>(data: T[], total: number, page: number, pageSize: number) {
  const totalPages = total === 0 ? 0 : Math.ceil(total / pageSize);
  return {
    data,
    pagination: { page, pageSize, total, totalPages, hasNext: page < totalPages },
  };
}

function normalizeDatasets(datasets: MukuSyncDataset[]) {
  const values = datasets.length ? datasets : [...MUKU_SYNC_DATASETS];
  const unique = [...new Set(values)].sort() as MukuSyncDataset[];
  if (unique.some((dataset) => !MUKU_SYNC_DATASETS.includes(dataset))) {
    throw new HttpError(400, '包含尚未支持的 MUKU 数据集', 'INVALID_MUKU_DATASET');
  }
  return unique;
}

function validateIdempotencyKey(key: string) {
  if (!key || key.length < 8 || key.length > 128) {
    throw new HttpError(400, '缺少有效的 Idempotency-Key', 'INVALID_IDEMPOTENCY_KEY');
  }
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function integerValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

function booleanInteger(value: unknown): number | null {
  return typeof value === 'boolean' ? (value ? 1 : 0) : null;
}

function maxTimestamp(values: Array<string | null>) {
  return values.filter((value): value is string => Boolean(value)).sort().at(-1) ?? null;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => (
      `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

async function sha256(value: string) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function auditIdempotencyKey(key: string, dataset: string) {
  return `muku:${(await sha256(`${key}:${dataset}`)).slice(0, 48)}`;
}

function auditInsertForRun(
  db: D1Database,
  user: UserContext,
  input: {
    action: string;
    entityId: string;
    idempotencyKey: string;
    afterJson: string;
    now: string;
    runId: string;
    runStatus: 'succeeded' | 'unchanged';
  },
) {
  return db.prepare(`
    INSERT INTO audit_logs (
      id, tenant_id, actor_id, actor_email, action, entity_type, entity_id,
      before_json, after_json, request_id, idempotency_key, source, created_at
    )
    SELECT ?, ?, ?, ?, ?, 'muku_dataset', ?, NULL, ?, ?, ?, 'system', ?
    WHERE EXISTS (
      SELECT 1 FROM muku_sync_runs
      WHERE id = ? AND tenant_id = ? AND status = ?
    )
  `).bind(
    crypto.randomUUID(), user.tenantId, user.id, user.email, input.action, input.entityId,
    input.afterJson, crypto.randomUUID(), input.idempotencyKey, input.now,
    input.runId, user.tenantId, input.runStatus,
  );
}

function safeSyncError(error: unknown) {
  if (error instanceof MukuSyncDataError) return { code: error.code, message: error.message };
  if (error && typeof error === 'object') {
    const candidate = error as { code?: unknown; status?: unknown };
    const code = typeof candidate.code === 'string' && /^MUKU_[A-Z0-9_]+$/.test(candidate.code)
      ? candidate.code
      : 'MUKU_SYNC_FAILED';
    if (candidate.status === 401 || code.includes('AUTH')) return { code: 'MUKU_AUTH_FAILED', message: 'MUKU 只读凭证无效或已失效' };
    if (candidate.status === 429) return { code: 'MUKU_RATE_LIMITED', message: 'MUKU 暂时限流，请稍后重试' };
    return { code, message: 'MUKU 只读数据同步失败，已保留上一份有效数据' };
  }
  return { code: 'MUKU_SYNC_FAILED', message: 'MUKU 只读数据同步失败，已保留上一份有效数据' };
}

class MukuSyncDataError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}
