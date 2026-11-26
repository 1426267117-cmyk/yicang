import { requirePermission, type UserContext } from './db';
import { isShopifyStoreKey } from './connectors/shopify/config';
import { nineStoreRoster } from './nine-store-orders-contract';

const labels = {
  'amazon-senyu': '森语', 'amazon-kaguyasu': 'Kaguyasu', 'amazon-zhongcheng': '中诚', 'amazon-genji': 'Genji',
  'shopify-kaguyasu': 'Kaguyasu', 'shopify-zimasya': 'ZIMASYA', 'shopify-anzhap': 'Anzhap', 'shopify-bizfurniz': 'BizFurniz',
  'wayfair-linhe': '林和',
} satisfies Record<(typeof nineStoreRoster)[number][0], string>;

const nativeFreshMinutes = 30;
const feishuFreshMinutes = 15;

type Freshness = 'recent' | 'stale' | 'unknown';
type NativeRow = {
  platform: string; connector_key: string; active: number; identity_verified_at: string;
  last_successful_sync_at: string | null; order_count: number; last_order_fetched_at: string | null;
};
type SnapshotRow = { store_key: string; observed_at: string; imported_at: string; order_count: number; line_count: number };
type ArchiveRow = { store_key: string; order_count: number; version_count: number; last_archived_at: string };

function verifiedTimestamp(value: string | null, now: number) {
  if (!value) return null;
  const moment = Date.parse(value);
  return Number.isFinite(moment) && moment <= now + 60_000 ? new Date(moment).toISOString() : null;
}

function freshness(value: string | null, now: number, maxAgeMinutes: number): Freshness {
  if (!value) return 'unknown';
  return now - Date.parse(value) <= maxAgeMinutes * 60_000 ? 'recent' : 'stale';
}

function nativeCoverage(matches: NativeRow[], now: number) {
  const [match] = matches;
  const state = matches.length > 1 ? 'ambiguous' as const
    : !match || !verifiedTimestamp(match.identity_verified_at, now) ? 'pending' as const
      : match.active === 1 ? 'verified' as const : 'inactive' as const;
  const trusted = state === 'verified' || state === 'inactive';
  const lastSuccessfulSyncAt = trusted ? verifiedTimestamp(match.last_successful_sync_at, now) : null;
  return {
    state,
    orderCount: trusted ? Number(match.order_count) : null,
    lastSuccessfulSyncAt,
    lastOrderFetchedAt: trusted ? verifiedTimestamp(match.last_order_fetched_at, now) : null,
    freshness: state === 'verified' ? freshness(lastSuccessfulSyncAt, now, nativeFreshMinutes) : 'unknown' as const,
  };
}

const requestedStores = `SELECT json_extract(value, '$.key') AS key, json_extract(value, '$.platform') AS platform
  FROM json_each(?)`;

