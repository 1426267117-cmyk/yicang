import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET as readBootstrap } from '../app/api/erp/route';
import { GET as readOrders } from '../app/api/orders/route';
import { GET as readShopifyConnection } from '../app/api/connectors/shopify/status/route';
import { GET as readLogistics } from '../app/api/logistics/route';
import { GET as readHandoff, POST as createHandoff } from '../app/api/nine-store-orders/handoff/route';
import { POST as importOrders } from '../app/api/nine-store-orders/import/route';
import { GET as readOrdersFeed } from '../app/api/nine-store-orders/route';
import { GET as readRecipient } from '../app/api/warehouse/outbound/[id]/route';
import { GET as readWarehouse } from '../app/api/warehouse/workspace/route';
import { openSqliteD1 } from '../lib/aws/sqlite-d1';
import type { UserContext } from '../lib/db';
import { resolveMemberAccess, ROLE_PERMISSIONS } from '../lib/domain';
import { nineStoreOrderQuerySchema, nineStoreOrderSnapshotSchema, nineStoreRoster, type NineStoreOrderResponse } from '../lib/nine-store-orders-contract';
import { readNineStoreOrders, storeNineStoreOrderSnapshot } from '../lib/nine-store-orders-service';

const { requestContext, runtime } = vi.hoisted(() => ({ requestContext: vi.fn(), runtime: {} as Record<string, unknown> }));
vi.mock('cloudflare:workers', () => ({ env: runtime }));
vi.mock('../lib/db', async (original) => ({ ...await original<typeof import('../lib/db')>(), requestContext }));

const migrations = fileURLToPath(new URL('../drizzle/', import.meta.url));
let connection: ReturnType<typeof openSqliteD1>;
const time = new Date('2026-11-25T06:00:00.000Z');

function user(tenantId: string): UserContext {
  return { id: 'test-member', email: 'operator@example.test', displayName: 'Test', role: 'operator',
    permissions: ROLE_PERMISSIONS.operator, tenantId, tenantName: tenantId };
}

const stores = nineStoreRoster.map(([key, platform], index) => ({ key, platform, name: `测试店 ${index + 1}` }));

function snapshot(observedAt = '2026-11-25T05:50:00.000Z', revision = '23') {
  return {
    version: 1, source: 'feishu-order-base', observedAt, stores,
    tables: [['amazon-orders', 4], ['shopify-orders', 4], ['wayfair-orders', 1], ['refunds', 1]].map(([kind, accepted]) => ({
      kind, revision, read: accepted, accepted, outsideScope: 0, invalid: 0,
    })),
    orders: stores.map((entry, index) => ({ recordId: `rectest${index}`, storeKey: entry.key, orderNo: 'ORDER-TEST-01',
      sku: 'SAFE-SKU', orderDate: index === 0 ? '2026-11-28' : '2026-11-24',
      quantity: index === 0 ? null : 2, fulfillment: index === 0 ? null : 'shipped' })),
    refunds: [{ recordId: 'rectestrefund', storeKey: stores[0].key, orderNo: 'ORDER-TEST-01', sku: 'SAFE-SKU', refundDate: '2026-11-25' }],
  };
}

beforeEach(async () => {
  requestContext.mockReset();
  for (const key of Object.keys(runtime)) delete runtime[key];
  connection = openSqliteD1(':memory:', migrations);
  for (const tenant of ['guangzhou-test', 'shenzhen-test']) {
    await connection.db.prepare('INSERT INTO tenants (id, name, created_at) VALUES (?, ?, ?)').bind(tenant, tenant, time.toISOString()).run();
  }
});
afterEach(() => connection.close());

