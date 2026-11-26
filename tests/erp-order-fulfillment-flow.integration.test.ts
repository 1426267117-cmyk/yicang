import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openSqliteD1 } from '../lib/aws/sqlite-d1';
import { PlatformOrderRepository } from '../lib/connectors/repository';
import { createOrderSchema } from '../lib/contracts';
import type { UserContext } from '../lib/db';
import { ROLE_PERMISSIONS } from '../lib/domain';
import { createOrder, executeOrderAction, listOrders, orderListQuerySchema } from '../lib/erp-service';
import { trackingEventSchema } from '../lib/logistics-contracts';
import { appendTrackingEvent, listManualLogistics, listPlatformLogistics } from '../lib/logistics-service';
import { nineStoreOrderQuerySchema, nineStoreOrderSnapshotSchema, nineStoreRoster, orderFeedTableKinds } from '../lib/nine-store-orders-contract';
import { readNineStoreOrders, storeNineStoreOrderSnapshot } from '../lib/nine-store-orders-service';
import { readErpReport } from '../lib/report-service';
import { getWarehouseOutbound, recordWarehouseOutboundStep } from '../lib/warehouse-outbound-service';
import { getWarehousePage } from '../lib/warehouse-service';
import { money, shopifyOrderFixture } from './fixtures/shopify-order';

vi.mock('cloudflare:workers', () => ({ env: {} }));

const migrations = fileURLToPath(new URL('../drizzle/', import.meta.url));
const now = '2026-11-25T05:30:00.000Z';
const window = { from: '2026-11-25', to: '2026-11-25' };
const tenantId = 'acceptance-gz';
const skuId = 'acceptance-sku';
const skuCode = 'ACCEPTANCE-DESK';
const warehouseId = 'acceptance-warehouse';
const sourceOrderNo = '#99101';
const sourceStoreKey = 'shopify-bizfurniz';
const connectorDomain = 'fixture-workspace.myshopify.com';
const actor = (role: UserContext['role']): UserContext => ({
  id: `acceptance-${role}`, tenantId, tenantName: '隔离验收广州', role, displayName: role,
  email: `${role}@acceptance.example.test`, permissions: ROLE_PERMISSIONS[role],
});
const admin = actor('admin');
const operator = actor('operator');
const outboundQuery = { kind: 'outbound', warehouse: warehouseId, page: 1 } as const;

