import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from '../app/api/connectors/shopify/inventory-mirror/route';
import { handleShopifyInventoryMirrorJob } from '../app/api/connectors/shopify/inventory-mirror/run/route';
import { openSqliteD1 } from '../lib/aws/sqlite-d1';
import { resolveShopifyStoreConfig } from '../lib/connectors/shopify/config';
import { ShopifyConnectorError } from '../lib/connectors/shopify/errors';
import { readShopifyInventoryMirror, runShopifyInventoryMirror, shopifyMirrorWorkspace } from '../lib/connectors/shopify/inventory-mirror';
import * as auth from '../lib/db';
import { resolveMemberAccess, ROLE_PERMISSIONS } from '../lib/domain';
import { runShopifyInventoryMirrorJob } from '../scripts/run-shopify-inventory-mirror-job.mjs';

vi.mock('cloudflare:workers', () => ({ env: {} }));

const tenantId = shopifyMirrorWorkspace;
const externalTenant = 'mirror-other-tenant';
const storeKey = 'zimasya';
const ts = '2026-11-25T04:00:00.000Z';
const initial = new Date(ts);
const advanced = (minutes: number) => new Date(initial.valueOf() + minutes * 60_000);
const requestUrl = 'http://127.0.0.1:3000/api/connectors/shopify/inventory-mirror/run';
const config = resolveShopifyStoreConfig({
  SHOPIFY_ZIMASYA_SHOP_DOMAIN: 'fixture-zimasya.myshopify.com',
  SHOPIFY_ZIMASYA_ADMIN_ACCESS_TOKEN: 'fake-fixture-token',
}, storeKey);
const context = { id: 'gid://shopify/Shop/159', domain: config.domain, name: '验收独立站', currency: 'USD',
  timezone: 'America/Los_Angeles', timezoneOffset: '-0800', scopes: new Set(['read_orders', 'read_inventory']) };

const edges = <T>(nodes: T[]) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } });

function shopClient(options: { quantity?: number; missing?: boolean; ambiguous?: boolean; untracked?: boolean; failure?: boolean } = {}) {
  const skuQueries: string[] = [];
  let requestedSku = '';
  const client = {
    async graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
      if (query.includes('inventoryItems(')) {
        requestedSku = String(variables.query).slice(5, -1);
        skuQueries.push(requestedSku);
        if (options.failure) throw new ShopifyConnectorError('SHOPIFY_RATE_LIMITED', 'fixture rate limit', true);
        const item = { id: 'gid://shopify/InventoryItem/1159', sku: requestedSku, tracked: !options.untracked };
        return { inventoryItems: edges(options.missing ? [] : options.ambiguous ? [item, { ...item, id: 'gid://shopify/InventoryItem/1160' }] : [item]) } as T;
      }
      return { inventoryItem: { id: variables.id, sku: requestedSku, tracked: true,
        inventoryLevels: edges([{ isActive: true, updatedAt: ts,
          location: { id: 'gid://shopify/Location/333', name: '验收仓', isActive: true },
          quantities: [{ name: 'available', quantity: options.quantity ?? 12 }, { name: 'committed', quantity: 2 }],
        }]),
      } } as T;
    },
  };
  return { client, skuQueries };
}

