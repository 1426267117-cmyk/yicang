import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET, POST } from '../app/api/warehouse/opening-stock/route';
import { openSqliteD1 } from '../lib/aws/sqlite-d1';
import type { UserContext } from '../lib/db';
import { ROLE_PERMISSIONS } from '../lib/domain';
import { feishuProcurementPreviewInsertValues, feishuProcurementPreviewSchema, INSERT_FEISHU_PROCUREMENT_PREVIEW } from '../lib/feishu-procurement-preview-contract';
import { getOpeningStock, postOpeningStock } from '../lib/opening-stock';
import { getWarehousePage } from '../lib/warehouse-service';

const { requestContext } = vi.hoisted(() => ({ requestContext: vi.fn() }));
vi.mock('cloudflare:workers', () => ({ env: {} }));
vi.mock('../lib/db', async (original) => ({ ...await original<typeof import('../lib/db')>(), requestContext }));

const migrations = fileURLToPath(new URL('../drizzle/', import.meta.url));
const now = '2026-11-25T00:00:00.000Z';
const user: UserContext = { id: 'opening-test', email: 'opening@example.invalid', displayName: '测试', role: 'admin',
  tenantId: 'opening-gz', tenantName: '广州测试', permissions: ROLE_PERMISSIONS.admin };
const other = { ...user, tenantId: 'opening-sz', tenantName: '深圳测试' };
const operator: UserContext = { ...user, role: 'operator', permissions: ROLE_PERMISSIONS.operator };
const endpoint = 'https://erp.example.test/api/warehouse/opening-stock';

const sourceRow = { sku: 'CUTOVER-01', verifiedSales: 1, otherSales: null, storeCount: 1,
  ca: 12, ga: 0, nj: 3, stockTotal: 15, warehouseCount: 3, transitPcs: null, status: '销量与库存已配对' };
const preview = feishuProcurementPreviewSchema.parse({
  snapshotDate: '2026-11-25', salesStart: '2026-10-27', salesEnd: '2026-11-25',
  skus: [sourceRow, { ...sourceRow, sku: 'UNKNOWN-01' }, { ...sourceRow, sku: 'SHARED-01' },
    { ...sourceRow, sku: 'PARTIAL-01', status: '部分仓缺记录', warehouseCount: 2, nj: null, stockTotal: 12 }],
  storeSales: [], transit: [],
  review: [{ category: '深圳共销', source: '美国站库存 / CA', date: null, sku: 'SHARED-01', quantity: 12,
    unit: '件', reason: '仓库归属待核', evidence: '内部待核记录' }],
});

