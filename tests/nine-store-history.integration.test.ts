import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openSqliteD1 } from '../lib/aws/sqlite-d1';
import type { UserContext } from '../lib/db';
import { ROLE_PERMISSIONS } from '../lib/domain';
import {
  nineStoreOrderQuerySchema, nineStoreOrderSnapshotSchema, nineStoreRoster, orderFeedTableKinds,
  type NineStoreOrderSnapshot,
} from '../lib/nine-store-orders-contract';
import { readNineStoreOrders, storeNineStoreOrderSnapshot } from '../lib/nine-store-orders-service';

vi.mock('cloudflare:workers', () => ({ env: {} }));

const migrations = fileURLToPath(new URL('../drizzle/', import.meta.url));
const now = new Date('2026-11-25T06:00:00.000Z');
const collected = '2026-11-25T05:00:00.000Z';
const refreshed = '2026-11-25T05:05:00.000Z';
const archived = '2026-11-25T05:10:00.000Z';
const usaStore = 'amazon-senyu';
const otherStore = 'shopify-kaguyasu';
const primaryTenant = 'history-guangzhou-test';
const otherTenant = 'history-shenzhen-test';
const row: NineStoreOrderSnapshot['orders'][number] = {
  recordId: 'recProofLine01', storeKey: usaStore, orderNo: 'TEST-ORDER-31', sku: 'TRACE-SKU',
  orderDate: '2026-11-25', quantity: 2, fulfillment: 'pending',
};
const secondOrder: NineStoreOrderSnapshot['orders'][number] = {
  ...row, storeKey: otherStore, orderNo: 'OTHER-STORE-ORDER-31', orderDate: '2026-11-28', fulfillment: null,
};
const refund: NineStoreOrderSnapshot['refunds'][number] = {
  recordId: row.recordId, storeKey: usaStore, orderNo: row.orderNo, sku: row.sku, refundDate: '2026-11-25',
};
let connection: ReturnType<typeof openSqliteD1>;

function user(tenantId = primaryTenant): UserContext {
  return { id: 'history-member', email: 'history@example.test', displayName: 'Test', role: 'operator',
    permissions: ROLE_PERMISSIONS.operator, tenantId, tenantName: tenantId };
}

function snapshot(observedAt: string, revision: string, orders: NineStoreOrderSnapshot['orders'], refunds: NineStoreOrderSnapshot['refunds']) {
  const stores = nineStoreRoster.map(([key, platform]) => ({ key, platform, name: key }));
  const tables = orderFeedTableKinds.map((kind) => {
    const accepted = kind === 'refunds' ? refunds.length
      : orders.filter((order) => `${stores.find((store) => store.key === order.storeKey)?.platform}-orders` === kind).length;
    return { kind, revision, read: accepted, accepted, outsideScope: 0, invalid: 0 };
  });
  return nineStoreOrderSnapshotSchema.parse({ version: 1, source: 'feishu-order-base', observedAt, stores, tables, orders, refunds });
}

function read(query: unknown, tenantId = primaryTenant) {
  return readNineStoreOrders(connection.db, user(tenantId), nineStoreOrderQuerySchema.parse(query));
}

beforeEach(async () => {
  connection = openSqliteD1(':memory:', migrations);
  for (const tenant of [primaryTenant, otherTenant]) {
    await connection.db.prepare('INSERT INTO tenants (id, name, created_at) VALUES (?, ?, ?)').bind(tenant, tenant, now.toISOString()).run();
  }
});
afterEach(() => connection.close());

