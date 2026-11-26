import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET as readWarehouse } from '../app/api/warehouse/route';
import { openSqliteD1 } from '../lib/aws/sqlite-d1';
import type { UserContext } from '../lib/db';
import { resolveMemberAccess, ROLE_PERMISSIONS } from '../lib/domain';
import { createOrder, executeOrderAction } from '../lib/erp-service';
import { getWarehousePage, recordWarehouseStockCount, type WarehousePage } from '../lib/warehouse-service';

const { requestContext } = vi.hoisted(() => ({ requestContext: vi.fn() }));
vi.mock('cloudflare:workers', () => ({ env: {} }));
vi.mock('../lib/db', async (original) => ({ ...await original<typeof import('../lib/db')>(), requestContext }));

const now = '2026-11-25T00:00:00.000Z';
const migrations = fileURLToPath(new URL('../drizzle/', import.meta.url));
const user: UserContext = {
  id: 'warehouse-test', email: 'warehouse@example.invalid', displayName: '仓管', role: 'admin',
  tenantId: 'test-gz', tenantName: '广州测试', permissions: ROLE_PERMISSIONS.admin,
};
const other = { ...user, tenantId: 'test-sz', tenantName: '深圳测试' };
const count = { skuId: 'sku-test-gz', warehouseId: 'warehouse-test-gz', countedQty: 18, reason: '盘点复核', expectedVersion: 0 };