export async function readStoreCoverage(db: D1Database, user: UserContext, now = new Date()) {
  const scope = user.channelScope;
  requirePermission(user, scope ? 'channels:read' : 'orders:read');
  const roster = nineStoreRoster.filter(([, platform]) => !scope || platform === scope).map(([key, platform]) => {
    const shortKey = key.replace(/^shopify-/u, '');
    const nativeKeys: string[] = platform === 'shopify' && isShopifyStoreKey(shortKey) ? [key, shortKey] : [key];
    return { key, platform, name: labels[key], nativeKeys };
  });
  const expected = JSON.stringify(roster.map(({ key, platform }) => ({ key, platform })));
  const nativeIdentities = JSON.stringify(roster.flatMap(({ nativeKeys, platform }) => nativeKeys.map(key => ({ key, platform }))));
  const [native, snapshots, archives] = await db.batch<NativeRow | SnapshotRow | ArchiveRow>([
    db.prepare(`WITH expected AS (${requestedStores})
      SELECT store.platform, store.connector_key, store.active, store.identity_verified_at, store.last_successful_sync_at,
        COUNT(orders.id) AS order_count, MAX(orders.fetched_at) AS last_order_fetched_at
      FROM expected JOIN platform_stores store ON store.platform = expected.platform AND store.connector_key = expected.key
      LEFT JOIN platform_orders orders ON orders.tenant_id = store.tenant_id AND orders.platform = store.platform
        AND orders.platform_store_id = store.id AND COALESCE(orders.test, 0) = 0
      WHERE store.tenant_id = ? AND NULLIF(TRIM(store.official_store_id), '') IS NOT NULL
      GROUP BY store.id`).bind(nativeIdentities, user.tenantId),
    db.prepare(`WITH expected AS (${requestedStores}), snapshot AS (
        SELECT payload_json, observed_at, imported_at FROM nine_store_order_snapshots WHERE tenant_id = ?
      ), order_totals AS (
        SELECT expected.key, COUNT(*) AS line_count,
          COUNT(DISTINCT UPPER(json_extract(orders.value, '$.orderNo'))) AS order_count
        FROM snapshot JOIN json_each(snapshot.payload_json, '$.orders') orders
        JOIN expected ON expected.key = json_extract(orders.value, '$.storeKey') GROUP BY expected.key
      )
      SELECT expected.key AS store_key, snapshot.observed_at, snapshot.imported_at,
        COALESCE(order_totals.order_count, 0) AS order_count, COALESCE(order_totals.line_count, 0) AS line_count
      FROM snapshot JOIN json_each(snapshot.payload_json, '$.stores') store
      JOIN expected ON expected.key = json_extract(store.value, '$.key') AND expected.platform = json_extract(store.value, '$.platform')
      LEFT JOIN order_totals ON order_totals.key = expected.key`).bind(expected, user.tenantId),
    db.prepare(`WITH expected AS (${requestedStores})
      SELECT history.store_key, COUNT(DISTINCT UPPER(history.order_no)) AS order_count,
        COUNT(*) AS version_count, MAX(history.archived_at) AS last_archived_at
      FROM expected JOIN nine_store_order_history history ON history.store_key = expected.key AND history.source_table = expected.platform || '-orders'
      JOIN nine_store_order_snapshots snapshot ON snapshot.tenant_id = history.tenant_id AND history.archived_at <= snapshot.observed_at
      WHERE history.tenant_id = ? GROUP BY history.store_key`).bind(expected, user.tenantId),
  ]);
  const timestamp = now.valueOf();
  const nativeRows = native.results as NativeRow[];
  const snapshotByStore = new Map((snapshots.results as SnapshotRow[]).map(row => [row.store_key, row]));
  const archiveByStore = new Map((archives.results as ArchiveRow[]).map(row => [row.store_key, row]));

  return {
    checkedAt: now.toISOString(), nativeFreshMinutes, feishuFreshMinutes,
    stores: roster.map(({ key, platform, name, nativeKeys }) => {
      const snapshot = snapshotByStore.get(key);
      const archive = archiveByStore.get(key);
      const observedAt = verifiedTimestamp(snapshot?.observed_at ?? null, timestamp);
      return {
        key, platform, name,
        native: nativeCoverage(nativeRows.filter(row => row.platform === platform && nativeKeys.includes(row.connector_key)), timestamp),
        feishu: snapshot ? {
          orderCount: Number(snapshot.order_count), lineCount: Number(snapshot.line_count), observedAt,
          importedAt: verifiedTimestamp(snapshot.imported_at, timestamp), freshness: freshness(observedAt, timestamp, feishuFreshMinutes),
        } : null,
        archive: snapshot ? {
          orderCount: Number(archive?.order_count ?? 0), versionCount: Number(archive?.version_count ?? 0),
          lastArchivedAt: verifiedTimestamp(archive?.last_archived_at ?? null, timestamp),
        } : null,
        historicalCoverage: 'unverified' as const,
      };
    }),
  };
}

export type StoreCoverage = Awaited<ReturnType<typeof readStoreCoverage>>;
