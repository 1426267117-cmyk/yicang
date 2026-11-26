import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { openSqliteD1 } from '../lib/aws/sqlite-d1';
import { channelOrderListQuerySchema, getChannelOrder, listChannelOrders } from '../lib/channel-orders';
import { refreshChannelOrder } from '../lib/channel-order-refresh';
import { PlatformOrderRepository } from '../lib/connectors/repository';
import { stableId } from '../lib/connectors/stable';
import type { UserContext } from '../lib/db';
import { getErpPayload } from '../lib/erp-service';
import { shopifyOrderFixture } from './fixtures/shopify-order';

vi.mock('cloudflare:workers', () => ({ env: {} }));

const now = '2026-11-25T00:00:00.000Z';
const tenantId = 'channel-gz';
const viewer: UserContext = {
  id: 'channel-viewer', email: 'viewer@example.invalid', displayName: '运营',
  role: 'viewer', tenantId, tenantName: '广州测试', permissions: ['orders:read'],
};
const shopifyViewer: UserContext = { ...viewer, permissions: ['channels:read'], channelScope: 'shopify' };
const amazonViewer: UserContext = { ...viewer, permissions: ['channels:read'], channelScope: 'amazon' };

describe('平台直连订单查询', () => {
  let connection: ReturnType<typeof openSqliteD1>;
  let db: D1Database;

  beforeAll(async () => {
    connection = openSqliteD1(':memory:', fileURLToPath(new URL('../drizzle/', import.meta.url)));
    db = connection.db;
    await db.batch([
      db.prepare('INSERT INTO tenants (id, name, created_at) VALUES (?, ?, ?)').bind(tenantId, '广州测试', now),
      db.prepare('INSERT INTO tenants (id, name, created_at) VALUES (?, ?, ?)').bind('channel-sz', '深圳测试', now),
    ]);
    const store = db.prepare(`INSERT INTO platform_stores
      (id, tenant_id, platform, connector_key, display_name, official_store_id, api_version, credential_ref, identity_verified_at, created_at, updated_at)
      VALUES (?, ?, ?, 'same-key', '同名测试店', ?, 'test', 'PRIVATE_CREDENTIAL_REF', ?, ?, ?)`);
    await db.batch([
      store.bind('gz-shop', tenantId, 'shopify', 'official-gz-shop', now, now, now),
      store.bind('gz-amz', tenantId, 'amazon', 'official-gz-amz', now, now, now),
      store.bind('sz-shop', 'channel-sz', 'shopify', 'official-sz-shop', now, now, now),
    ]);
    const insert = db.prepare(`INSERT INTO platform_orders
      (id, tenant_id, platform_store_id, platform, source_order_id, source_order_name,
       source_created_at, source_updated_at, source_cancelled_at, test, financial_status, fulfillment_status,
       currency, current_total_amount, refunded_amount, api_version, raw_json, raw_hash, fetched_at, first_seen_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PAID', ?, 'USD', '29.99', '2.50', 'test',
        '{"buyer":"PRIVATE_BUYER"}', 'hash', ?, ?, ?)`);
    const shopOrders = Array.from({ length: 106 }, (_, index) => {
      const code = String(index).padStart(3, '0');
      const created = index === 0 ? '2026-11-24T16:00:00.000Z' : index === 1 ? '2026-11-25T16:00:00.000Z' : now;
      return insert.bind(`shop-${code}`, tenantId, 'gz-shop', 'shopify', `source-${code}`, `#${code}`, created, now,
        index === 1 ? now : null, Number(index === 105), index === 0 || index === 1 ? 'FULFILLED' : 'UNFULFILLED', now, now, now);
    });
    await db.batch([
      ...shopOrders,
      insert.bind('amz-order', tenantId, 'gz-amz', 'amazon', 'source-000', '#000', now, now, null, null, 'UNFULFILLED', now, now, now),
      insert.bind('sz-order', 'channel-sz', 'sz-shop', 'shopify', 'source-000', '#000', now, now, null, null, 'UNFULFILLED', now, now, now),
    ]);
    const line = db.prepare(`INSERT INTO platform_order_lines
      (id, tenant_id, order_id, source_order_line_id, raw_sku, title, ordered_quantity, current_quantity,
       unfulfilled_quantity, currency, unit_price_amount, raw_json, raw_hash, is_current, first_seen_at, last_seen_at)
      VALUES (?, ?, 'shop-000', ?, ?, '测试订单商品', 3, 2, 1, 'USD', '9.99', '{}', 'hash', ?, ?, ?)`);
    await db.batch([
      line.bind('line-live', tenantId, 'line-current', 'ITEM%001', 1, now, now),
      line.bind('line-history', tenantId, 'line-previous', 'HISTORY_ONLY', 0, now, now),
      line.bind('line-other-tenant', 'channel-sz', 'line-outside', 'OTHER_TENANT', 1, now, now),
      db.prepare(`INSERT INTO platform_refunds
        (id, tenant_id, order_id, source_refund_id, source_created_at, currency, amount, note, raw_json, raw_hash, first_seen_at, last_seen_at)
        VALUES ('refund-1', ?, 'shop-000', 'refund-a', ?, 'USD', '2.50', 'PRIVATE_BUYER_NOTE', '{}', 'hash', ?, ?)`)
        .bind(tenantId, now, now, now),
      db.prepare(`INSERT INTO platform_fulfillments
        (id, tenant_id, order_id, source_fulfillment_id, status, shipment_status, source_updated_at, raw_json, raw_hash, first_seen_at, last_seen_at)
        VALUES ('shipment-1', ?, 'shop-000', 'shipment-a', 'SUCCESS', 'DELIVERED', ?, '{}', 'hash', ?, ?)`)
        .bind(tenantId, now, now, now),
      db.prepare(`INSERT INTO platform_fulfillment_tracking
        (id, tenant_id, order_id, fulfillment_id, sequence, company, tracking_number, tracking_url, raw_json, raw_hash, first_seen_at, last_seen_at)
        VALUES ('tracking-1', ?, 'shop-000', 'shipment-1', 0, 'Test Carrier', 'TRACK-001', 'https://example.invalid/PRIVATE_URL', '{}', 'hash', ?, ?)`)
        .bind(tenantId, now, now),
    ]);
  });

  afterAll(() => connection?.close());

  const filter = (query: Record<string, string> = {}) => channelOrderListQuerySchema.parse(query);

  it('跨过 100 条预览分页，订单相同更新时间时顺序稳定，保留旧入口', async () => {
    const result = await listChannelOrders(db, shopifyViewer, filter({ page: '4' }));
    expect(result).toMatchObject({ total: 105, pageSize: 30, stores: [{ key: 'same-key', platform: 'shopify' }] });
    expect(result.orders.map((order) => order.id)).toEqual(Array.from({ length: 15 }, (_, index) => `shop-${String(14 - index).padStart(3, '0')}`));
    expect(await listChannelOrders(db, shopifyViewer, filter({ page: '5' }))).toMatchObject({ total: 105, orders: [] });
    expect((await getErpPayload(db, shopifyViewer)).platformOrders).toHaveLength(100);
    expect(await getErpPayload(db, shopifyViewer, { includePlatformPreview: false })).toMatchObject({
      platformOrders: [], summary: { totalPlatformOrders: 106 },
    });
  });

  it('按平台和店铺区分同号订单，状态、商品、北京时间日期筛选可以叠加', async () => {
    expect((await listChannelOrders(db, viewer, filter({ q: '#000' }))).orders.map((row) => row.id)).toEqual(['shop-000', 'amz-order']);
    const order = await listChannelOrders(db, viewer, filter({ store: 'shopify/same-key', status: 'refund', q: 'item%', from: '2026-11-25', to: '2026-11-25' }));
    expect(order.orders).toMatchObject([{ id: 'shop-000', lineCount: 1, refundCount: 1, fulfillmentCount: 1 }]);
    expect((await listChannelOrders(db, viewer, filter({ status: 'cancelled', from: '2026-11-25', to: '2026-11-25' }))).total).toBe(0);
    expect((await listChannelOrders(db, viewer, filter({ status: 'cancelled', from: '2026-11-26', to: '2026-11-26' }))).total).toBe(1);
    for (const q of ['ITEM_001', 'HISTORY_ONLY', 'OTHER_TENANT', 'PRIVATE_BUYER']) {
      expect((await listChannelOrders(db, viewer, filter({ q }))).total).toBe(0);
    }
    expect(channelOrderListQuerySchema.safeParse({ from: '2026-11-26', to: '2026-11-25' }).success).toBe(false);
  });

  it('只读回当前 SKU、退款及本工作区履约，拦截跨工作区及跨渠道详情', async () => {
    const details = await getChannelOrder(db, shopifyViewer, 'shop-000');
    expect(details).toMatchObject({
      order: { id: 'shop-000' },
      lines: [{ rawSku: 'ITEM%001', orderedQuantity: 3, currentQuantity: 2, unfulfilledQuantity: 1 }],
      refunds: [{ currency: 'USD', amount: '2.50' }],
      fulfillments: [{ id: 'shipment-1', shipmentStatus: 'DELIVERED' }],
      tracking: [{ trackingNumber: 'TRACK-001' }],
    });
    expect(JSON.stringify(details)).not.toMatch(/PRIVATE|line-other-tenant|line-history/u);
    for (const privateOrder of ['sz-order', 'amz-order', 'shop-105']) {
      await expect(getChannelOrder(db, shopifyViewer, privateOrder)).rejects.toMatchObject({ status: 404 });
    }
    await expect(getChannelOrder(db, amazonViewer, 'shop-000')).rejects.toMatchObject({ status: 404 });
    await expect(listChannelOrders(db, amazonViewer, filter({ store: 'shopify/same-key' }))).rejects.toMatchObject({ status: 403 });
    await expect(listChannelOrders(db, { ...viewer, permissions: ['purchase:read'] }, filter())).rejects.toMatchObject({ status: 403 });
  });

  it('按单刷新只请求同工作区原始平台身份，旧响应不刷新凭据时间', async () => {
    const storeId = 'gz-shop-refresh';
    await db.prepare(`INSERT INTO platform_stores
      (id, tenant_id, platform, connector_key, display_name, official_store_id, api_version, credential_ref, identity_verified_at, created_at, updated_at)
      VALUES (?, ?, 'shopify', 'zimasya', '刷新测试店', 'official-refresh', 'test', 'stored-credential', ?, ?, ?)`)
      .bind(storeId, tenantId, now, now, now).run();
    const graph = shopifyOrderFixture();
    const repo = new PlatformOrderRepository(db, tenantId);
    const id = await stableId('porder', tenantId, storeId, graph.sourceOrderId);
    await repo.upsertOrderGraph({ storeId, graph, apiVersion: 'test', runId: null, fetchedAt: now });
    const context = {
      db, user: { ...viewer, permissions: ['orders:read', 'connectors:sync'] } as UserContext,
      runtimeEnv: {}, requestUrl: 'https://erp.example.invalid/',
    };
    const readPlatform = vi.fn(
      async () => ({ ...graph, sourceUpdatedAt: '2026-10-21T00:00:00Z' }),
    );
    await expect(refreshChannelOrder(context, id, { shopify: readPlatform })).rejects.toMatchObject({ code: 'CHANNEL_ORDER_SOURCE_BEHIND' });
    expect(await db.prepare('SELECT fetched_at FROM platform_orders WHERE id = ?').bind(id).first('fetched_at')).toBe(now);
    expect(readPlatform.mock.calls[0]).toEqual([
      context, expect.objectContaining({ source_order_id: graph.sourceOrderId, official_store_id: 'official-refresh' }), 'zimasya',
    ]);
    await expect(refreshChannelOrder(context, id, { shopify: async () => graph })).resolves.toMatchObject({
      refreshedAt: expect.any(String),
    });
    readPlatform.mockClear();
    await expect(refreshChannelOrder({ ...context, user: { ...context.user, tenantId: 'channel-sz' } }, id, { shopify: readPlatform })).rejects.toMatchObject({ status: 404 });
    await expect(refreshChannelOrder({ ...context, user: viewer }, id, { shopify: readPlatform })).rejects.toMatchObject({ status: 403 });
    expect(readPlatform).not.toHaveBeenCalled();
  });
});