describe('期初库存只入当前公司尚未开账的 SKU 和仓库', () => {
  let local: ReturnType<typeof openSqliteD1>;
  let db: D1Database;
  let snapshotVersion: string;

  async function importSnapshot(snapshot = preview) {
    const values = await feishuProcurementPreviewInsertValues(user.tenantId, user.id, snapshot);
    await db.prepare(INSERT_FEISHU_PROCUREMENT_PREVIEW).bind(...values).run();
    return values[2];
  }

  function input() {
    return { snapshotVersion, sku: 'CUTOVER-01', region: 'CA' as const, skuId: 'opening-sku-gz', warehouseId: 'opening-ca-gz',
      quantity: 12, confirmed: true as const };
  }

  beforeEach(async () => {
    requestContext.mockReset();
    local = openSqliteD1(':memory:', migrations);
    db = local.db;
    for (const [context, suffix] of [[user, 'gz'], [other, 'sz']] as const) {
      await db.batch([
        db.prepare('INSERT INTO tenants (id, name, created_at) VALUES (?, ?, ?)').bind(context.tenantId, context.tenantName, now),
        db.prepare('INSERT INTO skus (id, tenant_id, code, name, created_at) VALUES (?, ?, ?, ?, ?)')
          .bind(`opening-sku-${suffix}`, context.tenantId, 'CUTOVER-01', '测试商品', now),
        db.prepare('INSERT INTO warehouses (id, tenant_id, code, name, created_at) VALUES (?, ?, ?, ?, ?)')
          .bind(`opening-ca-${suffix}`, context.tenantId, 'CA', '测试加州仓', now),
        db.prepare('INSERT INTO warehouses (id, tenant_id, code, name, created_at) VALUES (?, ?, ?, ?, ?)')
          .bind(`opening-ga-${suffix}`, context.tenantId, 'GA', '测试乔治亚仓', now),
      ]);
    }
    await db.prepare('INSERT INTO skus (id, tenant_id, code, name, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind('opening-partial-gz', user.tenantId, 'PARTIAL-01', '只有部分仓有记录的商品', now).run();
    snapshotVersion = await importSnapshot();
    requestContext.mockResolvedValue({ db, user });
  });
  afterEach(() => local?.close());

  it('仅工作区管理员可预览，区分未映射、归属待核和缺少分仓记录', async () => {
    const result = await GET(new Request(`${endpoint}?region=CA`));
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ snapshot: { date: preview.snapshotDate, version: snapshotVersion },
      rows: [{ sku: 'CUTOVER-01', region: 'CA', status: 'ready', quantity: 12, skuId: 'opening-sku-gz', warehouseId: 'opening-ca-gz' },
        { sku: 'PARTIAL-01', status: 'ready', quantity: 12 }, { sku: 'SHARED-01', status: 'source_unverified' },
        { sku: 'UNKNOWN-01', status: 'sku_unmapped' }] });
    expect(await getOpeningStock(db, user, { page: 1, q: 'cutover', region: 'NJ' })).toMatchObject({ rows: [{ status: 'warehouse_unmapped' }] });
    expect(await getOpeningStock(db, user, { page: 1, q: 'partial', region: 'NJ' })).toMatchObject({ rows: [{ status: 'source_unverified', quantity: null }] });
    expect(await getOpeningStock(db, other, { page: 1 })).toMatchObject({ snapshot: null, rows: [] });
    requestContext.mockResolvedValueOnce({ db, user: operator });
    expect((await GET(new Request(endpoint))).status).toBe(403);
    expect((await GET(new Request(`${endpoint}?page=1&page=2`))).status).toBe(400);
  });

  it('用原库存盘点流水核对后开账，重复请求留存一笔审计和一份余额', async () => {
    const submit = (body = input(), origin = new URL(endpoint).origin) => POST(new Request(endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'opening-stock-retry', Origin: origin },
      body: JSON.stringify(body),
    }));
    expect((await submit(input(), 'https://outside.example.test')).status).toBe(403);
    requestContext.mockResolvedValueOnce({ db, user: operator });
    expect((await submit()).status).toBe(403);
    expect((await submit({ ...input(), warehouseId: 'opening-ca-sz' })).status).toBe(409);
    expect((await submit({ ...input(), quantity: 120 })).status).toBe(409);
    const [first, replay] = await Promise.all([submit(), submit()]);
    expect([first.status, replay.status].sort()).toEqual([200, 201]);
    const both = await Promise.all([first.json(), replay.json()]) as { id: string }[];
    expect(both[0].id).toBe(both[1].id);
    expect(await db.prepare('SELECT on_hand_qty, reserved_qty, version, tenant_id FROM inventory_balances').first())
      .toEqual({ on_hand_qty: 12, reserved_qty: 0, version: 1, tenant_id: user.tenantId });
    expect(await db.prepare('SELECT COUNT(*) n FROM audit_logs WHERE action = ? AND actor_id = ?')
      .bind('POST_OPENING_WAREHOUSE_STOCK', user.id).first('n')).toBe(1);
    expect(await getWarehousePage(db, user, { kind: 'movements', page: 1, movement: 'opening' }))
      .toMatchObject({ rows: [{ type: 'opening', reference: both[0].id, onHandDelta: 12, reservedDelta: 0, beforeOnHandQty: 0, afterOnHandQty: 12 }] });
    expect(await db.prepare('SELECT COUNT(*) n FROM feishu_procurement_previews').first('n')).toBe(1);
    expect(await getOpeningStock(db, user, { page: 1, q: 'cutover', region: 'CA' }))
      .toMatchObject({ rows: [{ status: 'already_initialized' }] });
    await expect(postOpeningStock(db, user, input(), 'opening-stock-duplicate'))
      .rejects.toMatchObject({ status: 409 });
    const next = await importSnapshot({ ...preview, skus: [{ ...sourceRow, ca: 20, stockTotal: 23 }] });
    expect(await postOpeningStock(db, user, input(), 'opening-stock-retry')).toMatchObject({ replayed: true });
    await expect(postOpeningStock(db, user, { ...input(), snapshotVersion: next }, 'opening-stock-retry'))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('已有的零值余额保留，批次在预检和写入之间变化时不会落入账本', async () => {
    await db.prepare(`INSERT INTO inventory_balances (id, tenant_id, sku_id, warehouse_id, on_hand_qty, reserved_qty, version, updated_at)
      VALUES ('opening-existing-zero', ?, ?, 'opening-ga-gz', 0, 0, 0, ?)`)
      .bind(user.tenantId, input().skuId, now).run();
    await expect(postOpeningStock(db, user, { ...input(), region: 'GA', warehouseId: 'opening-ga-gz', quantity: 0 }, 'opening-existing-guard'))
      .rejects.toMatchObject({ status: 409 });
    const racing = new Proxy(db, {
      get(target, property) {
        if (property === 'batch') return async (statements: D1PreparedStatement[]) => {
          await importSnapshot({ ...preview, skus: [{ ...sourceRow, ca: 22, stockTotal: 25 }] });
          return target.batch(statements);
        };
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await expect(postOpeningStock(racing, user, input(), 'opening-race-guard'))
      .rejects.toMatchObject({ code: 'OPENING_STOCK_STATE_CHANGED' });
    await expect(postOpeningStock(db, user, input(), 'opening-stale-guard'))
      .rejects.toMatchObject({ code: 'OPENING_STOCK_STALE' });
    expect(await db.prepare('SELECT COUNT(*) n FROM warehouse_stock_counts').first('n')).toBe(0);
    expect(await db.prepare('SELECT COUNT(*) n FROM audit_logs').first('n')).toBe(0);
    expect((await db.prepare('SELECT warehouse_id, on_hand_qty FROM inventory_balances').all()).results)
      .toEqual([{ warehouse_id: 'opening-ga-gz', on_hand_qty: 0 }]);
  });
});