describe('九店订单历史', () => {
  it('不存重复刷新，原子保留被修改的订单行与消失的退款行，拒绝倒退采集', async () => {
    const { db } = connection;
    await storeNineStoreOrderSnapshot(db, primaryTenant, snapshot(collected, '31', [row, secondOrder], [refund]), now);
    await storeNineStoreOrderSnapshot(db, primaryTenant, snapshot('2026-11-25T05:02:00.000Z', '31', [row, secondOrder], [refund]), now);
    await storeNineStoreOrderSnapshot(db, primaryTenant, snapshot(refreshed, '32', [row, secondOrder], [refund]), now);
    expect(await read({ scope: 'history' })).toMatchObject({ total: 0, rows: [] });

    const revision = snapshot(archived, '33', [{ ...row, fulfillment: 'shipped' }], []);
    await storeNineStoreOrderSnapshot(db, primaryTenant, revision, now);
    await expect(storeNineStoreOrderSnapshot(db, primaryTenant, revision, now)).resolves.toMatchObject({ replayed: true });
    await expect(storeNineStoreOrderSnapshot(db, primaryTenant, snapshot('2026-11-25T05:15:00.000Z', '31', [row], []), now))
      .rejects.toMatchObject({ code: 'NINE_STORE_SNAPSHOT_OUTDATED' });

    expect(await read({})).toMatchObject({ total: 1, rows: [{ orderNo: row.orderNo, fulfillment: 'shipped' }] });
    expect(await read({ section: 'refunds' })).toMatchObject({ total: 0, rows: [] });
    const history = await read({ scope: 'history' });
    expect(history.total).toBe(2);
    expect(history.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ storeKey: usaStore, orderDate: '2026-11-25', fulfillment: 'pending',
        history: { observedAt: refreshed, archivedAt: archived, change: 'updated' } }),
      expect.objectContaining({ storeKey: otherStore, orderDate: null, fulfillment: null,
        history: { observedAt: refreshed, archivedAt: archived, change: 'removed' } }),
    ]));
    expect(JSON.stringify(history)).not.toContain(row.recordId);
    expect(await read({ scope: 'history', section: 'refunds', search: row.orderNo })).toMatchObject({ total: 1,
      rows: [{ refundDate: '2026-11-25', history: { observedAt: refreshed, archivedAt: archived, change: 'removed' } }] });
    expect(await read({ scope: 'history', page: 2 })).toMatchObject({ total: 2, rows: [] });
    await storeNineStoreOrderSnapshot(db, otherTenant, snapshot(collected, '3', [row], []), now);
    expect(await read({ scope: 'history' }, otherTenant)).toMatchObject({ total: 0, snapshot: { observedAt: collected } });
    expect(await db.prepare('SELECT COUNT(*) FROM orders').first('COUNT(*)')).toBe(0);
  });

  it('只按可确认的日期和履约筛选，拒绝反向日期和退款履约条件', async () => {
    const { db } = connection;
    await storeNineStoreOrderSnapshot(db, primaryTenant, snapshot(collected, '31', [row, secondOrder], [refund]), now);
    const date = { from: '2026-11-25', through: '2026-11-25' };
    expect(await read({ ...date, fulfillment: 'pending', search: 'trace-sku' })).toMatchObject({ total: 1 });
    expect(await read({ ...date, fulfillment: 'unknown' })).toMatchObject({ total: 0 });
    expect(await read({ fulfillment: 'unknown' })).toMatchObject({ total: 1, rows: [{ storeKey: otherStore }] });
    await storeNineStoreOrderSnapshot(db, primaryTenant, snapshot(archived, '33', [], []), now);
    expect(await read({ scope: 'history', ...date, fulfillment: 'pending', store: usaStore })).toMatchObject({ total: 1 });
    expect(await read({ scope: 'history', ...date, fulfillment: 'unknown' })).toMatchObject({ total: 0 });
    expect(await read({ scope: 'history', ...date, section: 'refunds' })).toMatchObject({ total: 1 });
    expect(nineStoreOrderQuerySchema.safeParse({ from: '2026-11-26', through: '2026-11-25' }).success).toBe(false);
    expect(nineStoreOrderQuerySchema.safeParse({ section: 'refunds', fulfillment: 'unknown' }).success).toBe(false);
    expect(nineStoreOrderQuerySchema.safeParse({ from: '2026-02-30' }).success).toBe(false);
  });
});
