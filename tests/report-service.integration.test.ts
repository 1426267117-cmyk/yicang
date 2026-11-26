import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({ env: {} }));

import { GET } from '../app/api/reports/route';
import * as dbRuntime from '../lib/db';
import type { UserContext } from '../lib/db';
import type { FeishuProcurementPreview } from '../lib/feishu-procurement-preview-contract';
import { formatReportMinor, reportColumns } from '../lib/report-contract';
import { readErpReport, readReportFilters } from '../lib/report-service';

const window = { from: '2026-11-25', to: '2026-11-25' };
const generatedAt = '2026-11-25T03:00:00.000Z';
const user: UserContext = {
  id: 'report-user', tenantId: 'first', tenantName: '测试工作区',
  role: 'viewer', displayName: '测试账号', email: 'viewer@example.test',
  permissions: ['orders:read', 'purchase:read', 'connectors:read'],
};

describe('ERP 报表范围和汇总口径', () => {
  let runtime: Miniflare;
  let db: D1Database;

  beforeAll(async () => {
    runtime = new Miniflare({
      modules: true, script: 'export default { fetch() { return new Response("ok") } }', d1Databases: ['DB'],
    });
    db = await runtime.getD1Database('DB');
    await db.batch([
      `CREATE TABLE orders (tenant_id TEXT, channel TEXT, currency TEXT, status TEXT,
        quantity INTEGER, amount_minor INTEGER, created_at TEXT, customer_name TEXT)`,
      `CREATE TABLE platform_stores (id TEXT, tenant_id TEXT, platform TEXT, connector_key TEXT, display_name TEXT)`,
      `CREATE TABLE platform_orders (id TEXT, tenant_id TEXT, platform_store_id TEXT, platform TEXT, currency TEXT,
        current_total_minor INTEGER, test INTEGER, source_cancelled_at TEXT, business_date TEXT, source_created_at TEXT,
        fulfillment_status TEXT, financial_status TEXT, refunded_minor INTEGER)`,
      `CREATE TABLE platform_refunds (tenant_id TEXT, order_id TEXT, is_current INTEGER)`,
      `CREATE TABLE purchase_orders (id TEXT, tenant_id TEXT, status TEXT, created_at TEXT)`,
      `CREATE TABLE purchase_order_lines (tenant_id TEXT, purchase_order_id TEXT, ordered_quantity INTEGER, received_quantity INTEGER)`,
      `CREATE TABLE warehouses (id TEXT, tenant_id TEXT, code TEXT, name TEXT)`,
      `CREATE TABLE inventory_balances (tenant_id TEXT, warehouse_id TEXT, on_hand_qty INTEGER, reserved_qty INTEGER, updated_at TEXT)`,
      `CREATE TABLE feishu_procurement_previews (id INTEGER PRIMARY KEY, tenant_id TEXT, snapshot_date TEXT,
        imported_at TEXT, payload_json TEXT)`,
      `INSERT INTO orders VALUES
        ('first', 'Shopify', 'USD', 'shipped', 2, 1200, '2026-11-24T16:00:00.000Z', 'PRIVATE_CUSTOMER_MARKER'),
        ('first', 'Shopify', 'USD', 'cancelled', 4, 1400, '2026-11-25T15:59:59.999Z', ''),
        ('first', 'Shopify', 'USD', 'reserved', 8, 1800, '2026-11-25T16:00:00.000Z', ''),
        ('other', 'Shopify', 'USD', 'shipped', 9, 1900, '2026-11-25T02:00:00.000Z', '')`,
      `INSERT INTO platform_stores VALUES ('shop', 'first', 'shopify', 'a-shop', 'A 店'), ('other-shop', 'other', 'shopify', 'b-shop', 'B 店')`,
      `INSERT INTO platform_orders VALUES
        ('shopful', 'first', 'shop', 'shopify', 'JPY', 2200, 0, NULL, '2026-11-25', '2026-11-24T01:00:00.000Z', 'FULFILLED', 'PAID', 0),
        ('shoptest', 'first', 'shop', 'shopify', 'JPY', 9990, 1, NULL, '2026-11-25', '2026-11-25T00:00:00.000Z', 'CANCELLED', 'REFUNDED', 10),
        ('shopempty', 'first', 'shop', 'shopify', 'JPY', NULL, 0, NULL, NULL, '2026-11-24T16:00:00.000Z', NULL, NULL, NULL),
        ('external', 'other', 'other-shop', 'shopify', 'JPY', 9999, 0, NULL, '2026-11-25', '2026-11-25T00:00:00.000Z', 'FULFILLED', 'PAID', 0)`,
      `INSERT INTO purchase_orders VALUES
        ('open', 'first', 'partially_received', '2026-11-25T00:00:00.000Z'),
        ('closed', 'first', 'closed_short', '2026-11-25T00:00:00.000Z'),
        ('out', 'other', 'issued', '2026-11-25T00:00:00.000Z')`,
      `INSERT INTO purchase_order_lines VALUES ('first', 'open', 9, 2), ('first', 'open', 4, 1),
        ('first', 'closed', 3, 1), ('other', 'out', 10, 0)`,
      `INSERT INTO warehouses VALUES ('wh', 'first', 'US-1', '美国仓'), ('wh-other', 'other', 'US-2', '另一个仓')`,
      `INSERT INTO inventory_balances VALUES ('first', 'wh', 12, 3, '2026-11-25T00:00:00.000Z'),
        ('first', 'wh', 20, 2, '2026-11-25T01:00:00.000Z'), ('other', 'wh-other', 99, 5, '2026-11-25T00:00:00.000Z')`,
    ].map((statement) => db.prepare(statement)));
  });

  afterAll(async () => {
    await runtime?.dispose();
  });

  it('按北京时间日期边界汇总订单并剔除取消金额，不返回客户数据和其他工作区数据', async () => {
    const report = await readErpReport(db, user, 'orders', window, generatedAt);
    expect(report.rows).toEqual([{
      channel: 'Shopify', currency: 'USD', order_count: 2, pending_count: 0, reserved_count: 0,
      shipped_count: 1, cancelled_count: 1, active_qty: 2, amount_minor: '1200',
    }]);
    expect(JSON.stringify(report)).not.toContain('PRIVATE_CUSTOMER_MARKER');
  });

  it('以店铺业务日为准，将平台测试单和缺失金额与已知原币金额分开计量', async () => {
    const { rows } = await readErpReport(db, user, 'platform', window, generatedAt, { groupBy: 'store', store: 'shopify/a-shop' });
    expect(rows).toEqual([{
      platform: 'shopify', store: 'A 店', store_key: 'a-shop', currency: 'JPY', order_count: 3, active_count: 2,
      test_count: 1, cancelled_count: 0, missing_amount_count: 1, amount_minor: '2200',
      pending_count: 0, fulfilled_count: 1, unknown_status_count: 1, refund_count: 0,
    }]);
  });

  it('原生平台取消无须取消时间，有效状态可对账，退款记录不重复累计', async () => {
    await db.batch([
      db.prepare(`INSERT INTO platform_stores VALUES
        ('amz', 'first', 'amazon', 'amazon-senyu', 'A 店'), ('amz-same-name', 'first', 'amazon', 'amazon-genji', 'A 店'),
        ('amz-other', 'other', 'amazon', 'amazon-senyu', '他公司店')`),
      db.prepare(`INSERT INTO platform_orders VALUES
        ('amz-cancel', 'first', 'amz', 'amazon', 'KWD', 9900, 0, NULL, '2026-11-25', '2026-11-25T01:00:00.000Z', 'CANCELED', NULL, NULL),
        ('amz-cancel-alt', 'first', 'amz', 'amazon', 'KWD', 8800, 0, NULL, '2026-11-25', '2026-11-25T02:00:00.000Z', ' cancelled ', NULL, NULL),
        ('amz-pending', 'first', 'amz', 'amazon', 'KWD', 1234, 0, '', '2026-11-25', '2026-11-25T01:00:00.000Z', 'UNSHIPPED', NULL, NULL),
        ('amz-shipped', 'first', 'amz', 'amazon', 'KWD', 2345, 0, NULL, '2026-11-25', '2026-11-25T01:00:00.000Z', 'SHIPPED', 'PARTIALLY_REFUNDED', NULL),
        ('amz-unknown', 'first', 'amz', 'amazon', 'KWD', NULL, 0, NULL, '2026-11-25', '2026-11-25T01:00:00.000Z', 'FUTURE_STATUS', NULL, NULL),
        ('dated-cancel', 'first', 'amz', 'amazon', 'KWD', 5544, 0, '2026-11-25T04:00:00.000Z', '2026-11-25', '2026-11-25T01:00:00.000Z', 'UNSHIPPED', NULL, 100),
        ('day-before', 'first', 'amz', 'amazon', 'KWD', 3000, 0, NULL, '2026-11-24', '2026-11-25T01:00:00.000Z', 'SHIPPED', NULL, NULL),
        ('same-name', 'first', 'amz-same-name', 'amazon', 'KWD', 2222, 0, NULL, '2026-11-25', '2026-11-25T01:00:00.000Z', 'SHIPPED', NULL, NULL),
        ('bad-tenant', 'other', 'amz-other', 'amazon', 'KWD', 9999, 0, NULL, '2026-11-25', '2026-11-25T01:00:00.000Z', 'SHIPPED', NULL, NULL)`),
      db.prepare(`INSERT INTO platform_refunds VALUES ('first', 'amz-shipped', 1), ('first', 'amz-shipped', 1),
        ('other', 'amz-pending', 1), ('first', 'amz-pending', 0)`),
    ]);
    const scoped = await readErpReport(db, user, 'platform', window, generatedAt, { groupBy: 'store', store: 'amazon/amazon-senyu' });
    expect(scoped.rows).toEqual([{
      platform: 'amazon', store: 'A 店', store_key: 'amazon-senyu', currency: 'KWD', order_count: 6, active_count: 3, test_count: 0,
      cancelled_count: 3, pending_count: 1, fulfilled_count: 1, unknown_status_count: 1, refund_count: 2,
      missing_amount_count: 1, amount_minor: '3579',
    }]);
    expect(scoped.platform?.stores.filter(store => store.platform === 'amazon')).toEqual([
      { key: 'amazon/amazon-genji', name: 'A 店', platform: 'amazon' },
      { key: 'amazon/amazon-senyu', name: 'A 店', platform: 'amazon' },
    ]);
    expect(JSON.stringify(scoped)).not.toContain('他公司店');

    const auth = vi.spyOn(dbRuntime, 'requestContext').mockResolvedValue({ db, user });
    try {
      const endpoint = 'http://localhost/api/reports?report=platform&from=2026-11-24&to=2026-11-25';
      const response = await GET(new Request(`${endpoint}&store=amazon%2Famazon-senyu&groupBy=day`));
      expect(response.status).toBe(200);
      expect(response.headers.get('Cache-Control')).toBe('private, no-store');
      const daily = await response.json() as { rows: { business_day: string; amount_minor: string }[] };
      expect(daily.rows.map(({ business_day, amount_minor }) => [business_day, amount_minor]))
        .toEqual([['2026-11-25', '3579'], ['2026-11-24', '3000']]);
      expect((await GET(new Request(`${endpoint}&groupBy=hour`))).status).toBe(400);
    } finally { auth.mockRestore(); }
  });

  it('汇总大额时保留精度，按币种最小单位显示和导出', async () => {
    await db.batch([
      db.prepare(`INSERT INTO platform_stores VALUES ('large', 'first', 'shopify', 'large-store', '大额演练')`),
      db.prepare(`INSERT INTO platform_orders VALUES
        ('large-1', 'first', 'large', 'shopify', 'KWD', 5000000000000000001, 0, NULL, '2026-11-25', '2026-11-25T01:00:00.000Z', 'FULFILLED', NULL, NULL),
        ('large-2', 'first', 'large', 'shopify', 'KWD', 5000000000000000002, 0, NULL, '2026-11-25', '2026-11-25T01:00:00.000Z', 'FULFILLED', NULL, NULL),
        ('unknown-currency', 'first', 'large', 'shopify', 'ZZZ', 1500, 0, NULL, '2026-11-25', '2026-11-25T01:00:00.000Z', 'FULFILLED', NULL, NULL)`),
    ]);
    const report = await readErpReport(db, user, 'platform', window, generatedAt, { groupBy: 'store', store: 'shopify/large-store' });
    expect(report.rows).toMatchObject([
      { currency: 'KWD', amount_minor: '10000000000000000003', missing_amount_count: 0 },
      { currency: 'ZZZ', amount_minor: null, missing_amount_count: 1 },
    ]);
    expect(formatReportMinor('10000000000000000003', 'KWD', 'canonical')).toBe('10000000000000000.003');
    expect(formatReportMinor('2200', 'JPY', 'canonical')).toBe('2200');
    expect(formatReportMinor('2200', 'JPY', 'fixed-hundredths')).toBe('22.00');
    expect(formatReportMinor('-7', 'BHD', 'canonical')).toBe('-0.007');
    expect(formatReportMinor('1500', 'ZZZ', 'canonical')).toBeNull();
    expect(reportColumns('platform', 'day')[0].key).toBe('business_day');
    expect(reportColumns('platform', 'store').some(column => column.key === 'business_day')).toBe(false);
  });

  it('飞书快照按公司取最新并分店统计核验及待核值，覆盖冲突维持未知', async () => {
    const latest: FeishuProcurementPreview = {
      snapshotDate: '2026-11-25', salesStart: '2026-11-23', salesEnd: '2026-11-25', skus: [], transit: [],
      review: [{ category: '销量待核', source: '测试店', date: null, sku: 'PRIVATE_SKU_MARKER', quantity: null,
        unit: '件', reason: '待核', evidence: 'PRIVATE_EVIDENCE_MARKER' }],
      storeSales: [
        { platform: 'amazon', store: 'Amazon 测试店', sku: 'PRIVATE_SKU_1', verifiedSales: 5, otherSales: null, trustedDays: 2, averagePerDay: null },
        { platform: 'Amazon', store: 'Amazon 测试店', sku: 'PRIVATE_SKU_2', verifiedSales: null, otherSales: 99, trustedDays: 2, averagePerDay: null },
        { platform: 'wayfair', store: 'Wayfair 测试店', sku: 'PRIVATE_SKU_3', verifiedSales: null, otherSales: 8, trustedDays: 2, averagePerDay: null },
        { platform: 'wayfair', store: 'Wayfair 测试店', sku: 'PRIVATE_SKU_4', verifiedSales: null, otherSales: 9, trustedDays: 1, averagePerDay: null },
      ],
    };
    const emptySnapshot = { ...latest, snapshotDate: '2026-11-24', salesEnd: '2026-11-24', storeSales: [] };
    const insert = db.prepare('INSERT INTO feishu_procurement_previews (tenant_id, snapshot_date, imported_at, payload_json) VALUES (?, ?, ?, ?)');
    await db.batch([
      insert.bind(user.tenantId, latest.snapshotDate, generatedAt, JSON.stringify(latest)),
      insert.bind(user.tenantId, emptySnapshot.snapshotDate, '2026-11-26T00:00:00.000Z', JSON.stringify(emptySnapshot)),
      insert.bind('other-workspace', '2026-11-26', generatedAt, JSON.stringify({ ...latest, snapshotDate: '2026-11-26' })),
    ]);

    const report = await readErpReport(db, user, 'feishu-sales', null, generatedAt);
    expect(report.window).toEqual({ from: latest.salesStart, to: latest.salesEnd });
    expect(report.snapshot).toEqual({ date: latest.snapshotDate, importedAt: generatedAt });
    expect(report.rows).toEqual([
      { platform: 'amazon', store: 'Amazon 测试店', verified_sales: 5, other_sales: 99, sku_count: 2,
        trusted_days: 2, gap_days: 1, coverage_status: 'partial', reported_stores: 1, store_with_gap: 1 },
      { platform: 'wayfair', store: 'Wayfair 测试店', verified_sales: null, other_sales: 17, sku_count: 2,
        trusted_days: null, gap_days: null, coverage_status: 'unknown', reported_stores: 1, store_with_gap: null },
    ]);
    expect(JSON.stringify(report)).not.toContain('PRIVATE_');
    expect(await readErpReport(db, { ...user, tenantId: 'unset' }, 'feishu-sales', null, generatedAt))
      .toMatchObject({ snapshot: null, window: null, rows: [] });
    await expect(readErpReport(db, { ...user, permissions: ['orders:read'] }, 'feishu-sales', null, generatedAt))
      .rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(readReportFilters(new URLSearchParams({ report: 'feishu-sales' }), new Date(generatedAt)))
      .toEqual({ report: 'feishu-sales', window: null });
    expect(() => readReportFilters(new URLSearchParams({ report: 'feishu-sales', ...window }), new Date(generatedAt)))
      .toThrow();
  });

  it('采购明细不重复计算采购单，已结案短收数量未进入待到汇总，库存按仓读取账本', async () => {
    const [purchases, inventory] = await Promise.all([
      readErpReport(db, user, 'purchases', window, generatedAt),
      readErpReport(db, user, 'inventory', null, generatedAt),
    ]);
    expect(purchases.rows).toEqual([
      { status: 'partially_received', order_count: 1, ordered_qty: 13, received_qty: 3, issued_count: 1, pending_qty: 10 },
      { status: 'closed_short', order_count: 1, ordered_qty: 3, received_qty: 1, issued_count: 0, pending_qty: 0 },
    ]);
    expect(inventory.rows).toEqual([{
      warehouse_code: 'US-1', warehouse_name: '美国仓', sku_count: 2, on_hand_qty: 32, reserved_qty: 5,
      available_qty: 27, low_count: 1, latest_update: '2026-11-25T01:00:00.000Z',
    }]);
  });

  it('严格校验报表种类及日期，并执行报表对应的读取权限', async () => {
    const now = new Date('2026-11-24T16:00:00.000Z');
    expect(readReportFilters(new URLSearchParams('report=orders'), now)).toEqual({
      report: 'orders', window: { from: '2026-10-27', to: '2026-11-25' },
    });
    expect(() => readReportFilters(new URLSearchParams('report=orders&from=2026-11-31&to=2026-12-01'), now)).toThrow();
    expect(() => readReportFilters(new URLSearchParams('report=orders&report=inventory'), now)).toThrow();
    expect(() => readReportFilters(new URLSearchParams('report=inventory&from=2026-11-25'), now)).toThrow();
    await expect(readErpReport(db, { ...user, permissions: ['orders:read'] }, 'purchases', window, generatedAt))
      .rejects.toMatchObject({ status: 403 });
    await expect(readErpReport(db, { ...user, permissions: ['orders:read'] }, 'platform', window, generatedAt))
      .rejects.toMatchObject({ status: 403 });
  });
});
