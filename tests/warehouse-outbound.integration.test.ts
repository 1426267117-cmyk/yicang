import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET as readLogistics, POST as writeTracking } from '../app/api/logistics/route';
import { POST as writeSalesOrderAction } from '../app/api/orders/[id]/actions/route';
import { GET as readSalesOrders } from '../app/api/orders/route';
import { GET as readOutbound, POST as writeOutbound } from '../app/api/warehouse/outbound/[id]/route';
import { GET as readWarehouse } from '../app/api/warehouse/route';
import { openSqliteD1 } from '../lib/aws/sqlite-d1';
import type { UserContext } from '../lib/db';
import { resolveMemberAccess, ROLE_PERMISSIONS } from '../lib/domain';
import { createOrder, executeOrderAction } from '../lib/erp-service';
import { getFinanceLedger } from '../lib/finance';
import { getWarehouseOutbound, recordWarehouseOutboundStep } from '../lib/warehouse-outbound-service';

const { requestContext } = vi.hoisted(() => ({ requestContext: vi.fn() }));
vi.mock('cloudflare:workers', () => ({ env: {} }));
vi.mock('../lib/db', async (original) => ({ ...await original<typeof import('../lib/db')>(), requestContext }));

const migrations = fileURLToPath(new URL('../drizzle/', import.meta.url));
const now = '2026-11-25T00:00:00.000Z';
const operator: UserContext = {
  id: 'outbound-admin', email: 'warehouse@example.invalid', displayName: '测试仓管', role: 'admin',
  tenantId: 'outbound-gz', tenantName: '测试广州', permissions: ROLE_PERMISSIONS.admin,
};
const pick = { step: 'pick', expectedVersion: 0, quantity: 3 } as const;
const verify = { step: 'verify', expectedVersion: 1, quantity: 3, skuCode: 'TEST-OUT-1' } as const;
const pack = { step: 'pack', expectedVersion: 2, packageCount: 2 } as const;

