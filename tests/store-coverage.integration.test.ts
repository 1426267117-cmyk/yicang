import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from '../app/api/channel-orders/coverage/route';
import { openSqliteD1 } from '../lib/aws/sqlite-d1';
import * as runtime from '../lib/db';
import { resolveMemberAccess, ROLE_PERMISSIONS } from '../lib/domain';
import { nineStoreOrderSnapshotSchema, nineStoreRoster, orderFeedTableKinds, type NineStoreOrderSnapshot } from '../lib/nine-store-orders-contract';
import { storeNineStoreOrderSnapshot } from '../lib/nine-store-orders-service';
import { readStoreCoverage } from '../lib/store-coverage';

vi.mock('cloudflare:workers', () => ({ env: {} }));

const operator: runtime.UserContext = {
  id: 'coverage-user', email: 'coverage@example.invalid', displayName: '测试', role: 'operator',
  permissions: ROLE_PERMISSIONS.operator, tenantId: 'guangzhou', tenantName: '广州',
};
const otherTenant = { ...operator, tenantId: 'shenzhen', tenantName: '深圳' };
const now = new Date('2026-11-25T12:00:00.000Z');
const old = '2026-11-25T11:20:00.000Z';
const recent = '2026-11-25T11:50:00.000Z';
const imported = '2026-11-25T12:00:00.000Z';

function snapshot(observedAt: string, revision: string, orders: NineStoreOrderSnapshot['orders']) {
  const stores = nineStoreRoster.map(([key, platform]) => ({ key, platform, name: `源 ${key}` }));
  const tables = orderFeedTableKinds.map(kind => {
    const accepted = orders.filter(row => kind === `${row.storeKey.split('-')[0]}-orders`).length;
    return { kind, revision, read: accepted, accepted, outsideScope: 0, invalid: 0 };
  });
  return nineStoreOrderSnapshotSchema.parse({ version: 1, source: 'feishu-order-base', observedAt, stores, tables, orders, refunds: [] });
}

function sourceLine(recordId: string, storeKey: string, orderNo: string): NineStoreOrderSnapshot['orders'][number] {
  return { recordId, storeKey, orderNo, sku: 'PRIVATE-SKU-FIXTURE', orderDate: '2026-11-25', quantity: 1, fulfillment: 'pending' };
}

