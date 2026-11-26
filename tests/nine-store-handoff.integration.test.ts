import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openSqliteD1 } from '../lib/aws/sqlite-d1';
import type { UserContext } from '../lib/db';
import { ROLE_PERMISSIONS } from '../lib/domain';
import { executeOrderAction, listOrders, orderListQuerySchema } from '../lib/erp-service';
import { appendTrackingEvent } from '../lib/logistics-service';
import { createNineStoreHandoff, getNineStoreHandoff, nineStoreHandoffPostSchema } from '../lib/nine-store-handoff';
import { nineStoreOrderSnapshotSchema, nineStoreRoster, orderFeedTableKinds, type NineStoreOrderSnapshot } from '../lib/nine-store-orders-contract';
import { storeNineStoreOrderSnapshot } from '../lib/nine-store-orders-service';
import { recordWarehouseOutboundStep } from '../lib/warehouse-outbound-service';
import { getWarehousePage } from '../lib/warehouse-service';

vi.mock('cloudflare:workers', () => ({ env: {} }));

const migrations = fileURLToPath(new URL('../drizzle/', import.meta.url));
const initialTime = '2026-11-25T05:50:00.000Z';
const tenant = 'handoff-guangzhou';
const outside = 'handoff-shenzhen';
const sku = 'HANDOFF-DESK';
const skuId = 'handoff-desk';
const warehouseId = 'handoff-warehouse';
const operator = user('operator');
const reviewer = user('admin');
let connection: ReturnType<typeof openSqliteD1>;
let db: D1Database;

function user(role: UserContext['role'], tenantId = tenant): UserContext {
  return { id: `${tenantId}-${role}`, tenantId, tenantName: tenantId, role, displayName: role,
    email: `${role}@handoff.example.test`, permissions: ROLE_PERMISSIONS[role] };
}

const amazon = { store: 'amazon-senyu', orderNo: 'AMAZON-001' } as const;
const wayfair = { store: 'wayfair-linhe', orderNo: 'WAYFAIR-001' } as const;
const shopify = { store: 'shopify-anzhap', orderNo: 'SHOPIFY-001' } as const;
type SourceSelector = typeof amazon | typeof wayfair | typeof shopify;
type SourceLine = NineStoreOrderSnapshot['orders'][number];
type RefundLine = NineStoreOrderSnapshot['refunds'][number];

function line(selected: SourceSelector, recordId: string, fulfillment: SourceLine['fulfillment'] = 'pending'): SourceLine {
  return { recordId, storeKey: selected.store, orderNo: selected.orderNo, sku, orderDate: '2026-11-25', quantity: 8, fulfillment };
}

function handoff(selected: SourceSelector) {
  return nineStoreHandoffPostSchema.parse({ storeKey: selected.store, orderNo: selected.orderNo, sourceSku: sku,
    observedAt: initialTime, skuId, warehouseId, quantity: 2, customerName: '隔离验收买家', destination: '美国',
    currency: 'USD', amountMinor: 2500, confirmedPending: true });
}

async function publish(orders: SourceLine[], refunds: RefundLine[] = [], observedAt = initialTime, revision = 1) {
  const snapshot = nineStoreOrderSnapshotSchema.parse({
    version: 1, source: 'feishu-order-base', observedAt,
    stores: nineStoreRoster.map(([key, platform]) => ({ key, platform, name: key })),
    tables: orderFeedTableKinds.map((kind) => {
      const rows = kind === 'refunds' ? refunds : orders.filter((item) => item.storeKey.startsWith(kind.replace(/-orders$/u, '-')));
      return { kind, revision: String(revision), read: rows.length, accepted: rows.length, invalid: 0, outsideScope: 0 };
    }), orders, refunds,
  });
  await storeNineStoreOrderSnapshot(db, tenant, snapshot);
}

