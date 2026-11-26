import { cancelledFulfillmentStatuses } from '../../channel-order-status';
import { HttpError } from '../../db';
import { ShopifyAdminClient } from './client';
import { hasShopifyCredentials, hasShopifyReadScope, shopifyDomainAccepted, type ShopifyCredentialConfig, type ShopifyStoreKey } from './config';
import { ShopifyOrderConnector } from './connector';
import { resolveShopifyRuntimeConfig } from './credential-store';
import { ShopifyConnectorError } from './errors';
import { lookupShopifyInventory, shopifyInventoryLookupSchema, type ShopifyInventoryItemValue } from './inventory-read';

export const shopifyMirrorWorkspace = 'tenant_yicang_primary';
export const shopifyMirrorDefaultBatchSize = 4;
export const shopifyMirrorMaximumBatchSize = 8;
export const shopifyMirrorLookbackDays = 30;
export const shopifyMirrorFreshMinutes = 90;
const leaseMs = 8 * 60_000;
const fetchDeadlineMs = 90_000;
const maximumSnapshotBytes = 64 * 1024;

type Store = { id: string; officialStoreId: string; verifiedAt: string };
type StoreStatus = 'running' | 'complete' | 'partial' | 'unavailable';
type EntryStatus = 'verified' | 'not_found' | 'ambiguous' | 'untracked' | 'unavailable';
type Entry = { sku: string; status: EntryStatus; checkedAt: string; snapshot: ShopifyInventoryItemValue | null; error: string | null };
type Target = { db: D1Database; tenantId: string; storeKey: ShopifyStoreKey };
type ScopedStore = { tenantId: string; store: Store };
type Lease = ScopedStore & { id: string };
type MirrorDependencies = {
  resolveConfig: typeof resolveShopifyRuntimeConfig;
  readShopContext: typeof readShopContext;
  lookupInventory: typeof lookupShopifyInventory;
};

async function readShopContext(config: ShopifyCredentialConfig, deadline: AbortSignal) {
  const scopedFetch: typeof fetch = (url, options) => globalThis.fetch(url, {
    ...options, signal: AbortSignal.any([deadline, AbortSignal.timeout(15_000)]),
  });
  const client = new ShopifyAdminClient(config, scopedFetch);
  const context = await new ShopifyOrderConnector(config, client).getShopContext();
  return { client: client as Pick<ShopifyAdminClient, 'graphql'>, context };
}

async function findStore({ db, tenantId, storeKey }: Target) {
  const { results } = await db.prepare(`
    SELECT id, official_store_id AS officialStoreId, identity_verified_at AS verifiedAt
    FROM platform_stores WHERE tenant_id = ? AND platform = 'shopify' AND active = 1
      AND connector_key IN (?, ?) LIMIT 2
  `).bind(tenantId, storeKey, `shopify-${storeKey}`).all<Store>();
  if (results.length > 1) throw new ShopifyConnectorError('SHOPIFY_MIRROR_STORE_AMBIGUOUS', '此 Shopify 店铺身份需要核对');
  const [store] = results;
  if (!store?.officialStoreId.match(/^gid:\/\/shopify\/Shop\/\d+$/u) || !Number.isFinite(Date.parse(store.verifiedAt))) return null;
  return store;
}

const leaseScope = `
  SELECT 1 FROM shopify_inventory_mirror_state state
  JOIN platform_stores store ON store.id = state.platform_store_id AND store.tenant_id = state.tenant_id
  WHERE state.tenant_id = ? AND state.platform_store_id = ? AND state.lease_id = ? AND state.lease_expires_at > ?
    AND store.platform = 'shopify' AND store.active = 1 AND store.official_store_id = ?`;

function leaseBindings(lease: Lease, now: string) {
  return [lease.tenantId, lease.store.id, lease.id, now, lease.store.officialStoreId];
}

async function claimLease(db: D1Database, lease: Lease, now: Date) {
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.valueOf() + leaseMs).toISOString();
  const result = await db.prepare(`
    INSERT INTO shopify_inventory_mirror_state (tenant_id, platform_store_id, status, lease_id, lease_expires_at, last_attempted_at)
    SELECT store.tenant_id, store.id, 'running', ?, ?, ? FROM platform_stores store
    WHERE store.id = ? AND store.tenant_id = ? AND store.platform = 'shopify' AND store.active = 1 AND store.official_store_id = ?
    ON CONFLICT (tenant_id, platform_store_id) DO UPDATE SET
      status = 'running', lease_id = excluded.lease_id, lease_expires_at = excluded.lease_expires_at,
      last_attempted_at = excluded.last_attempted_at
    WHERE shopify_inventory_mirror_state.lease_id IS NULL OR shopify_inventory_mirror_state.lease_expires_at <= excluded.last_attempted_at
  `).bind(lease.id, expiresAt, nowIso, lease.store.id, lease.tenantId, lease.store.officialStoreId).run();
  return Number(result.meta.changes) === 1;
}