describe('仓库拣货复核打包', () => {
  let local: ReturnType<typeof openSqliteD1>;
  let db: D1Database;
  let orderId: string;

  beforeEach(async () => {
    requestContext.mockReset();
    local = openSqliteD1(':memory:', migrations);
    db = local.db;
    await db.batch([
      db.prepare('INSERT INTO tenants (id, name, created_at) VALUES (?, ?, ?)').bind(operator.tenantId, operator.tenantName, now),
      db.prepare('INSERT INTO tenants (id, name, created_at) VALUES (?, ?, ?)').bind('outbound-sz', '测试深圳', now),
      db.prepare('INSERT INTO skus (id, tenant_id, code, name, created_at) VALUES (?, ?, ?, ?, ?)')
        .bind('sku-outbound', operator.tenantId, 'TEST-OUT-1', '测试商品', now),
      db.prepare('INSERT INTO warehouses (id, tenant_id, code, name, created_at) VALUES (?, ?, ?, ?, ?)')
        .bind('warehouse-outbound', operator.tenantId, 'TEST-OUT-WH', '测试出库仓', now),
      db.prepare(`INSERT INTO inventory_balances (id, tenant_id, sku_id, warehouse_id, on_hand_qty, reserved_qty, version, updated_at)
        VALUES (?, ?, ?, ?, 9, 0, 1, ?)`)
        .bind('balance-outbound', operator.tenantId, 'sku-outbound', 'warehouse-outbound', now),
    ]);
    const { order } = await createOrder(db, operator, {
      channel: 'Amazon US', destination: '测试目的地', customerName: 'PRIVATE_TEST_RECIPIENT', currency: 'USD',
      amountMinor: 2222, quantity: 3, skuId: 'sku-outbound', warehouseId: 'warehouse-outbound',
    }, 'outbound-order-create');
    orderId = order.id;
    await executeOrderAction(db, operator, orderId, 'approve', 'outbound-order-reserve');
  });

  afterEach(() => local?.close());

  it('登记顺序、实拣数量和复核 SKU 均有效后才允许发货，仅发货触发扣减', async () => {
    const initial = await getWarehouseOutbound(db, operator, orderId);
    expect(initial).toMatchObject({ version: 0, events: [], quantity: 3, orderStatus: 'reserved' });
    expect(JSON.stringify(initial)).not.toContain('PRIVATE_TEST_RECIPIENT');
    await expect(recordWarehouseOutboundStep(db, operator, orderId, pack, 'outbound-skip')).rejects
      .toMatchObject({ code: 'WAREHOUSE_OUTBOUND_VERSION_CONFLICT' });
    await expect(recordWarehouseOutboundStep(db, operator, orderId, { ...pick, quantity: 2 }, 'outbound-short')).rejects
      .toMatchObject({ code: 'WAREHOUSE_OUTBOUND_QUANTITY_MISMATCH' });
    await recordWarehouseOutboundStep(db, operator, orderId, pick, 'outbound-pick');
    await expect(executeOrderAction(db, operator, orderId, 'ship', 'outbound-premature-ship')).rejects
      .toThrow('WAREHOUSE_PACK_REQUIRED');
    await expect(recordWarehouseOutboundStep(db, operator, orderId, { ...verify, skuCode: 'OTHER-SKU' }, 'outbound-bad-sku')).rejects
      .toMatchObject({ code: 'WAREHOUSE_OUTBOUND_SKU_MISMATCH' });
    await recordWarehouseOutboundStep(db, operator, orderId, verify, 'outbound-verify');
    expect(await recordWarehouseOutboundStep(db, operator, orderId, pack, 'outbound-pack')).toMatchObject({
      replayed: false, state: { version: 3, events: [
        { step: 'pick', quantity: 3 }, { step: 'verify', skuCode: 'TEST-OUT-1' }, { step: 'pack', packageCount: 2 },
      ] },
    });
    expect(await stock()).toEqual({ on_hand_qty: 9, reserved_qty: 3 });
    expect(await executeOrderAction(db, operator, orderId, 'ship', 'outbound-final-ship')).toMatchObject({ order: { status: 'shipped' } });
    expect(await stock()).toEqual({ on_hand_qty: 6, reserved_qty: 0 });
    expect((await db.prepare(`SELECT action FROM audit_logs WHERE action LIKE 'WAREHOUSE_OUTBOUND_%' ORDER BY rowid`).all()).results)
      .toEqual([{ action: 'WAREHOUSE_OUTBOUND_PICK' }, { action: 'WAREHOUSE_OUTBOUND_VERIFY' }, { action: 'WAREHOUSE_OUTBOUND_PACK' }]);
  });

  it('并发相同步骤只落一次，操作键不能改变载荷，其他公司和查看角色不能修改', async () => {
    const results = await Promise.all([
      recordWarehouseOutboundStep(db, operator, orderId, pick, 'outbound-identical'),
      recordWarehouseOutboundStep(db, operator, orderId, pick, 'outbound-identical'),
    ]);
    expect(results.map((result) => result.replayed).sort()).toEqual([false, true]);
    expect(await db.prepare('SELECT COUNT(*) AS count FROM warehouse_outbound_events').first('count')).toBe(1);
    await expect(recordWarehouseOutboundStep(db, operator, orderId, { ...pick, quantity: 2 }, 'outbound-identical')).rejects
      .toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(getWarehouseOutbound(db, { ...operator, tenantId: 'outbound-sz' }, orderId)).rejects
      .toMatchObject({ code: 'ORDER_NOT_FOUND' });
    await expect(recordWarehouseOutboundStep(db, { ...operator, permissions: ROLE_PERMISSIONS.viewer }, orderId, verify, 'outbound-viewer'))
      .rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(db.prepare('UPDATE warehouse_outbound_events SET quantity = 4').run()).rejects.toThrow('WAREHOUSE_OUTBOUND_EVENT_IMMUTABLE');
    await expect(db.prepare('DELETE FROM warehouse_outbound_events').run()).rejects.toThrow('WAREHOUSE_OUTBOUND_EVENT_IMMUTABLE');
  });

  it('以同一版本并发提交不同操作键时仅一条前进，取消后保留作业记录并释放预占', async () => {
    const results = await Promise.allSettled([
      recordWarehouseOutboundStep(db, operator, orderId, pick, 'outbound-different-a'),
      recordWarehouseOutboundStep(db, operator, orderId, pick, 'outbound-different-b'),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { code: 'WAREHOUSE_OUTBOUND_VERSION_CONFLICT' },
    });
    await executeOrderAction(db, operator, orderId, 'cancel', 'outbound-cancel');
    expect(await getWarehouseOutbound(db, operator, orderId)).toMatchObject({ version: 1, orderStatus: 'cancelled' });
    await expect(recordWarehouseOutboundStep(db, operator, orderId, verify, 'outbound-cancelled-verify')).rejects
      .toMatchObject({ code: 'WAREHOUSE_OUTBOUND_ORDER_UNAVAILABLE' });
    expect(await stock()).toEqual({ on_hand_qty: 9, reserved_qty: 0 });
  });

  it('兼容尚无仓库作业记录的原有发货调用', async () => {
    const result = await executeOrderAction(db, operator, orderId, 'ship', 'outbound-legacy-ship');
    expect(result.order.status).toBe('shipped');
    expect(await getWarehouseOutbound(db, operator, orderId)).toMatchObject({ version: 0, events: [] });
    expect(await stock()).toEqual({ on_hand_qty: 6, reserved_qty: 0 });
  });

  it('仓库岗位从已审核订单完成出库及物流，同时普通销售、渠道、财务仍受限', async () => {
    const warehouse: UserContext = { ...operator, id: 'warehouse-worker', role: 'operator', accessProfile: 'warehouse',
      ...resolveMemberAccess('operator', 'warehouse') };
    requestContext.mockResolvedValue({ db, user: warehouse });
    const base = 'https://erp.example.invalid';
    const route = { params: Promise.resolve({ id: orderId }) };
    const outbound = `${base}/api/warehouse/outbound/${orderId}`;
    const logistics = `${base}/api/logistics`;
    const mutation = (url: string, data: object, key: string) => new Request(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key }, body: JSON.stringify(data),
    });
    const work = (step: object, key: string) => writeOutbound(mutation(outbound, step, key), route);
    const ship = { step: 'ship', expectedVersion: 3 };

    const pending = await createOrder(db, operator, {
      channel: 'Amazon US', destination: '测试目的地', customerName: '其他销售记录', currency: 'USD',
      amountMinor: 2222, quantity: 3, skuId: 'sku-outbound', warehouseId: 'warehouse-outbound',
    }, 'warehouse-role-pending-sale');
    expect((await readOutbound(new Request(outbound), { params: Promise.resolve({ id: pending.order.id }) })).status).toBe(404);
    const waiting = await readWarehouse(new Request(`${base}/api/warehouse?kind=outbound&stage=0`));
    expect(await waiting.json()).toMatchObject({ rows: [{ id: orderId, quantity: 3 }] });
    const details = await readOutbound(new Request(outbound), route);
    expect(await details.json()).toMatchObject({ state: { orderId, orderStatus: 'reserved', version: 0 } });
    expect((await readSalesOrders(new Request(`${base}/api/orders`))).status).toBe(403);
    for (const action of ['approve', 'cancel', 'ship'] as const) {
      expect((await writeSalesOrderAction(mutation(`${base}/api/orders/${orderId}/actions`, { action }, `warehouse-role-sales-${action}`), route)).status).toBe(403);
    }
    await expect(getFinanceLedger(db, warehouse, orderId, 'payment', 1)).rejects.toMatchObject({ status: 403 });
    expect((await readLogistics(new Request(`${logistics}?view=platform`))).status).toBe(403);
    expect((await readLogistics(new Request(`${logistics}?view=inbound`))).status).toBe(403);
    const early = await work(ship, 'warehouse-role-ship-early');
    expect(early.status).toBe(409);
    expect(await early.json()).toMatchObject({ code: 'WAREHOUSE_PACK_REQUIRED' });
    expect(await stock()).toEqual({ on_hand_qty: 9, reserved_qty: 3 });

    for (const step of [pick, verify, pack]) {
      expect((await work(step, `warehouse-role-${step.step}`)).status).toBe(201);
    }
    requestContext.mockResolvedValueOnce({ db, user: { ...warehouse, tenantId: 'outbound-sz' } });
    expect((await work(ship, 'warehouse-role-ship-cross-tenant')).status).toBe(404);
    const shipments = await Promise.all([work(ship, 'warehouse-role-ship'), work(ship, 'warehouse-role-ship')]);
    expect(shipments.map((response) => response.status).sort()).toEqual([200, 201]);
    for (const response of shipments) {
      const body = await response.json();
      expect(body).toMatchObject({ state: { orderId, orderStatus: 'shipped', version: 3 } });
      expect(JSON.stringify(body)).not.toMatch(/PRIVATE_TEST_RECIPIENT|amountMinor|destination|customerName/u);
    }
    expect(await stock()).toEqual({ on_hand_qty: 6, reserved_qty: 0 });
    expect(await db.prepare(`SELECT COUNT(*) AS count FROM inventory_movements WHERE order_id = ? AND type = 'ship'`)
      .bind(orderId).first('count')).toBe(1);

    const pendingLogistics = await readLogistics(new Request(`${logistics}?view=erp&status=unregistered`));
    expect(await pendingLogistics.json()).toMatchObject({ rows: [{ orderId, packedPackageCount: 2, registeredPackageCount: 0 }] });
    const tracking = await writeTracking(mutation(logistics, { orderId, expectedVersion: 0, carrier: '测试承运商',
      trackingNumber: 'TEST-WAREHOUSE-123', status: 'registered' }, 'warehouse-role-tracking'));
    expect(tracking.status).toBe(201);
    const { packageId } = await tracking.json() as { packageId: string };
    const history = await readLogistics(new Request(`${logistics}?package=${packageId}`));
    expect(await history.json()).toMatchObject({ history: [{ trackingNumber: 'TEST-WAREHOUSE-123' }] });
    requestContext.mockResolvedValueOnce({ db, user: { ...warehouse, tenantId: 'outbound-sz' } });
    expect((await readLogistics(new Request(`${logistics}?package=${packageId}`))).status).toBe(404);
  });

  function stock() {
    return db.prepare('SELECT on_hand_qty, reserved_qty FROM inventory_balances WHERE id = ?').bind('balance-outbound').first();
  }
});
