import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openSqliteD1 } from '../lib/aws/sqlite-d1';
import type { UserContext } from '../lib/db';
import { ROLE_PERMISSIONS } from '../lib/domain';
import { createOrder, executeOrderAction } from '../lib/erp-service';
import { feishuProcurementPreviewSchema, feishuProcurementPreviewInsertValues, INSERT_FEISHU_PROCUREMENT_PREVIEW } from '../lib/feishu-procurement-preview-contract';
import { trackingEventSchema } from '../lib/logistics-contracts';
import { appendTrackingEvent, getTrackingHistory, listInboundLogistics, listManualLogistics, listPlatformLogistics } from '../lib/logistics-service';
import { recordWarehouseOutboundStep } from '../lib/warehouse-outbound-service';

vi.mock('cloudflare:workers', () => ({ env: {} }));

const migrations = fileURLToPath(new URL('../drizzle/', import.meta.url));
const now = '2026-11-25T00:00:00.000Z';
const createUser = (tenantId: string, role: UserContext['role'] = 'admin'): UserContext => ({
  tenantId, tenantName: tenantId, id: `${tenantId}-${role}`, displayName: role,
  email: `${tenantId}-${role}@example.test`, role, permissions: ROLE_PERMISSIONS[role],
});

let database: ReturnType<typeof openSqliteD1>;
let db: D1Database;

beforeEach(async () => {
  database = openSqliteD1(':memory:', migrations);
  db = database.db;
  for (const tenantId of ['gz', 'sz']) {
    await db.batch([
      db.prepare('INSERT INTO tenants VALUES (?, ?, ?)').bind(tenantId, tenantId, now),
      db.prepare('INSERT INTO skus (id, tenant_id, code, name, created_at) VALUES (?, ?, ?, ?, ?)')
        .bind(`${tenantId}-sku`, tenantId, `${tenantId}-sku`, '测试 SKU', now),
      db.prepare('INSERT INTO warehouses (id, tenant_id, code, name, created_at) VALUES (?, ?, ?, ?, ?)')
        .bind(`${tenantId}-warehouse`, tenantId, `${tenantId}-warehouse`, '测试仓库', now),
      db.prepare(`INSERT INTO inventory_balances
        (id, tenant_id, sku_id, warehouse_id, on_hand_qty, updated_at) VALUES (?, ?, ?, ?, 10, ?)`)
        .bind(`${tenantId}-balance`, tenantId, `${tenantId}-sku`, `${tenantId}-warehouse`, now),
    ]);
  }
});
afterEach(() => database.close());

async function makeOrder(user: UserContext) {
  return (await createOrder(db, user, {
    channel: 'Amazon US', destination: '美国', customerName: '隔离测试客户', currency: 'USD', amountMinor: 2000,
    skuId: `${user.tenantId}-sku`, warehouseId: `${user.tenantId}-warehouse`, quantity: 2,
  }, `idempotency-create-order-${user.tenantId}`)).order;
}