async function nextSkuBatch(db: D1Database, scope: ScopedStore, storeKey: ShopifyStoreKey, now: Date, limit: number) {
  const { tenantId, store } = scope;
  const cursor = await db.prepare(`SELECT cursor_sku FROM shopify_inventory_mirror_state WHERE tenant_id = ? AND platform_store_id = ?`)
    .bind(tenantId, store.id).first<string>('cursor_sku');
  const dayMs = 86_400_000;
  const cutoffMs = now.valueOf() - shopifyMirrorLookbackDays * dayMs;
  const cutoff = new Date(cutoffMs).toISOString();
  // Use the indexed date prefix as a loose bound, then check the exact instant for source offsets.
  const startDay = new Date(cutoffMs - dayMs).toISOString().slice(0, 10);
  const endDay = new Date(now.valueOf() + 2 * dayMs).toISOString().slice(0, 10);
  const cancelled = cancelledFulfillmentStatuses.map(status => `'${status}'`).join(', ');
  const { results } = await db.prepare(`
    SELECT DISTINCT line.raw_sku COLLATE BINARY AS sku
    FROM platform_orders source INDEXED BY idx_platform_orders_created
    CROSS JOIN platform_order_lines line INDEXED BY idx_platform_order_lines_order
    WHERE source.tenant_id = ? AND source.platform_store_id = ? AND source.platform = 'shopify'
      AND source.source_created_at >= ? AND source.source_created_at < ?
      AND julianday(source.source_created_at) BETWEEN julianday(?) AND julianday(?) AND COALESCE(source.test, 0) = 0
      AND NULLIF(TRIM(source.source_cancelled_at), '') IS NULL
      AND UPPER(TRIM(COALESCE(source.fulfillment_status, ''))) NOT IN (${cancelled})
      AND line.tenant_id = source.tenant_id AND line.order_id = source.id AND line.is_current = 1
      AND length(line.raw_sku) BETWEEN 1 AND 160
      AND line.raw_sku = TRIM(line.raw_sku) AND line.raw_sku COLLATE BINARY > ?
    ORDER BY sku COLLATE BINARY LIMIT ?
  `).bind(tenantId, store.id, startDay, endDay, cutoff, now.toISOString(), cursor ?? '', limit + 1).all<{ sku: string }>();
  const candidates = results.slice(0, limit);
  return {
    skus: candidates.map(({ sku }) => sku).filter(sku => {
      const parsed = shopifyInventoryLookupSchema.safeParse({ storeKey, sku });
      return parsed.success && parsed.data.sku === sku;
    }),
    previousCursor: cursor,
    cursor: results.length > limit ? candidates.at(-1)?.sku ?? null : null,
    finishedCycle: results.length <= limit,
  };
}

function safeCode(error: unknown) {
  return error instanceof ShopifyConnectorError && /^SHOPIFY_[A-Z0-9_]{1,80}$/u.test(error.code)
    ? error.code : 'SHOPIFY_MIRROR_SOURCE_UNAVAILABLE';
}

async function verifyShop({ db, tenantId, storeKey }: Target, store: Store, config: ShopifyCredentialConfig, context: Awaited<ReturnType<typeof readShopContext>>['context']) {
  const credentialStoreId = await db.prepare(`
    SELECT official_store_id FROM connector_credentials WHERE tenant_id = ? AND platform = 'shopify' AND store_key = ?
  `).bind(tenantId, storeKey).first<string>('official_store_id');
  if (context.id !== store.officialStoreId || !shopifyDomainAccepted(config, context.domain) || (credentialStoreId && credentialStoreId !== context.id)) {
    throw new ShopifyConnectorError('SHOPIFY_IDENTITY_MISMATCH', 'Shopify 返回的店铺身份与易仓已有记录不一致');
  }
  if (!hasShopifyReadScope(context.scopes, 'read_inventory')) {
    throw new ShopifyConnectorError('SHOPIFY_READ_INVENTORY_SCOPE_MISSING', '该店铺尚未授权读取 Shopify 库存');
  }
}