describe('订单来源、出库、物流与报表的一致性', () => {
  let connection: ReturnType<typeof openSqliteD1>;
  let db: D1Database;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(now));
    connection = openSqliteD1(':memory:', migrations);
    db = connection.db;
    await db.batch([
      db.prepare('INSERT INTO tenants (id, name, created_at) VALUES (?, ?, ?)').bind(tenantId, admin.tenantName, now),
      db.prepare('INSERT INTO skus (id, tenant_id, code, name, created_at) VALUES (?, ?, ?, ?, ?)')
        .bind(skuId, tenantId, skuCode, '隔离验收商品', now),
      db.prepare('INSERT INTO warehouses (id, tenant_id, code, name, created_at) VALUES (?, ?, ?, ?, ?)')
        .bind(warehouseId, tenantId, 'ACCEPTANCE-CA', '隔离验收仓库', now),
      db.prepare(`INSERT INTO inventory_balances (id, tenant_id, sku_id, warehouse_id, on_hand_qty, updated_at)
        VALUES (?, ?, ?, ?, 10, ?)`).bind('acceptance-balance', tenantId, skuId, warehouseId, now),
    ]);
  });

  afterEach(() => {
    connection?.close();
    vi.useRealTimers();
  });

  it('重复创建和审批只产生一张订单和一笔库存预占', async () => {
    const input = createOrderSchema.parse({ channel: 'Shopify', destination: '验收目的地', customerName: '隔离验收客户',
      currency: 'USD', amountMinor: 8200, quantity: 2, skuId, warehouseId });
    const results = await Promise.all(Array.from({ length: 8 }, () => createOrder(db, operator, input, 'acceptance-concurrent-order')));
    const [{ order }] = results;
    expect(results.every((result) => result.order.id === order.id)).toBe(true);
    expect(results.filter((result) => !result.replayed)).toHaveLength(1);
    await expect(createOrder(db, operator, { ...input, quantity: 3 }, 'acceptance-concurrent-order'))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(await listOrders(db, admin, orderListQuerySchema.parse({}))).toMatchObject({ total: 1 });
    await Promise.all(Array.from({ length: 8 }, () => executeOrderAction(db, admin, order.id, 'approve', 'acceptance-concurrent-approval')));
    expect(await db.prepare('SELECT COUNT(*) AS total FROM inventory_movements WHERE order_id = ?').bind(order.id).first('total')).toBe(1);
    expect(await readErpReport(db, admin, 'inventory', null, now)).toMatchObject({ rows: [{ on_hand_qty: 10, reserved_qty: 2 }] });
  });

  it('来源快照可读取且不会自动改库存，手工建单后同一销售记录贯穿审核、仓库、物流和汇总报表', async () => {
    const snapshot = nineStoreOrderSnapshotSchema.parse({
      version: 1, source: 'feishu-order-base', observedAt: now,
      stores: nineStoreRoster.map(([key, platform]) => ({ key, platform, name: key })),
      tables: orderFeedTableKinds.map((kind) => {
        const accepted = kind === 'shopify-orders' ? 1 : 0;
        return { kind, revision: '1', read: accepted, accepted, outsideScope: 0, invalid: 0 };
      }),
      orders: [{ recordId: 'recERPFlow101', storeKey: sourceStoreKey, orderNo: sourceOrderNo, sku: skuCode,
        orderDate: window.from, quantity: 2, fulfillment: 'pending' }],
      refunds: [],
    });
    await storeNineStoreOrderSnapshot(db, tenantId, snapshot, new Date(now));
    const readSource = () => readNineStoreOrders(db, admin, nineStoreOrderQuerySchema.parse({ store: sourceStoreKey, search: sourceOrderNo }));
    expect(await readSource()).toMatchObject({ total: 1, rows: [{ orderNo: sourceOrderNo, sku: skuCode, quantity: 2, fulfillment: 'pending' }] });
    expect(await readErpReport(db, admin, 'platform', window, now)).toMatchObject({ rows: [] });
    expect(await getWarehousePage(db, operator, outboundQuery)).toMatchObject({ rows: [] });

    const repository = new PlatformOrderRepository(db, tenantId);
    const store = await repository.upsertVerifiedShopifyStore({
      key: 'bizfurniz', displayName: 'Fixture Store', domain: connectorDomain, expectedDomain: connectorDomain,
      acceptedDomains: [connectorDomain], authMode: 'oauth', environmentPrefix: 'SHOPIFY_BIZFURNIZ',
      credentialRef: 'env:SHOPIFY_BIZFURNIZ', adminAccessToken: null, clientId: null, clientSecret: null,
    }, {
      id: 'gid://shopify/Shop/99101', name: 'Fixture Store', domain: connectorDomain,
      timezone: 'America/Los_Angeles', timezoneOffset: '-0800', currency: 'USD', scopes: new Set(['read_orders']),
    }, now);
    const graph = shopifyOrderFixture({
      id: 'gid://shopify/Order/99101', name: sourceOrderNo, createdAt: '2026-11-25T08:30:00.000Z', updatedAt: '2026-11-25T08:31:00.000Z',
      processedAt: '2026-11-25T08:30:01.000Z', displayFinancialStatus: 'PAID', displayFulfillmentStatus: 'UNFULFILLED',
      currentTotalPriceSet: money('82.00'), refunds: [], fulfillments: [],
      lineItems: { nodes: [{ id: 'gid://shopify/LineItem/99101', sku: skuCode, title: 'Desk', name: 'Desk',
        quantity: 2, currentQuantity: 2, unfulfilledQuantity: 2 }], pageInfo: { hasNextPage: false, endCursor: null } },
    });
    await expect(repository.upsertOrderGraph({ storeId: store.id, graph, apiVersion: '2026-07', runId: null, fetchedAt: now })).resolves.toBe('inserted');
    expect(await readErpReport(db, admin, 'platform', window, now)).toMatchObject({ rows: [{ order_count: 1, amount_minor: '8200' }] });
    expect(await listOrders(db, admin, orderListQuerySchema.parse({}))).toMatchObject({ total: 0 });
    expect(await readErpReport(db, admin, 'inventory', null, now)).toMatchObject({ rows: [{ on_hand_qty: 10, reserved_qty: 0 }] });

    const { order } = await createOrder(db, operator, createOrderSchema.parse({
      channel: 'Shopify', destination: '验收目的地', customerName: '隔离验收客户', currency: 'USD',
      amountMinor: 8200, quantity: 2, skuId, warehouseId,
    }), 'acceptance-order-create');
    expect(order.orderNo).not.toEqual(sourceOrderNo);
    await expect(executeOrderAction(db, operator, order.id, 'approve', 'acceptance-disallowed-approve'))
      .rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await executeOrderAction(db, admin, order.id, 'approve', 'acceptance-order-approve');
    expect(await getWarehousePage(db, operator, { ...outboundQuery, stage: '0' })).toMatchObject({
      rows: [{ id: order.id, orderNo: order.orderNo, skuCode, quantity: 2, outboundVersion: 0, packedPackageCount: null }],
    });
    expect(await readErpReport(db, admin, 'inventory', null, now)).toMatchObject({ rows: [{ on_hand_qty: 10, reserved_qty: 2, available_qty: 8 }] });

    await recordWarehouseOutboundStep(db, operator, order.id, { step: 'pick', expectedVersion: 0, quantity: 2 }, 'acceptance-order-pick');
    expect(await getWarehousePage(db, operator, { ...outboundQuery, stage: '0' })).toMatchObject({ rows: [] });
    expect(await getWarehousePage(db, operator, { ...outboundQuery, stage: '1' })).toMatchObject({ rows: [{ id: order.id, outboundVersion: 1 }] });
    await expect(executeOrderAction(db, operator, order.id, 'ship', 'acceptance-not-yet-packed')).rejects.toThrow('WAREHOUSE_PACK_REQUIRED');
    await recordWarehouseOutboundStep(db, operator, order.id, { step: 'verify', expectedVersion: 1, quantity: 2, skuCode }, 'acceptance-order-verify');
    expect(await getWarehousePage(db, operator, { ...outboundQuery, stage: '2' })).toMatchObject({ rows: [{ id: order.id, outboundVersion: 2 }] });
    await recordWarehouseOutboundStep(db, operator, order.id, { step: 'pack', expectedVersion: 2, packageCount: 1 }, 'acceptance-order-pack');
    expect(await getWarehousePage(db, operator, { ...outboundQuery, stage: '3' })).toMatchObject({ rows: [{ id: order.id, outboundVersion: 3, packedPackageCount: 1 }] });
    const shipment = await Promise.all(['acceptance-order-ship', 'acceptance-order-ship', 'acceptance-order-ship-second-client']
      .map((key) => executeOrderAction(db, operator, order.id, 'ship', key)));
    expect(shipment.map(({ order: updated }) => updated.status)).toEqual(['shipped', 'shipped', 'shipped']);
    expect(shipment.filter(({ replayed }) => !replayed)).toHaveLength(1);
    expect(await getWarehouseOutbound(db, operator, order.id)).toMatchObject({ orderStatus: 'shipped', version: 3 });
    expect(await getWarehousePage(db, operator, outboundQuery)).toMatchObject({ rows: [] });

    const tracking = trackingEventSchema.parse({ orderId: order.id, expectedVersion: 0, carrier: 'Fixture Carrier',
      trackingNumber: 'ACCEPTANCE-0101', status: 'registered' });
    const { packageId } = await appendTrackingEvent(db, operator, tracking, 'acceptance-parcel-create');
    await appendTrackingEvent(db, operator, trackingEventSchema.parse({ ...tracking, packageId, expectedVersion: 1, status: 'delivered' }),
      'acceptance-parcel-delivered');
    expect(await listManualLogistics(db, operator, order.orderNo, 1, 'delivered')).toMatchObject({
      total: 1, rows: [{ orderId: order.id, skuCode, quantity: 2, status: 'delivered', trackingNumber: tracking.trackingNumber }],
    });
    expect(await listPlatformLogistics(db, admin, sourceOrderNo, 1)).toMatchObject({ total: 0 });
    expect(await readSource()).toMatchObject({ rows: [{ fulfillment: 'pending' }] });
    expect(await readErpReport(db, admin, 'orders', window, now)).toMatchObject({ rows: [{ shipped_count: 1, active_qty: 2, amount_minor: '8200' }] });
    expect(await readErpReport(db, admin, 'inventory', null, now)).toMatchObject({ rows: [{ on_hand_qty: 8, reserved_qty: 0, available_qty: 8 }] });
    const movements = await db.prepare('SELECT type, on_hand_delta, reserved_delta FROM inventory_movements WHERE order_id = ? ORDER BY rowid')
      .bind(order.id).all();
    expect(movements.results).toEqual([
      { type: 'reserve', on_hand_delta: 0, reserved_delta: 2 }, { type: 'ship', on_hand_delta: -2, reserved_delta: -2 },
    ]);
  });
});