describe('Shopify 库存只读镜像', () => {
  let sqlite: ReturnType<typeof openSqliteD1>;
  let db: D1Database;

  beforeEach(async () => {
    sqlite = openSqliteD1(':memory:', fileURLToPath(new URL('../drizzle', import.meta.url)));
    db = sqlite.db;
    await db.prepare('INSERT INTO tenants (id, name, created_at) VALUES (?, ?, ?), (?, ?, ?)')
      .bind(tenantId, '本店测试', ts, externalTenant, '其他公司', ts).run();
    await store('store-a', tenantId, 'shopify-zimasya', 159);
    await store('store-b', tenantId, 'kaguyasu', 182);
    await store('store-other', externalTenant, 'zimasya', 159);
  });

  afterEach(() => { vi.restoreAllMocks(); sqlite.close(); });

  async function store(id: string, tenant: string, key: string, officialId: number) {
    await db.prepare(`INSERT INTO platform_stores (id, tenant_id, platform, connector_key, display_name, official_store_id,
      api_version, credential_ref, identity_verified_at, created_at, updated_at)
      VALUES (?, ?, 'shopify', ?, '验收用户资料', ?, 'fixture', 'private-token-ref', ?, ?, ?)`)
      .bind(id, tenant, key, `gid://shopify/Shop/${officialId}`, ts, ts, ts).run();
  }

  async function order(sku: string, id: string, overrides: {
    tenant?: string; store?: string; test?: boolean; cancelledAt?: string; status?: string; at?: string; current?: boolean;
  } = {}) {
    const tenant = overrides.tenant ?? tenantId;
    await db.batch([
      db.prepare(`INSERT INTO platform_orders (id, tenant_id, platform_store_id, platform, source_order_id, test, source_cancelled_at,
        source_created_at, source_updated_at, fulfillment_status, api_version, raw_json, raw_hash, fetched_at, first_seen_at, last_seen_at)
        VALUES (?, ?, ?, 'shopify', ?, ?, ?, ?, ?, ?, 'fixture', '{"private":"customer"}', 'hash', ?, ?, ?)`)
        .bind(id, tenant, overrides.store ?? 'store-a', `source-${id}`, Number(overrides.test ?? false), overrides.cancelledAt ?? null,
          overrides.at ?? '2026-11-25T11:30:00+08:00', ts, overrides.status ?? 'UNFULFILLED', ts, ts, ts),
      db.prepare(`INSERT INTO platform_order_lines (id, tenant_id, order_id, source_order_line_id, raw_sku, ordered_quantity,
        raw_json, raw_hash, is_current, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, 1, '{}', 'hash', ?, ?, ?)`)
        .bind(`line-${id}`, tenant, id, `source-line-${id}`, sku, Number(overrides.current ?? true), ts, ts),
    ]);
  }

  function run(client = shopClient().client, options: { at?: Date; maxSkus?: number; shopId?: string } = {}) {
    return runShopifyInventoryMirror({ db, tenantId, storeKey, runtimeEnv: {}, requestUrl, maxSkus: options.maxSkus,
      now: () => options.at ?? initial, dependencies: { resolveConfig: async () => config,
        readShopContext: async () => ({ client, context: { ...context, id: options.shopId ?? context.id } }),
      },
    });
  }

  function read(sku: string, now = initial) { return readShopifyInventoryMirror({ db, tenantId, storeKey, sku, now }); }

  it('按现有订单范围独立轮转并保留大小写、不串店、不查测试单或旧行', async () => {
    for (const [sku, id] of [['A-SKU', 'a'], ['A-SKU', 'another-a'], ['Z-SKU', 'z'], ['a-sku', 'lower']]) await order(sku, id);
    await order('EXCLUDED-OTHER', 'outside', { tenant: externalTenant, store: 'store-other' });
    await order('EXCLUDED-SAME-COMPANY', 'outside-store', { store: 'store-b' });
    await order('EXCLUDED-TEST', 'test', { test: true });
    await order('EXCLUDED-CANCELLED', 'cancelled', { status: ' CANCELED ' });
    await order('EXCLUDED-CANCEL-TIME', 'cancel-date', { cancelledAt: ts });
    await order('EXCLUDED-OLD-LINE', 'old-line', { current: false });
    await order('EXCLUDED-OLD-ORDER', 'old-order', { at: '2026-10-20T00:00:00-08:00' });
    await order('EXCLUDED-FUTURE', 'future', { at: '2026-11-25T05:00:00.000Z' });
    await order(' BAD-SPACE ', 'spaces');
    const source = shopClient({ quantity: -2 });
    expect(await run(source.client, { maxSkus: 2 })).toMatchObject({ ok: true, lookedUp: 2, verified: 2, finishedCycle: false });
    expect(await run(source.client, { maxSkus: 2 })).toMatchObject({ ok: true, lookedUp: 1, finishedCycle: true });
    expect(source.skuQueries).toEqual(['A-SKU', 'Z-SKU', 'a-sku']);
    expect(await read('a-sku')).toMatchObject({ state: 'fresh', snapshot: { itemId: 'gid://shopify/InventoryItem/1159', sku: 'a-sku',
      levels: [{ available: -2, onHand: null, committed: 2, incoming: null, location: { id: 'gid://shopify/Location/333' } }],
    } });
    expect(await read('a-sku', advanced(91))).toMatchObject({ state: 'stale', observedAt: ts });
    expect(await readShopifyInventoryMirror({ db, tenantId: externalTenant, storeKey, sku: 'a-sku', now: initial }))
      .toMatchObject({ state: 'unavailable', snapshot: null });
    expect(await db.prepare('SELECT COUNT(*) AS count FROM skus').first('count')).toBe(0);
    expect(await db.prepare('SELECT COUNT(*) AS count FROM inventory_balances').first('count')).toBe(0);
    expect(await db.prepare('SELECT COUNT(*) AS count FROM inventory_movements').first('count')).toBe(0);
  });

  it('API 失败、多个精确匹配、缺失或未追踪均保留最近有效快照并标记不可用', async () => {
    await order('SKU-A', 'current');
    expect(await run()).toMatchObject({ verified: 1 });
    const old = (await read('SKU-A')).snapshot;
    await run(shopClient({ failure: true }).client, { at: advanced(1) });
    expect(await read('SKU-A', advanced(1))).toMatchObject({ state: 'stale', snapshot: old, observedAt: ts,
      lastErrorCode: 'SHOPIFY_RATE_LIMITED', reason: 'unavailable', job: { status: 'partial' } });
    for (const [reason, options] of [['ambiguous', { ambiguous: true }], ['not_found', { missing: true }], ['untracked', { untracked: true }]] as const) {
      await run(shopClient(options).client, { at: advanced(2) });
      expect(await read('SKU-A', advanced(2))).toMatchObject({ state: 'stale', snapshot: old, observedAt: ts, reason });
    }
    const mismatch = shopClient();
    expect(await run(mismatch.client, { shopId: 'gid://shopify/Shop/500' })).toMatchObject({ ok: false, code: 'SHOPIFY_IDENTITY_MISMATCH' });
    expect(mismatch.skuQueries).toEqual([]);
    expect(await read('SKU-A')).toMatchObject({ state: 'stale', snapshot: old, reason: 'source_unavailable' });
  });

  it('过时的 SQLite 统计信息下仍先按日期索引读取店铺订单，再查当前明细', async () => {
    await order('SKU-CURRENT', 'current');
    await order('SKU-OLDER', 'older', { at: '2025-01-02T00:00:00.000Z' });
    await db.prepare('ANALYZE').run();
    await db.prepare("UPDATE sqlite_stat1 SET stat = '800000 800000 400000' WHERE idx = 'idx_platform_orders_created'").run();
    await db.prepare("UPDATE sqlite_stat1 SET stat = '1 1 1' WHERE idx = 'idx_platform_order_lines_sku'").run();
    await db.prepare('ANALYZE sqlite_schema').run();
    const prepare = vi.spyOn(db, 'prepare');
    const source = shopClient();
    await run(source.client);
    expect(source.skuQueries).toEqual(['SKU-CURRENT']);
    const scan = prepare.mock.calls.find(([query]) => query.includes('SELECT DISTINCT line.raw_sku'))?.[0];
    expect(scan).toBeTruthy();
    const { results } = await db.prepare(`EXPLAIN QUERY PLAN ${scan}`)
      .bind(tenantId, 'store-a', '2026-10-25', '2026-11-27', '2026-10-26T04:00:00.000Z', ts, '', 5)
      .all<{ detail: string }>();
    const indexed = results.map(row => row.detail).filter(detail => detail.includes('USING INDEX'));
    expect(indexed[0]).toContain('SEARCH source USING INDEX idx_platform_orders_created (platform_store_id=? AND source_created_at>? AND source_created_at<?)');
    expect(indexed[1]).toContain('SEARCH line USING INDEX idx_platform_order_lines_order (order_id=? AND is_current=?)');
  });

  it('同店并发仅一份租约，过期旧执行无法覆盖新的库存快照', async () => {
    await order('SKU-A', 'current');
    let release!: () => void;
    let begin!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const claimed = new Promise<void>(resolve => { begin = resolve; });
    const client = shopClient({ quantity: 4 }).client;
    const late = runShopifyInventoryMirror({ db, tenantId, storeKey, runtimeEnv: {}, requestUrl, now: () => initial,
      dependencies: { resolveConfig: async () => config, readShopContext: async () => { begin(); await waiting; return { client, context }; } },
    });
    await claimed;
    try {
      expect(await run()).toMatchObject({ ok: false, code: 'SHOPIFY_MIRROR_BUSY' });
      expect(await run(shopClient({ quantity: 9 }).client, { at: advanced(9) })).toMatchObject({ ok: true, verified: 1 });
    } finally { release(); }
    expect(await late).toMatchObject({ ok: false, code: 'SHOPIFY_MIRROR_LEASE_LOST' });
    expect(await read('SKU-A', advanced(9))).toMatchObject({ snapshot: { levels: [{ available: 9 }] }, state: 'fresh' });
  });

  it('任务拒绝公网、代理请求和超限范围，镜像查询按已登录岗位授权', async () => {
    const token = 't'.repeat(48);
    const job = (url: string, requestHeaders: Record<string, string>, body: object) => handleShopifyInventoryMirrorJob(new Request(url, {
      method: 'POST', body: JSON.stringify(body), headers: requestHeaders,
    }), { DB: db, ERP_INTERNAL_JOB_TOKEN: token });
    const authorized = { Authorization: `Bearer ${token}` };
    expect((await job(requestUrl.replace('http://127.0.0.1:3000', 'https://erp.example.invalid'), authorized, { storeKey })).status).toBe(404);
    expect((await job(requestUrl, { ...authorized, 'X-Forwarded-For': '192.0.2.9' }, { storeKey })).status).toBe(404);
    expect((await job(requestUrl, {}, { storeKey })).status).toBe(401);
    expect((await job(requestUrl, authorized, { storeKey, maxSkus: 9 })).status).toBe(400);
    expect((await job(requestUrl, authorized, { storeKey, tenantId: externalTenant, sku: 'bad' })).status).toBe(400);
    expect(await (await job(requestUrl, authorized, { storeKey })).json()).toMatchObject({ ok: true, code: 'SHOPIFY_MIRROR_NO_SKUS_IN_BATCH' });

    await order('SKU-A', 'current');
    await run();
    const identity: auth.UserContext = { id: 'fixture-admin', email: 'admin@example.invalid', displayName: '验收', role: 'admin',
      permissions: ROLE_PERMISSIONS.admin, tenantId, tenantName: '验收公司' };
    const mock = vi.spyOn(auth, 'requestContext').mockResolvedValue({ db, user: identity });
    const readUrl = 'https://erp.example.invalid/api/connectors/shopify/inventory-mirror?storeKey=zimasya&sku=SKU-A';
    const response = await GET(new Request(readUrl));
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await response.json()).toMatchObject({ ok: true, snapshot: { sku: 'SKU-A' } });
    mock.mockResolvedValue({ db, user: { ...identity, ...resolveMemberAccess('viewer', 'amazon') } });
    expect((await GET(new Request(readUrl))).status).toBe(403);
    mock.mockResolvedValue({ db, user: { ...identity, ...resolveMemberAccess('viewer', 'shopify') } });
    expect((await GET(new Request(readUrl))).status).toBe(200);
  });

  it('运维任务仅用内部回环服务，日志只回报批次数量和安全状态', async () => {
    const token = 't'.repeat(48);
    const call = vi.fn(async (target: RequestInfo | URL, options?: RequestInit) => {
      expect(String(target)).toBe(requestUrl);
      expect(new Headers(options?.headers).get('Authorization')).toBe(`Bearer ${token}`);
      expect(JSON.parse(String(options?.body))).toEqual({ storeKey });
      return Response.json({ ok: false, storeKey, lookedUp: 2, verified: 1, unavailable: 1,
        code: 'SHOPIFY_MIRROR_PARTIAL', detail: 'untrusted content' }, { status: 207 });
    });
    expect(await runShopifyInventoryMirrorJob(storeKey, 'https://erp.example.invalid', token, call))
      .toMatchObject({ ok: false, code: 'SHOPIFY_MIRROR_JOB_CONFIGURATION_INVALID' });
    expect(call).not.toHaveBeenCalled();
    const summary = await runShopifyInventoryMirrorJob(storeKey, 'http://127.0.0.1:3000', token, call);
    expect(summary).toMatchObject({ ok: false, storeKey, lookedUp: 2, verified: 1, unavailable: 1, code: 'SHOPIFY_MIRROR_PARTIAL' });
    expect(JSON.stringify(summary)).not.toContain('untrusted content');
  });
});