async function readSku(sku: string, dependencies: MirrorDependencies, shop: Awaited<ReturnType<typeof readShopContext>>, now: () => Date): Promise<Entry> {
  try {
    const items = await dependencies.lookupInventory({ ...shop, sku });
    const [item] = items;
    const status = items.length > 1 ? 'ambiguous' : !item ? 'not_found' : !item.tracked ? 'untracked' : 'verified';
    if (status === 'verified' && new TextEncoder().encode(JSON.stringify(item)).byteLength > maximumSnapshotBytes) {
      throw new ShopifyConnectorError('SHOPIFY_MIRROR_SNAPSHOT_TOO_LARGE', '商品的库存地点超出本次可存储范围');
    }
    return { sku, status, checkedAt: now().toISOString(), snapshot: status === 'verified' ? item : null, error: null };
  } catch (error) {
    return { sku, status: 'unavailable', checkedAt: now().toISOString(), snapshot: null, error: safeCode(error) };
  }
}

function saveEntry(db: D1Database, lease: Lease, entry: Entry, now: string) {
  const observedAt = entry.snapshot ? entry.checkedAt : null;
  const snapshot = entry.snapshot ? JSON.stringify(entry.snapshot) : null;
  return db.prepare(`
    INSERT INTO shopify_inventory_mirror_entries (tenant_id, platform_store_id, sku, status, observed_at, snapshot_json, last_checked_at, last_error_code)
    SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (${leaseScope})
    ON CONFLICT (tenant_id, platform_store_id, sku) DO UPDATE SET
      status = excluded.status,
      observed_at = COALESCE(excluded.observed_at, shopify_inventory_mirror_entries.observed_at),
      snapshot_json = COALESCE(excluded.snapshot_json, shopify_inventory_mirror_entries.snapshot_json),
      last_checked_at = excluded.last_checked_at, last_error_code = excluded.last_error_code
    WHERE shopify_inventory_mirror_entries.last_checked_at <= excluded.last_checked_at
  `).bind(lease.tenantId, lease.store.id, entry.sku, entry.status, observedAt, snapshot, entry.checkedAt, entry.error,
    ...leaseBindings(lease, now));
}

export async function runShopifyInventoryMirror(input: Target & {
  runtimeEnv: Record<string, unknown>; requestUrl: string; maxSkus?: number; now?: () => Date; dependencies?: Partial<MirrorDependencies>;
}) {
  const { db, tenantId, storeKey, runtimeEnv, now = () => new Date(), maxSkus = shopifyMirrorDefaultBatchSize } = input;
  if (!Number.isInteger(maxSkus) || maxSkus < 1 || maxSkus > shopifyMirrorMaximumBatchSize) {
    throw new HttpError(400, 'Shopify 库存镜像批量参数无效', 'SHOPIFY_MIRROR_BATCH_INVALID');
  }
  const store = await findStore(input);
  const base = { storeKey, lookedUp: 0, verified: 0, notFound: 0, ambiguous: 0, untracked: 0, unavailable: 0, finishedCycle: false };
  if (!store) return { ok: false, ...base, code: 'SHOPIFY_MIRROR_STORE_UNVERIFIED' };
  const lease = { tenantId, store, id: crypto.randomUUID() };
  const started = now();
  if (!await claimLease(db, lease, started)) return { ok: false, ...base, code: 'SHOPIFY_MIRROR_BUSY' };

  const dependencies: MirrorDependencies = { resolveConfig: resolveShopifyRuntimeConfig, readShopContext, lookupInventory: lookupShopifyInventory, ...input.dependencies };
  try {
    const batch = await nextSkuBatch(db, lease, storeKey, started, maxSkus);
    const entries: Entry[] = [];
    let timedOut = false;
    if (batch.skus.length) {
      const deadline = AbortSignal.timeout(fetchDeadlineMs);
      const config = await dependencies.resolveConfig({ db, tenantId, runtimeEnv, storeKey, requestUrl: input.requestUrl });
      if (!hasShopifyCredentials(config)) throw new ShopifyConnectorError('SHOPIFY_AUTHORIZATION_REQUIRED', '该 Shopify 店铺尚未完成授权');
      const shop = await dependencies.readShopContext(config, deadline);
      await verifyShop(input, store, config, shop.context);
      for (const sku of batch.skus) {
        if (deadline.aborted) { timedOut = true; break; }
        entries.push(await readSku(sku, dependencies, shop, now));
      }
    }
    const completed = now().toISOString();
    const status = timedOut || entries.some(entry => entry.status === 'unavailable') ? 'partial' : 'complete';
    const cursor = timedOut ? entries.at(-1)?.sku ?? batch.previousCursor : batch.cursor;
    const errorCode = timedOut ? 'SHOPIFY_MIRROR_DEADLINE' : entries.find(entry => entry.error)?.error ?? null;
    const results = await db.batch([
      ...entries.map(entry => saveEntry(db, lease, entry, completed)),
      db.prepare(`UPDATE shopify_inventory_mirror_state SET status = ?, cursor_sku = ?, lease_id = NULL,
        lease_expires_at = NULL, last_completed_at = ?, last_error_code = ?
        WHERE tenant_id = ? AND platform_store_id = ? AND EXISTS (${leaseScope})`)
        .bind(status, cursor, completed, errorCode,
          tenantId, store.id, ...leaseBindings(lease, completed)),
    ]);
    if (Number(results.at(-1)?.meta.changes) !== 1) return { ok: false, ...base, code: 'SHOPIFY_MIRROR_LEASE_LOST' };
    return {
      ...base, ok: status === 'complete', lookedUp: entries.length, finishedCycle: !timedOut && batch.finishedCycle,
      verified: entries.filter(entry => entry.status === 'verified').length,
      notFound: entries.filter(entry => entry.status === 'not_found').length,
      ambiguous: entries.filter(entry => entry.status === 'ambiguous').length,
      untracked: entries.filter(entry => entry.status === 'untracked').length,
      unavailable: entries.filter(entry => entry.status === 'unavailable').length,
      code: timedOut ? 'SHOPIFY_MIRROR_DEADLINE' : status === 'partial' ? 'SHOPIFY_MIRROR_PARTIAL'
        : entries.length ? null : 'SHOPIFY_MIRROR_NO_SKUS_IN_BATCH',
    };
  } catch (error) {
    const code = safeCode(error);
    const finished = now().toISOString();
    await db.prepare(`UPDATE shopify_inventory_mirror_state SET status = 'unavailable', lease_id = NULL,
      lease_expires_at = NULL, last_error_code = ? WHERE tenant_id = ? AND platform_store_id = ? AND EXISTS (${leaseScope})`)
      .bind(code, tenantId, store.id, ...leaseBindings(lease, finished)).run();
    return { ok: false, ...base, code };
  }
}