describe('仓库出入库工作台和库存盘点', () => {
  let local: ReturnType<typeof openSqliteD1>;
  let db: D1Database;

  beforeEach(async () => {
    local = openSqliteD1(':memory:', migrations);
    db = local.db;
    for (const tenant of [user, other]) {
      await db.batch([
        db.prepare('INSERT INTO tenants (id, name, created_at) VALUES (?, ?, ?)').bind(tenant.tenantId, tenant.tenantName, now),
        db.prepare('INSERT INTO skus (id, tenant_id, code, name, created_at) VALUES (?, ?, ?, ?, ?)')
          .bind(`sku-${tenant.tenantId}`, tenant.tenantId, 'TEST-CH-1', '测试椅', now),
        db.prepare('INSERT INTO warehouses (id, tenant_id, code, name, created_at) VALUES (?, ?, ?, ?, ?)')
          .bind(`warehouse-${tenant.tenantId}`, tenant.tenantId, 'TEST-WEST', '测试仓', now),
      ]);
    }
  });

  afterEach(() => {
    local?.close();
    vi.useRealTimers();
  });

  it('首次实盘建立 ERP 库存，网络重试复用操作并保留不可变历史', async () => {
    const [a, b] = await Promise.all([
      recordWarehouseStockCount(db, user, count, 'warehouse-count-retry'),
      recordWarehouseStockCount(db, user, count, 'warehouse-count-retry'),
    ]);
    expect(a.id).toBe(b.id);
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
    expect(await db.prepare('SELECT on_hand_qty, reserved_qty, version FROM inventory_balances').first())
      .toEqual({ on_hand_qty: 18, reserved_qty: 0, version: 1 });
    expect(await db.prepare('SELECT COUNT(*) AS count FROM audit_logs WHERE action = ?').bind('COUNT_WAREHOUSE_STOCK').first('count')).toBe(1);
    await expect(recordWarehouseStockCount(db, user, { ...count, countedQty: 19 }, 'warehouse-count-retry'))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(db.prepare('UPDATE warehouse_stock_counts SET reason = ? WHERE id = ?').bind('追改', a.id).run())
      .rejects.toThrow('WAREHOUSE_STOCK_COUNT_IMMUTABLE');
    await expect(db.prepare('DELETE FROM warehouse_stock_counts WHERE id = ?').bind(a.id).run())
      .rejects.toThrow('WAREHOUSE_STOCK_COUNT_IMMUTABLE');
    const page = await getWarehousePage(db, user, { kind: 'counts', page: 1 });
    expect(page.rows).toMatchObject([{ skuCode: 'TEST-CH-1', beforeOnHandQty: 0, countedQty: 18, reservedQty: 0 }]);
  });

  it('两个不同盘点使用同一版本时只有一个生效，旧版本和跨公司库存不会被覆盖', async () => {
    const writes = await Promise.allSettled([
      recordWarehouseStockCount(db, user, count, 'warehouse-count-concurrent-a'),
      recordWarehouseStockCount(db, user, { ...count, countedQty: 40 }, 'warehouse-count-concurrent-b'),
    ]);
    expect(writes.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    expect(writes.find((item) => item.status === 'rejected')).toMatchObject({
      reason: { code: 'WAREHOUSE_STOCK_COUNT_VERSION_CONFLICT' },
    });
    await expect(recordWarehouseStockCount(db, other, count, 'warehouse-count-cross-tenant'))
      .rejects.toMatchObject({ code: 'WAREHOUSE_STOCK_COUNT_SCOPE_MISMATCH' });
    await expect(db.prepare(`
      INSERT INTO warehouse_stock_counts (
        id, tenant_id, sku_id, warehouse_id, before_on_hand_qty, reserved_qty, counted_qty,
        inventory_version, reason, operation_key, request_hash, created_by, created_at
      ) VALUES ('invalid-scope', ?, ?, ?, 0, 0, 5, 0, 'test', 'invalid-key', 'hash', ?, ?)
    `).bind(other.tenantId, count.skuId, count.warehouseId, user.id, now).run())
      .rejects.toThrow('WAREHOUSE_STOCK_COUNT_SCOPE_MISMATCH');
    await expect(recordWarehouseStockCount(db, { ...user, role: 'viewer', permissions: ROLE_PERMISSIONS.viewer }, count, 'warehouse-count-viewer'))
      .rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(await getWarehousePage(db, other, { kind: 'counts', page: 1 })).toMatchObject({ rows: [] });
    expect(await db.prepare('SELECT COUNT(*) AS count FROM warehouse_stock_counts').first('count')).toBe(1);
  });

  it('实盘数低于订单预占时拒绝冲减，待出库只返回当前公司的作业字段', async () => {
    await recordWarehouseStockCount(db, user, count, 'warehouse-count-ship-setup');
    const { order } = await createOrder(db, user, {
      channel: 'Amazon US', destination: '测试目的地', customerName: '测试客户',
      currency: 'CNY', amountMinor: 1000, quantity: 7, skuId: count.skuId, warehouseId: count.warehouseId,
    }, 'warehouse-create-order');
    await executeOrderAction(db, user, order.id, 'approve', 'warehouse-approve-order');
    const page = await getWarehousePage(db, user, { kind: 'outbound', page: 1, q: 'test-ch' });
    expect(page.rows).toHaveLength(1);
    expect(Object.keys(page.rows[0]).sort()).toEqual(['id', 'orderNo', 'quantity', 'reservedAt', 'skuCode', 'skuName', 'warehouseName', 'outboundVersion', 'packedPackageCount'].sort());
    expect(await getWarehousePage(db, other, { kind: 'outbound', page: 1 })).toMatchObject({ rows: [] });
    await expect(recordWarehouseStockCount(db, user, { ...count, expectedVersion: 2, countedQty: 6 }, 'warehouse-count-below-reserved'))
      .rejects.toMatchObject({ code: 'WAREHOUSE_STOCK_COUNT_RESERVED' });
    const adjusted = await recordWarehouseStockCount(db, user, { ...count, expectedVersion: 2, countedQty: 7 }, 'warehouse-count-equals-reserved');
    expect(adjusted.replayed).toBe(false);
    expect(await db.prepare('SELECT on_hand_qty, reserved_qty, version FROM inventory_balances').first())
      .toEqual({ on_hand_qty: 7, reserved_qty: 7, version: 3 });
  });

  it('仓库流水按北京时间和原单筛选，服务端分页且限制公司及岗位范围', async () => {
    for (let index = 0; index < 27; index++) {
      const boundary = Date.parse('2026-11-24T16:00:00.000Z');
      vi.setSystemTime(new Date(boundary + (index - 1) * 1_000));
      await recordWarehouseStockCount(db, user, { ...count, expectedVersion: index, countedQty: index + 1,
        reason: `测试实盘批次 ${index}` }, `warehouse-ledger-${index}`);
    }
    const worker = { ...user, role: 'operator' as const, ...resolveMemberAccess('operator', 'warehouse') };
    const endpoint = 'https://erp.example.invalid/api/warehouse?kind=movements';
    const read = async (parameters: string, auth: UserContext = worker) => {
      requestContext.mockResolvedValueOnce({ db, user: auth });
      return readWarehouse(new Request(endpoint + parameters));
    };
    const dates = '&from=2026-11-25&through=2026-11-25';
    const first = await read(dates + '&movement=count');
    expect(first.status).toBe(200);
    expect(first.headers.get('Cache-Control')).toBe('private, no-store');
    const firstPage = await first.json() as Extract<WarehousePage, { kind: 'movements' }>;
    expect(firstPage).toMatchObject({ kind: 'movements', hasNext: true });
    expect(firstPage.rows).toHaveLength(25);
    expect(firstPage.rows[0]).toMatchObject({ afterOnHandQty: 27 });
    expect(await (await read(dates + '&page=2')).json()).toMatchObject({
      hasNext: false, rows: [{ afterOnHandQty: 2, createdAt: '2026-11-24T16:00:00.000Z' }],
    });
    expect(await (await read('&through=2026-11-24')).json()).toMatchObject({
      hasNext: false, rows: [{ afterOnHandQty: 1, createdAt: '2026-11-24T15:59:59.000Z' }],
    });
    expect(await (await read(`&sku=${count.skuId}&warehouse=${count.warehouseId}&q=${firstPage.rows[0].reference}`)).json())
      .toMatchObject({ rows: [{ reference: firstPage.rows[0].reference }] });
    expect(await (await read('&q=test-ch-1', other)).json()).toMatchObject({ rows: [] });
    expect((await read('&from=2026-11-26&through=2026-11-25')).status).toBe(400);
    expect((await read('&page=10001')).status).toBe(400);
    for (const profile of ['amazon', 'finance', 'purchase'] as const) {
      const restricted = { ...user, ...resolveMemberAccess('admin', profile) };
      expect((await read('', restricted)).status).toBe(403);
    }
    const viewer = { ...user, role: 'viewer' as const, permissions: ROLE_PERMISSIONS.viewer };
    expect((await read('', viewer)).status).toBe(200);
  });
});