describe('订单物流工作台', () => {
  it('按同公司已出库订单登记多包裹、重放与状态记录，保留原库存流水', async () => {
    const user = createUser('gz');
    const order = await makeOrder(user);
    const other = await makeOrder(createUser('sz'));
    const register = (orderId: string, trackingNumber = 'test-123') => trackingEventSchema.parse({
      orderId, expectedVersion: 0, carrier: '测试承运商', trackingNumber, status: 'registered',
    });
    await expect(appendTrackingEvent(db, user, register(other.id), 'track-denied-order')).rejects.toMatchObject({ status: 404 });
    await expect(appendTrackingEvent(db, user, register(order.id), 'track-unshipped-order')).rejects.toMatchObject({ code: 'ORDER_NOT_SHIPPED' });
    await executeOrderAction(db, user, order.id, 'approve', 'logistics-order-approve');
    await executeOrderAction(db, user, order.id, 'ship', 'logistics-order-ship');

    const unregistered = await listManualLogistics(db, user, order.orderNo, 1, 'unregistered');
    expect(unregistered).toMatchObject({ total: 1, rows: [{ orderId: order.id, packageId: null }] });
    expect(JSON.stringify(unregistered)).not.toContain('隔离测试客户');
    const input = register(order.id);
    await expect(appendTrackingEvent(db, createUser('gz', 'viewer'), input, 'tracking-viewer-denied'))
      .rejects.toMatchObject({ status: 403 });
    const shipments = await Promise.all([
      appendTrackingEvent(db, user, input, 'tracking-register-first'),
      appendTrackingEvent(db, user, input, 'tracking-register-first'),
    ]);
    expect(shipments[0].packageId).toBe(shipments[1].packageId);
    expect(shipments.map((item) => item.replayed).sort()).toEqual([false, true]);
    const { packageId } = shipments[0];
    await expect(appendTrackingEvent(db, user, input, 'tracking-register-duplicate')).rejects.toMatchObject({ status: 409 });
    await appendTrackingEvent(db, user, register(order.id, 'TEST-124'), 'tracking-register-second');

    const update = (status: 'in_transit' | 'exception' | 'delivered', version: number) => trackingEventSchema.parse({
      ...input, packageId, expectedVersion: version, status, note: '测试变更记录',
    });
    const competing = await Promise.allSettled([
      appendTrackingEvent(db, user, update('in_transit', 1), 'tracking-progress-transit'),
      appendTrackingEvent(db, user, update('exception', 1), 'tracking-progress-exception'),
    ]);
    expect(competing.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    await appendTrackingEvent(db, user, update('delivered', 2), 'tracking-delivered-3');
    await expect(appendTrackingEvent(db, user, update('in_transit', 3), 'tracking-reopen-denied'))
      .rejects.toMatchObject({ code: 'INVALID_TRACKING_TRANSITION' });
    await expect(getTrackingHistory(db, createUser('sz'), packageId)).rejects.toMatchObject({ status: 404 });
    const history = await getTrackingHistory(db, user, packageId);
    expect(history.map((item) => item.version)).toEqual([3, 2, 1]);
    const registered = await listManualLogistics(db, user, 'test-12', 1, 'all');
    expect(registered.total).toBe(2);
    expect(await listManualLogistics(db, createUser('sz'), '', 1, 'all')).toEqual({ rows: [], total: 0 });
    expect(await db.prepare('SELECT on_hand_qty, reserved_qty FROM inventory_balances WHERE id = ?').bind('gz-balance').first())
      .toEqual({ on_hand_qty: 8, reserved_qty: 0 });
  });

  it('采购在途读取同公司最新快照并可按批次查询，未同步的平台履约为空', async () => {
    for (const tenantId of ['gz', 'sz']) {
      const snapshot = feishuProcurementPreviewSchema.parse({
        snapshotDate: '2026-11-25', salesStart: '2026-11-01', salesEnd: '2026-11-24', skus: [], storeSales: [], review: [],
        transit: [{ sku: `${tenantId}-sku`, region: 'CA', arrivalDate: '2026-11-27', pcs: 4, batch: `${tenantId}-batch`, container: null }],
      });
      await db.prepare(INSERT_FEISHU_PROCUREMENT_PREVIEW).bind(...await feishuProcurementPreviewInsertValues(tenantId, 'test', snapshot)).run();
    }
    const user = createUser('gz');
    await expect(listInboundLogistics(db, user, 'gz-batch', 1)).resolves.toMatchObject({
      total: 1, snapshotDate: '2026-11-25', rows: [{ sku: 'gz-sku', pcs: 4 }],
    });
    await expect(listInboundLogistics(db, user, 'sz-batch', 1)).resolves.toMatchObject({ total: 0, rows: [] });
    await expect(listPlatformLogistics(db, user, '', 1)).resolves.toEqual({ total: 0, rows: [] });
  });

  it('部分登记仍在待办，报齐并发受装箱数限制，额外包裹记录原因且不重复扣库存', async () => {
    const user = createUser('gz');
    const order = await makeOrder(user);
    await executeOrderAction(db, user, order.id, 'approve', 'packing-order-approve');
    await recordWarehouseOutboundStep(db, user, order.id, { step: 'pick', expectedVersion: 0, quantity: 2 }, 'packing-order-pick');
    await recordWarehouseOutboundStep(db, user, order.id, { step: 'verify', expectedVersion: 1, quantity: 2, skuCode: 'gz-sku' }, 'packing-order-verify');
    await recordWarehouseOutboundStep(db, user, order.id, { step: 'pack', expectedVersion: 2, packageCount: 2 }, 'packing-order-pack');
    await executeOrderAction(db, user, order.id, 'ship', 'packing-order-ship');

    const first = trackingEventSchema.parse({ orderId: order.id, expectedVersion: 0, carrier: 'Fixture Carrier',
      trackingNumber: 'TRACK-FIRST', status: 'registered' });
    expect(await listManualLogistics(db, user, order.orderNo, 1, 'unregistered')).toMatchObject({
      total: 1, rows: [{ packageId: null, packedPackageCount: 2, registeredPackageCount: 0 }],
    });
    const firstParcel = await appendTrackingEvent(db, user, first, 'packing-track-first');
    expect(await listManualLogistics(db, user, 'TRACK-FIRST', 1, 'unregistered')).toMatchObject({
      total: 1, rows: [{ orderId: order.id, packageId: null, packedPackageCount: 2, registeredPackageCount: 1 }],
    });
    expect(await listManualLogistics(db, user, order.orderNo, 1, 'registered')).toMatchObject({
      total: 1, rows: [{ packageId: firstParcel.packageId, packedPackageCount: 2, registeredPackageCount: 1 }],
    });

    const competing = await Promise.allSettled(['SECOND-A', 'SECOND-B'].map((suffix) =>
      appendTrackingEvent(db, user, { ...first, trackingNumber: `TRACK-${suffix}` }, `packing-track-${suffix}`)));
    expect(competing.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(competing.find((result) => result.status === 'rejected')).toMatchObject({ reason: { code: 'TRACKING_PACKAGE_LIMIT_REACHED' } });
    expect(await listManualLogistics(db, user, order.orderNo, 1, 'unregistered')).toEqual({ rows: [], total: 0 });
    await expect(appendTrackingEvent(db, user, first, 'packing-track-first')).resolves.toMatchObject({ ...firstParcel, replayed: true });
    await expect(appendTrackingEvent(db, user, { ...first, packageId: firstParcel.packageId,
      expectedVersion: 1, status: 'in_transit' }, 'packing-track-progress')).resolves.toMatchObject({ version: 2 });

    const additional = { ...first, trackingNumber: 'TRACK-EXTRA', additionalPackage: true } as const;
    expect(trackingEventSchema.safeParse(additional).success).toBe(false);
    const overrideInput = trackingEventSchema.parse({ ...additional, note: '承运商拆出一箱，原包装数量已复核。' });
    const extra = await appendTrackingEvent(db, user, overrideInput, 'packing-track-extra');
    expect(await getTrackingHistory(db, user, extra.packageId)).toMatchObject([{ note: overrideInput.note }]);
    await expect(appendTrackingEvent(db, user, overrideInput, 'packing-track-extra-duplicate')).rejects.toMatchObject({ status: 409 });
    expect(await listManualLogistics(db, user, order.orderNo, 1, 'all')).toMatchObject({
      total: 3, rows: Array.from({ length: 3 }, () => ({ packedPackageCount: 2, registeredPackageCount: 3 })),
    });
    expect(await db.prepare(`SELECT COUNT(*) AS count FROM inventory_movements WHERE order_id = ? AND type = 'ship'`)
      .bind(order.id).first('count')).toBe(1);
    expect(await db.prepare('SELECT on_hand_qty, reserved_qty FROM inventory_balances WHERE id = ?').bind('gz-balance').first())
      .toEqual({ on_hand_qty: 8, reserved_qty: 0 });
  });
});