type StoredEntry = { status: EntryStatus; observed_at: string | null; snapshot_json: string | null; last_checked_at: string; last_error_code: string | null };
type StoredState = { status: StoreStatus; last_attempted_at: string; last_completed_at: string | null; last_error_code: string | null };

export async function readShopifyInventoryMirror(input: Target & { sku: string; now?: Date }) {
  const store = await findStore(input);
  const base = { storeKey: input.storeKey, sku: input.sku, maxAgeMinutes: shopifyMirrorFreshMinutes };
  if (!store) return { ...base, state: 'unavailable' as const, reason: 'store_unverified' as const, snapshot: null, observedAt: null, job: null };
  const [entries, states] = await input.db.batch<StoredEntry | StoredState>([
    input.db.prepare(`SELECT status, observed_at, snapshot_json, last_checked_at, last_error_code FROM shopify_inventory_mirror_entries
      WHERE tenant_id = ? AND platform_store_id = ? AND sku = ?`).bind(input.tenantId, store.id, input.sku),
    input.db.prepare(`SELECT status, last_attempted_at, last_completed_at, last_error_code FROM shopify_inventory_mirror_state
      WHERE tenant_id = ? AND platform_store_id = ?`).bind(input.tenantId, store.id),
  ]);
  const entry = entries.results[0] as StoredEntry | undefined;
  const state = states.results[0] as StoredState | undefined;
  const observedAt = entry?.observed_at ?? null;
  const age = observedAt ? (input.now ?? new Date()).valueOf() - Date.parse(observedAt) : Infinity;
  const fresh = state?.status !== 'unavailable' && entry?.status === 'verified' && age >= 0 && age <= shopifyMirrorFreshMinutes * 60_000;
  return {
    ...base, state: fresh ? 'fresh' as const : observedAt ? 'stale' as const : 'unavailable' as const,
    reason: state?.status === 'unavailable' ? 'source_unavailable' as const : entry?.status ?? 'not_observed' as const,
    snapshot: entry?.snapshot_json ? JSON.parse(entry.snapshot_json) as ShopifyInventoryItemValue : null,
    observedAt, lastCheckedAt: entry?.last_checked_at ?? null, lastErrorCode: entry?.last_error_code ?? null,
    job: state ? { status: state.status, lastAttemptedAt: state.last_attempted_at,
      lastCompletedAt: state.last_completed_at, lastErrorCode: state.last_error_code } : null,
  };
}