describe('店铺订单数据覆盖', () => {
  let connection: ReturnType<typeof openSqliteD1>;

  beforeEach(async () => {
    connection = openSqliteD1(':memory:', fileURLToPath(new URL('../drizzle/', import.meta.url)));
    await connection.db.prepare('INSERT INTO tenants (id, name, created_at) VALUES (?, ?, ?), (?, ?, ?)')
      .bind(operator.tenantId, operator.tenantName, old, otherTenant.tenantId, otherTenant.tenantName, old).run();
  });
  afterEach(() => { vi.restoreAllMocks(); connection.close(); });

  async function addStore(id: string, platform: string, key: string, lastSync: string | null, tenant = operator.tenantId) {
    await connection.db.prepare(`INSERT INTO platform_stores (id, tenant_id, platform, connector_key, display_name, official_store_id,
      api_version, credential_ref, identity_verified_at, active, last_successful_sync_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'Kaguyasu', ?, 'fixture', 'PRIVATE-CONFIG-REF', ?, 1, ?, ?, ?)`)
      .bind(id, tenant, platform, key, `PRIVATE-STORE-${id}`, old, lastSync, old, old).run();
  }

  async function addOrder(id: string, store: string, platform: string, test = 0, tenant = operator.tenantId) {
    await connection.db.prepare(`INSERT INTO platform_orders (id, tenant_id, platform_store_id, platform, source_order_id,
      source_created_at, source_updated_at, test, api_version, raw_json, raw_hash, fetched_at, first_seen_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'fixture', '{"secret":"PRIVATE-RAW-ORDER"}', 'hash', ?, ?, ?)`)
      .bind(id, tenant, store, platform, `PRIVATE-ORDER-${id}`, old, recent, test, recent, recent, recent).run();
  }

  it('九店各按平台和稳定键统计，Shopify 别名匹配，同名店不合并', async () => {
    const { db } = connection;
    await addStore('amazon-kaguyasu', 'amazon', 'amazon-kaguyasu', old);
    await addStore('shopify-kaguyasu', 'shopify', 'kaguyasu', recent);
    await addStore('shopify-unassigned', 'shopify', 'other-kaguyasu', recent);
    await addStore('external-amz', 'amazon', 'amazon-kaguyasu', recent, otherTenant.tenantId);
    await addOrder('amz-1', 'amazon-kaguyasu', 'amazon');
    await addOrder('shop-1', 'shopify-kaguyasu', 'shopify');
    await addOrder('shop-2', 'shopify-kaguyasu', 'shopify');
    await addOrder('shop-test', 'shopify-kaguyasu', 'shopify', 1);
    await addOrder('unassigned', 'shopify-unassigned', 'shopify');
    await addOrder('external', 'external-amz', 'amazon', 0, otherTenant.tenantId);
    // A wrong-tenant relation is excluded even if legacy rows reference the current store ID.
    await addOrder('cross-tenant', 'amazon-kaguyasu', 'amazon', 0, otherTenant.tenantId);

    const result = await readStoreCoverage(db, operator, now);
    expect(result.stores.map(({ key, platform }) => [key, platform])).toEqual(nineStoreRoster);
    expect(result.stores.find(row => row.key === 'amazon-kaguyasu')).toMatchObject({
      name: 'Kaguyasu', native: { orderCount: 1, lastSuccessfulSyncAt: old, lastOrderFetchedAt: recent, freshness: 'stale' },
    });
    expect(result.stores.find(row => row.key === 'shopify-kaguyasu')).toMatchObject({
      name: 'Kaguyasu', native: { orderCount: 2, lastSuccessfulSyncAt: recent, freshness: 'recent' },
    });
    expect(result.stores.find(row => row.key === 'wayfair-linhe')).toMatchObject({
      historicalCoverage: 'unverified', native: { state: 'pending', orderCount: null, freshness: 'unknown' }, feishu: null, archive: null,
    });
    expect(JSON.stringify(result)).not.toContain('PRIVATE-');

    await addStore('shopify-alias-conflict', 'shopify', 'shopify-kaguyasu', recent);
    const conflicted = await readStoreCoverage(db, operator, now);
    expect(conflicted.stores.find(row => row.key === 'shopify-kaguyasu')?.native).toMatchObject({ state: 'ambiguous', orderCount: null });
  });

  it('区分当前批次和归档，按来源去重，显示真实零值和过期资料', async () => {
    const { db } = connection;
    const first = sourceLine('recFixture001', 'amazon-kaguyasu', 'EXAMPLE-ORDER-1');
    const second = sourceLine('recFixture002', 'amazon-kaguyasu', 'example-order-1');
    const third = sourceLine('recFixture003', 'shopify-kaguyasu', 'EXAMPLE-ORDER-1');
    await storeNineStoreOrderSnapshot(db, operator.tenantId, snapshot('2026-11-25T11:10:00Z', '1', [first, second, third]), now);
    const changed = { ...first, fulfillment: 'shipped' as const };
    await storeNineStoreOrderSnapshot(db, operator.tenantId, snapshot(old, '2', [changed, third]), now);
    await storeNineStoreOrderSnapshot(db, otherTenant.tenantId, snapshot(recent, '3', [sourceLine('recExternal001', 'wayfair-linhe', 'OUTSIDE-A')]), now);
    const result = await readStoreCoverage(db, operator, now);
    expect(result.stores.find(row => row.key === 'amazon-kaguyasu')).toMatchObject({
      native: { orderCount: null }, feishu: { orderCount: 1, lineCount: 1, freshness: 'stale', observedAt: old, importedAt: imported },
      archive: { orderCount: 1, versionCount: 2, lastArchivedAt: old },
    });
    expect(result.stores.find(row => row.key === 'shopify-kaguyasu')).toMatchObject({
      feishu: { orderCount: 1, lineCount: 1 }, archive: { orderCount: 0, versionCount: 0, lastArchivedAt: null },
    });
    expect(result.stores.find(row => row.key === 'wayfair-linhe')).toMatchObject({ feishu: { orderCount: 0, lineCount: 0 } });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE-|EXAMPLE-ORDER|OUTSIDE-/u);
    expect((await readStoreCoverage(db, otherTenant, now)).stores.find(row => row.key === 'wayfair-linhe'))
      .toMatchObject({ feishu: { orderCount: 1, observedAt: recent, freshness: 'recent' } });
  });

  it('渠道员工只能读所属平台，其他岗位拒绝访问，接口禁用缓存', async () => {
    const { db } = connection;
    const request = new Request('http://localhost/api/channel-orders/coverage');
    const shopify = { ...operator, ...resolveMemberAccess('viewer', 'shopify') };
    vi.spyOn(runtime, 'requestContext').mockResolvedValue({ db, user: shopify });
    const response = await GET(request);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    const payload = await response.json() as { stores: { platform: string }[] };
    expect(payload.stores.map(store => store.platform)).toEqual(['shopify', 'shopify', 'shopify', 'shopify']);

    vi.mocked(runtime.requestContext).mockResolvedValue({ db, user: { ...operator, ...resolveMemberAccess('viewer', 'finance') } });
    expect((await GET(request)).status).toBe(403);
  });
});