describe('九店订单来源快照', () => {
  it.each(['amazon', 'wayfair', 'shopify'] as const)('仅允许 %s 岗位读取本平台及本工作区的订单与退款', async (platform) => {
    const { db } = connection;
    const tenantId = 'guangzhou-test';
    const initial = nineStoreOrderSnapshotSchema.parse(snapshot());
    const inScope = stores.filter((store) => store.platform === platform);
    const outOfScope = stores.find((store) => store.platform !== platform)!;
    const first = inScope[0];
    const scopedRefund = { ...initial.refunds[0], recordId: 'recscopedrefund', storeKey: first.key, orderNo: 'SCOPED-REFUND' };
    const otherRefund = { ...scopedRefund, recordId: 'recotherrefund', storeKey: outOfScope.key, orderNo: 'PRIVATE-OTHER-REFUND' };
    const previous = { ...initial, refunds: [scopedRefund, otherRefund] };
    await storeNineStoreOrderSnapshot(db, tenantId, previous, time);
    await storeNineStoreOrderSnapshot(db, tenantId, {
      ...previous, observedAt: '2026-11-25T05:55:00.000Z', refunds: [scopedRefund],
      orders: previous.orders.map((row) => ({ ...row, quantity: 3 })),
    }, time);
    await storeNineStoreOrderSnapshot(db, 'shenzhen-test', { ...previous, orders: previous.orders.map((row) => ({ ...row, orderNo: 'SHENZHEN-PRIVATE' })) }, time);
    requestContext.mockResolvedValue({ db, user: { ...user(tenantId), accessProfile: platform, ...resolveMemberAccess('operator', platform) } });
    const request = (path: string) => new Request(`https://erp.example.test${path}`);
    const readFeed = async (filters = '') => {
      const response = await readOrdersFeed(request(`/api/nine-store-orders${filters}`));
      expect(response.status).toBe(200);
      return await response.json() as NineStoreOrderResponse;
    };
    const current = await readFeed();
    expect(current).toMatchObject({ total: inScope.length, snapshot: { stores: expect.arrayContaining(inScope.map((store) => expect.objectContaining(store))), tables: [] },
      rows: expect.arrayContaining(inScope.map(({ key }) => expect.objectContaining({ storeKey: key, quantity: 3 }))) });
    expect(current.snapshot?.stores).toHaveLength(inScope.length);
    expect(await readFeed('?search=SHENZHEN-PRIVATE')).toMatchObject({ total: 0, rows: [] });
    expect(await readFeed('?scope=history')).toMatchObject({ total: inScope.length,
      rows: expect.arrayContaining(inScope.map(({ key }) => expect.objectContaining({ storeKey: key }))) });
    expect(await readFeed('?section=refunds')).toMatchObject({ total: 1, rows: [{ orderNo: 'SCOPED-REFUND' }] });
    expect(await readFeed('?section=refunds&scope=history')).toMatchObject({ total: 0, rows: [] });
    expect(await readFeed(`?store=${first.key}`)).toMatchObject({ total: 1 });
    const wrongStore = await readOrdersFeed(request(`/api/nine-store-orders?store=${outOfScope.key}&scope=history`));
    expect(wrongStore.status).toBe(403);
    expect(await wrongStore.json()).toMatchObject({ code: 'CHANNEL_SCOPE_DENIED' });
    const forbiddenRoutes = await Promise.all([
      readOrders(request('/api/orders')), readShopifyConnection(request('/api/connectors/shopify/status')),
      readLogistics(request('/api/logistics?view=platform')), readWarehouse(request('/api/warehouse/workspace')),
      readHandoff(request(`/api/nine-store-orders/handoff?store=${first.key}&orderNo=ORDER-TEST-01`)),
      readRecipient(request('/api/warehouse/outbound/private-order'), { params: Promise.resolve({ id: 'private-order' }) }),
    ]);
    expect(forbiddenRoutes.map((response) => response.status)).toEqual([403, 403, 403, 403, 403, 403]);
  });

  it('只汇总本平台 API 订单，待授权岗位不查询业务表', async () => {
    const { db } = connection;
    const tenantId = 'guangzhou-test';
    const at = time.toISOString();
    for (const [tenant, storePlatform] of [[tenantId, 'amazon'], [tenantId, 'shopify'], ['shenzhen-test', 'amazon']]) {
      const id = `${tenant}-${storePlatform}`;
      await db.prepare(`INSERT INTO platform_stores (id, tenant_id, platform, connector_key, display_name,
        official_store_id, api_version, credential_ref, identity_verified_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'test', 'test', ?, ?, ?)`).bind(id, tenant, storePlatform, id, id, id, at, at, at).run();
      await db.prepare(`INSERT INTO platform_orders (id, tenant_id, platform_store_id, platform, source_order_id,
        source_created_at, source_updated_at, financial_status, api_version, raw_json, raw_hash, fetched_at, first_seen_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', 'test', '{}', 'test', ?, ?, ?)`).bind(id, tenant, id, storePlatform, id, at, at, at, at, at).run();
    }
    const request = new Request('https://erp.example.test/api/erp');
    requestContext.mockResolvedValue({ db, user: { ...user(tenantId), authProvider: 'feishu', accessProfile: 'amazon', ...resolveMemberAccess('operator', 'amazon') } });
    const amazon = await readBootstrap(request);
    expect(amazon.status).toBe(200);
    expect(await amazon.json()).toMatchObject({
      user: { authProvider: 'feishu', channelScope: 'amazon', permissions: ['channels:read'] },
      orders: [], inventory: [], audit: [], platformOrders: [{ id: `${tenantId}-amazon`, platform: 'amazon' }],
      summary: { totalOrders: 0, totalPlatformOrders: 1, platformPending: 1 },
    });
    const prepare = vi.fn();
    requestContext.mockResolvedValue({ db: { prepare }, user: { ...user(tenantId), accessProfile: 'pending', ...resolveMemberAccess('viewer', 'pending') } });
    const pending = await readBootstrap(request);
    expect(pending.status).toBe(200);
    expect(prepare).not.toHaveBeenCalled();
    expect(await pending.json()).toMatchObject({
      user: { accessProfile: 'pending', channelScope: null, permissions: [] },
      orders: [], inventory: [], audit: [], platformOrders: [], summary: { totalOrders: 0, totalPlatformOrders: 0 },
    });
  });

  it('管理员按工作区导入可追溯的期初订单，重复文件无重复记录，归档不生成运营单', async () => {
    const tenantId = 'guangzhou-test';
    const { db } = connection;
    const operator = user(tenantId);
    const administrator: UserContext = { ...operator, id: 'opening-admin', role: 'admin', permissions: ROLE_PERMISSIONS.admin };
    const origin = 'https://erp.example.test';
    const submit = (body: unknown, source = origin) => importOrders(new Request(`${origin}/api/nine-store-orders/import`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: source }, body: JSON.stringify(body),
    }));
    requestContext.mockResolvedValue({ db, user: operator });
    expect((await submit(snapshot())).status).toBe(403);
    requestContext.mockResolvedValue({ db, user: administrator });
    expect((await submit(snapshot(), 'https://outside.example.test')).status).toBe(403);
    const imported = await submit(snapshot());
    expect(imported.status).toBe(201);
    expect(imported.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await imported.json()).toMatchObject({ ok: true, observedAt: '2026-11-25T05:50:00.000Z', replayed: false });
    expect((await submit(snapshot())).status).toBe(200);
    expect((await submit(snapshot('2026-11-25T05:55:00.000Z', '22'))).status).toBe(409);

    const audits = await db.prepare('SELECT actor_id, tenant_id, action, after_json FROM audit_logs').all();
    expect(audits.results).toEqual([{
      actor_id: administrator.id, tenant_id: tenantId, action: 'IMPORT_OPENING_ORDERS',
      after_json: JSON.stringify({ observedAt: '2026-11-25T05:50:00.000Z', orders: 9, refunds: 1 }),
    }]);
    const other = await readNineStoreOrders(db, user('shenzhen-test'), nineStoreOrderQuerySchema.parse({}));
    expect(other.snapshot).toBeNull();
    expect(await db.prepare('SELECT COUNT(*) AS count FROM orders').first('count')).toBe(0);
    const handoff = await createHandoff(new Request(`${origin}/api/nine-store-orders/handoff`, { method: 'POST' }));
    expect(handoff.status).toBe(409);
    expect(await handoff.json()).toMatchObject({ code: 'NINE_STORE_ARCHIVE_READ_ONLY' });
  });

  it('要求九店和四张表全部到齐，保留真实同号跨店订单，隐藏来源记录标识', async () => {
    const input = nineStoreOrderSnapshotSchema.parse(snapshot());
    const { db } = connection;
    await expect(storeNineStoreOrderSnapshot(db, 'guangzhou-test', input, time)).resolves.toMatchObject({ replayed: false });
    await expect(storeNineStoreOrderSnapshot(db, 'guangzhou-test', input, time)).resolves.toMatchObject({ replayed: true });
    const orders = await readNineStoreOrders(db, user('guangzhou-test'), nineStoreOrderQuerySchema.parse({}));
    expect(orders.total).toBe(9);
    expect(orders.snapshot?.stores.every((entry) => entry.orderLines === 1 && entry.uniqueOrders === 1)).toBe(true);
    expect(JSON.stringify(orders)).not.toContain('rectest');
    expect(orders.rows.at(-1)).toMatchObject({ storeKey: stores[0].key, orderDate: null, quantity: null, fulfillment: null });
    const refunds = await readNineStoreOrders(db, user('guangzhou-test'), nineStoreOrderQuerySchema.parse({ section: 'refunds', store: stores[0].key }));
    expect(refunds).toMatchObject({ total: 1, rows: [{ refundDate: '2026-11-25' }] });
    const other = await readNineStoreOrders(db, user('shenzhen-test'), nineStoreOrderQuerySchema.parse({}));
    expect(other.snapshot).toBeNull();
    expect(await db.prepare('SELECT COUNT(*) AS count FROM orders').first('count')).toBe(0);
  });

  it('拒绝快照倒退、重复来源行和未登记的属性，不覆盖可用数据', async () => {
    const existing = nineStoreOrderSnapshotSchema.parse(snapshot());
    const { db } = connection;
    await storeNineStoreOrderSnapshot(db, 'guangzhou-test', existing, time);
    const delayed = nineStoreOrderSnapshotSchema.parse(snapshot('2026-11-25T05:55:00.000Z', '22'));
    await expect(storeNineStoreOrderSnapshot(db, 'guangzhou-test', delayed, time)).rejects.toMatchObject({ status: 409 });
    const next = nineStoreOrderSnapshotSchema.parse(snapshot('2026-11-25T05:56:00.000Z', '24'));
    await expect(storeNineStoreOrderSnapshot(db, 'guangzhou-test', next, time)).resolves.toMatchObject({ replayed: false });
    expect(nineStoreOrderSnapshotSchema.safeParse({ ...existing, orders: [...existing.orders, existing.orders[0]] }).success).toBe(false);
    expect(nineStoreOrderSnapshotSchema.safeParse({ ...existing, orders: [{ ...existing.orders[0], address: 'hidden' }, ...existing.orders.slice(1)] }).success).toBe(false);
    expect(nineStoreOrderSnapshotSchema.safeParse({ ...existing, stores: existing.stores.slice(0, 8) }).success).toBe(false);
    const storesWithExtraWayfair = existing.stores.map((entry) => entry.platform === 'wayfair' ? { ...entry, key: 'wayfair-kagu' } : entry);
    const ordersWithExtraWayfair = existing.orders.map((row) => row.storeKey === 'wayfair-linhe' ? { ...row, storeKey: 'wayfair-kagu' } : row);
    expect(nineStoreOrderSnapshotSchema.safeParse({ ...existing, stores: storesWithExtraWayfair, orders: ordersWithExtraWayfair }).success).toBe(false);
  });
});
