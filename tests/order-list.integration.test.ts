import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { openSqliteD1 } from '../lib/aws/sqlite-d1';
import type { UserContext } from '../lib/db';
import { listOrders, orderListQuerySchema } from '../lib/erp-service';

vi.mock('cloudflare:workers', () => ({ env: {} }));

const now = '2026-11-25T00:00:00.000Z';
const viewer: UserContext = {
  id: 'order-list-viewer', email: 'viewer@example.invalid', displayName: '测试账号',
  role: 'viewer', tenantId: 'orders-gz', tenantName: '广州测试', permissions: ['orders:read'],
};

describe('运营订单查询', () => {
  let connection: ReturnType<typeof openSqliteD1>;
  let db: D1Database;

  beforeAll(async () => {
    connection = openSqliteD1(':memory:', fileURLToPath(new URL('../drizzle/', import.meta.url)));
    db = connection.db;
    for (const tenant of ['orders-gz', 'orders-sz']) {
      await db.batch([
        db.prepare('INSERT INTO tenants (id, name, created_at) VALUES (?, ?, ?)').bind(tenant, tenant, now),
        db.prepare('INSERT INTO skus (id, tenant_id, code, name, created_at) VALUES (?, ?, ?, ?, ?)')
          .bind(`sku-${tenant}`, tenant, 'CHAIR%1', '测试商品', now),
        db.prepare('INSERT INTO warehouses (id, tenant_id, code, name, created_at) VALUES (?, ?, ?, ?, ?)')
          .bind(`wh-${tenant}`, tenant, 'W-01', '测试仓库', now),
      ]);
    }
    const insert = db.prepare(`
      INSERT INTO orders (id, tenant_id, order_no, idempotency_key, request_hash, channel, destination,
        customer_name, currency, amount_minor, status, sku_id, warehouse_id, quantity, version, created_by,
        updated_by, last_action_key, request_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'hash', 'Amazon US', '美国', 'PRIVATE_CUSTOMER_MATCH', 'USD', 100, ?, ?, ?, 1, 1,
        'tester', 'tester', ?, ?, ?, ?)
    `);
    await db.batch(Array.from({ length: 106 }, (_, index) => {
      const suffix = String(index).padStart(3, '0');
      const tenant = index === 105 ? 'orders-sz' : 'orders-gz';
      return insert.bind(`o-${suffix}`, tenant, `YC-${suffix}`, `create-${suffix}`, index === 1 ? 'shipped' : 'pending_review',
        `sku-${tenant}`, `wh-${tenant}`, `create-${suffix}`, `request-${suffix}`, now, now);
    }));
  });

  afterAll(() => connection?.close());

  it('稳定分页覆盖超过最近 100 条的订单，空页依然返回准确总数', async () => {
    const page = await listOrders(db, viewer, orderListQuerySchema.parse({ page: '4' }));
    expect(page).toMatchObject({ total: 105, pageSize: 30 });
    expect(page.orders.map((order) => order.orderNo)).toEqual(Array.from({ length: 15 }, (_, index) => `YC-${String(14 - index).padStart(3, '0')}`));
    expect(await listOrders(db, viewer, orderListQuerySchema.parse({ page: '5' }))).toEqual({ orders: [], total: 105, pageSize: 30 });
  });

  it('同时应用状态、普通文本搜索和工作区范围，排除客户姓名搜索', async () => {
    const results = await listOrders(db, viewer, orderListQuerySchema.parse({ status: 'shipped', q: '  chair%  ' }));
    expect(results).toMatchObject({ total: 1, orders: [{ status: 'shipped', orderNo: 'YC-001' }] });
    for (const q of ['PRIVATE_CUSTOMER_MATCH', 'chair_1', 'YC-105']) {
      expect(await listOrders(db, viewer, orderListQuerySchema.parse({ q }))).toEqual({ orders: [], total: 0, pageSize: 30 });
    }
    expect((await listOrders(db, viewer, orderListQuerySchema.parse({ q: 'w-01' }))).total).toBe(105);
    await expect(listOrders(db, { ...viewer, permissions: [] }, orderListQuerySchema.parse({})))
      .rejects.toMatchObject({ status: 403, code: 'PERMISSION_DENIED' });
  });
});