async function inventory() {
  return db.prepare('SELECT on_hand_qty, reserved_qty FROM inventory_balances WHERE tenant_id = ? AND sku_id = ? AND warehouse_id = ?')
    .bind(tenant, skuId, warehouseId).first();
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(initialTime));
  connection = openSqliteD1(':memory:', migrations);
  db = connection.db;
  await db.batch([
    db.prepare('INSERT INTO tenants (id, name, created_at) VALUES (?, ?, ?)').bind(tenant, tenant, initialTime),
    db.prepare('INSERT INTO tenants (id, name, created_at) VALUES (?, ?, ?)').bind(outside, outside, initialTime),
    db.prepare('INSERT INTO skus (id, tenant_id, code, name, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(skuId, tenant, sku, '隔离验收商品', initialTime),
    db.prepare('INSERT INTO skus (id, tenant_id, code, name, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind('outside-sku', outside, sku, '另一家公司商品', initialTime),
    db.prepare('INSERT INTO warehouses (id, tenant_id, code, name, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(warehouseId, tenant, 'CA', '隔离验收仓', initialTime),
    db.prepare('INSERT INTO warehouses (id, tenant_id, code, name, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind('outside-warehouse', outside, 'CA', '另一家公司仓', initialTime),
    db.prepare('INSERT INTO inventory_balances (id, tenant_id, sku_id, warehouse_id, on_hand_qty, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind('handoff-inventory', tenant, skuId, warehouseId, 10, initialTime),
  ]);
});

afterEach(() => {
  connection?.close();
  vi.useRealTimers();
});

describe('飞书平台订单经 ERP 审核、入仓任务和物流回读', () => {
  it('只转单一次，审核后才预占，打包后只发出一次，原平台事实保持独立', async () => {
    await publish([line(amazon, 'recAmazon001')]);
    const initial = await getNineStoreHandoff(db, operator, amazon);
    expect(initial).toMatchObject({ eligibility: 'ready', matchedSkuId: skuId, linkedOrder: null });
    expect(JSON.stringify(initial)).not.toContain('recAmazon001');
    const replies = await Promise.all(Array.from({ length: 4 }, () => createNineStoreHandoff(db, operator, handoff(amazon))));
    const [{ order }] = replies;
    expect(replies.map((reply) => reply.replayed).sort()).toEqual([false, true, true, true]);
    expect(replies.every((reply) => reply.order.id === order.id)).toBe(true);
    expect(order).toMatchObject({ channel: 'Amazon', status: 'pending_review', quantity: 2,
      sourceOrder: { storeKey: amazon.store, orderNo: amazon.orderNo, observedAt: initialTime } });
    expect(await listOrders(db, reviewer, orderListQuerySchema.parse({ q: 'amazon-001' }))).toMatchObject({ total: 1, orders: [{ id: order.id }] });
    expect(await inventory()).toMatchObject({ on_hand_qty: 10, reserved_qty: 0 });
    await expect(createNineStoreHandoff(db, operator, { ...handoff(amazon), quantity: 3 }))
      .rejects.toMatchObject({ code: 'NINE_STORE_HANDOFF_ALREADY_LINKED' });
    await expect(executeOrderAction(db, operator, order.id, 'approve', 'handoff-approve-no-permission'))
      .rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await executeOrderAction(db, reviewer, order.id, 'approve', 'handoff-approve-reserve');
    expect(await inventory()).toMatchObject({ on_hand_qty: 10, reserved_qty: 2 });
    expect(await getWarehousePage(db, operator, { kind: 'outbound', warehouse: warehouseId, page: 1 }))
      .toMatchObject({ rows: [{ id: order.id, orderNo: order.orderNo, skuCode: sku, quantity: 2 }] });
    await expect(executeOrderAction(db, operator, order.id, 'ship', 'handoff-no-packed-ship')).rejects.toThrow('WAREHOUSE_PACK_REQUIRED');
    await recordWarehouseOutboundStep(db, operator, order.id, { step: 'pick', expectedVersion: 0, quantity: 2 }, 'handoff-pick-warehouse');
    await recordWarehouseOutboundStep(db, operator, order.id, { step: 'verify', expectedVersion: 1, quantity: 2, skuCode: sku }, 'handoff-verify-warehouse');
    await recordWarehouseOutboundStep(db, operator, order.id, { step: 'pack', expectedVersion: 2, packageCount: 1 }, 'handoff-pack-warehouse');
    await executeOrderAction(db, operator, order.id, 'ship', 'handoff-ship-warehouse');
    await appendTrackingEvent(db, operator, { orderId: order.id, expectedVersion: 0, carrier: '隔离承运商',
      trackingNumber: 'HANDOFF-TEST-001', status: 'registered', note: '' }, 'handoff-register-tracking');
    expect(await inventory()).toMatchObject({ on_hand_qty: 8, reserved_qty: 0 });
    expect(await getNineStoreHandoff(db, operator, amazon)).toMatchObject({ source: { fulfillment: 'pending' }, eligibility: 'already_linked',
      linkedOrder: { id: order.id, status: 'shipped', trackedPackages: 1 } });

    const next = '2026-11-25T05:55:00.000Z';
    vi.setSystemTime(new Date(next));
    await publish([], [], next, 2);
    expect(await getNineStoreHandoff(db, operator, amazon)).toMatchObject({ eligibility: 'already_linked',
      source: { fulfillment: null, observedAt: initialTime }, linkedOrder: { status: 'shipped', trackedPackages: 1 } });
    expect(await createNineStoreHandoff(db, operator, handoff(amazon))).toMatchObject({ order: { id: order.id }, replayed: true });
    expect(await executeOrderAction(db, operator, order.id, 'ship', 'handoff-ship-warehouse')).toMatchObject({ replayed: true });
    expect(await db.prepare('SELECT COUNT(*) AS count FROM orders').first('count')).toBe(1);
    expect(await db.prepare('SELECT COUNT(*) AS count FROM inventory_movements').first('count')).toBe(2);
  });

  it('待发货证据变化后拒绝审核及发货，并可取消预占', async () => {
    await publish([line(wayfair, 'recWayfair001'), line(amazon, 'recAmazon001')]);
    const { order: wfOrder } = await createNineStoreHandoff(db, operator, handoff(wayfair));
    const { order: azOrder } = await createNineStoreHandoff(db, operator, handoff(amazon));
    expect(wfOrder.channel).toBe('Wayfair');
    await executeOrderAction(db, reviewer, wfOrder.id, 'approve', 'handoff-approve-wayfair');
    const next = '2026-11-25T05:55:00.000Z';
    vi.setSystemTime(new Date(next));
    const refund = { recordId: 'recWayfairRefund', storeKey: wayfair.store, orderNo: wayfair.orderNo, sku, refundDate: '2026-11-25' };
    await publish([line(wayfair, 'recWayfair001'), line(amazon, 'recAmazon001', 'shipped')], [refund], next, 2);
    await expect(executeOrderAction(db, reviewer, azOrder.id, 'approve', 'handoff-refuse-after-shipped'))
      .rejects.toMatchObject({ code: 'NINE_STORE_HANDOFF_SOURCE_CHANGED' });
    await expect(executeOrderAction(db, operator, wfOrder.id, 'ship', 'handoff-refuse-after-refund'))
      .rejects.toMatchObject({ code: 'NINE_STORE_HANDOFF_SOURCE_CHANGED' });
    await executeOrderAction(db, operator, wfOrder.id, 'cancel', 'handoff-cancel-after-refund');
    expect(await inventory()).toMatchObject({ on_hand_qty: 10, reserved_qty: 0 });
  });

  it('拦截不明确的多行订单、待核履约、过期来源和跨工作区资料', async () => {
    await publish([
      line(amazon, 'recAmazon001'), { ...line(amazon, 'recAmazon002'), orderNo: 'amazon-001' },
      line(wayfair, 'recWayfair001'), line(shopify, 'recShopify001', null),
    ]);
    await expect(createNineStoreHandoff(db, operator, handoff(amazon))).rejects.toMatchObject({ code: 'NINE_STORE_HANDOFF_AMBIGUOUS' });
    await expect(createNineStoreHandoff(db, operator, handoff(shopify))).rejects.toMatchObject({ code: 'NINE_STORE_HANDOFF_NOT_PENDING' });
    await expect(createNineStoreHandoff(db, user('viewer'), handoff(wayfair))).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(getNineStoreHandoff(db, user('admin', outside), wayfair)).rejects.toMatchObject({ status: 404 });
    await expect(createNineStoreHandoff(db, operator, { ...handoff(wayfair), skuId: 'outside-sku' }))
      .rejects.toMatchObject({ code: 'NINE_STORE_HANDOFF_SKU_MISMATCH' });
    await expect(createNineStoreHandoff(db, operator, { ...handoff(wayfair), warehouseId: 'outside-warehouse' }))
      .rejects.toMatchObject({ code: 'NINE_STORE_HANDOFF_INVENTORY_UNAVAILABLE' });
    await expect(createNineStoreHandoff(db, operator, { ...handoff(wayfair), observedAt: '2026-11-25T05:49:00.000Z' }))
      .rejects.toMatchObject({ code: 'NINE_STORE_HANDOFF_SOURCE_CHANGED' });
    vi.setSystemTime(new Date('2026-11-25T06:06:00.000Z'));
    await expect(createNineStoreHandoff(db, operator, handoff(wayfair))).rejects.toMatchObject({ code: 'NINE_STORE_HANDOFF_SOURCE_STALE' });
    expect(await db.prepare('SELECT COUNT(*) AS count FROM orders').first('count')).toBe(0);
    expect(await db.prepare('SELECT COUNT(*) AS count FROM nine_store_order_handoffs').first('count')).toBe(0);
  });
});
