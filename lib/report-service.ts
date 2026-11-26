import { cancelledFulfillmentStatuses, completedFulfillmentStatuses, pendingFulfillmentStatuses } from './channel-order-status';
import { decimalToMinor } from './connectors/canonical';
import { HttpError, requirePermission, type UserContext } from './db';
import {
  defaultPlatformReportFilters, defaultReportWindow, isSnapshotReport, reportKinds,
  type PlatformReportFilters, type ReportKind, type ReportResult, type ReportRow, type ReportStoreOption, type ReportWindow,
} from './report-contract';
import { readFeishuSalesReport } from './report-feishu-sales';

const dayInMilliseconds = 86_400_000;

const reportStatements: Record<Exclude<ReportKind, 'feishu-sales' | 'platform'>, string> = {
  orders: `
    SELECT channel, currency, COUNT(*) AS order_count,
      SUM(status = 'pending_review') AS pending_count,
      SUM(status = 'reserved') AS reserved_count,
      SUM(status = 'shipped') AS shipped_count,
      SUM(status = 'cancelled') AS cancelled_count,
      SUM(CASE WHEN status <> 'cancelled' THEN quantity ELSE 0 END) AS active_qty,
      CAST(SUM(CASE WHEN status <> 'cancelled' THEN amount_minor ELSE 0 END) AS TEXT) AS amount_minor
    FROM orders
    WHERE tenant_id = ? AND created_at >= ? AND created_at < ?
    GROUP BY channel, currency ORDER BY channel, currency`,
  purchases: `
    WITH order_totals AS (
      SELECT po.id, po.status, COALESCE(SUM(l.ordered_quantity), 0) AS ordered_qty,
        COALESCE(SUM(l.received_quantity), 0) AS received_qty
      FROM purchase_orders po
      LEFT JOIN purchase_order_lines l ON l.tenant_id = po.tenant_id AND l.purchase_order_id = po.id
      WHERE po.tenant_id = ? AND po.created_at >= ? AND po.created_at < ?
      GROUP BY po.id, po.status
    )
    SELECT status, COUNT(*) AS order_count, SUM(ordered_qty) AS ordered_qty, SUM(received_qty) AS received_qty,
      SUM(status IN ('issued', 'partially_received')) AS issued_count,
      SUM(CASE WHEN status IN ('issued', 'partially_received') THEN ordered_qty - received_qty ELSE 0 END) AS pending_qty
    FROM order_totals
    GROUP BY status
    ORDER BY CASE status WHEN 'draft' THEN 1 WHEN 'issued' THEN 2 WHEN 'partially_received' THEN 3
      WHEN 'received' THEN 4 WHEN 'closed_short' THEN 5 WHEN 'cancelled' THEN 6 ELSE 7 END, status`,
  inventory: `
    SELECT w.code AS warehouse_code, w.name AS warehouse_name,
      COUNT(*) AS sku_count, SUM(b.on_hand_qty) AS on_hand_qty, SUM(b.reserved_qty) AS reserved_qty,
      SUM(b.on_hand_qty - b.reserved_qty) AS available_qty,
      SUM(b.on_hand_qty - b.reserved_qty <= 10) AS low_count, MAX(b.updated_at) AS latest_update
    FROM inventory_balances b
    JOIN warehouses w ON w.id = b.warehouse_id AND w.tenant_id = b.tenant_id
    WHERE b.tenant_id = ? GROUP BY w.id, w.code, w.name ORDER BY w.code`,
};

type ReportFilters = { report: ReportKind; window: ReportWindow | null; platform?: PlatformReportFilters };

export function readReportFilters(params: URLSearchParams, now: Date): ReportFilters {
  const report = reportKinds.find((kind) => kind === params.get('report'));
  const keys = report === 'platform' ? ['report', 'from', 'to', 'store', 'groupBy'] : ['report', 'from', 'to'];
  if (!report || [...new Set(params.keys())].length !== params.size
    || [...params.keys()].some((key) => !keys.includes(key))) {
    throw new HttpError(400, '请选择有效的报表类型', 'REPORT_FILTER_INVALID');
  }

  const from = params.get('from');
  const to = params.get('to');
  if (isSnapshotReport(report)) {
    if (from !== null || to !== null) throw invalidDateRange();
    return { report, window: null };
  }
  const platform = report === 'platform' ? { platform: readPlatformFilters(params) } : {};
  if (from === null && to === null) return { report, window: defaultReportWindow(now), ...platform };
  if (from === null || to === null) throw invalidDateRange();
  const fromUtc = parseReportDate(from);
  const toUtc = parseReportDate(to);
  if (!Number.isFinite(fromUtc) || !Number.isFinite(toUtc) || toUtc < fromUtc
    || toUtc - fromUtc > 365 * dayInMilliseconds) {
    throw invalidDateRange();
  }
  return { report, window: { from, to }, ...platform };
}

function readPlatformFilters(params: URLSearchParams): PlatformReportFilters {
  const store = params.get('store');
  const groupBy = params.get('groupBy') ?? 'store';
  if ((groupBy !== 'store' && groupBy !== 'day') || (store !== null && !/^(shopify|amazon|wayfair|yqn)\/[A-Za-z0-9_.-]{1,100}$/u.test(store))) {
    throw new HttpError(400, '请检查平台、店铺和汇总方式', 'REPORT_PLATFORM_FILTER_INVALID');
  }
  return { groupBy, ...(store ? { store } : {}) };
}

export async function readErpReport(
  db: D1Database,
  user: UserContext,
  report: ReportKind,
  window: ReportWindow | null,
  generatedAt: string,
  platformFilters = defaultPlatformReportFilters,
): Promise<ReportResult> {
  if (report === 'feishu-sales') return readFeishuSalesReport(db, user, generatedAt);
  requirePermission(user, report === 'purchases' ? 'purchase:read' : 'orders:read');
  if (report === 'platform') {
    requirePermission(user, 'connectors:read');
    if (!window) throw invalidDateRange();
    return readPlatformOrderReport(db, user.tenantId, window, generatedAt, platformFilters);
  }

  const bindings = [user.tenantId];
  if (window && (report === 'orders' || report === 'purchases')) {
    const start = Date.parse(`${window.from}T00:00:00+08:00`);
    const end = Date.parse(`${window.to}T00:00:00+08:00`) + dayInMilliseconds;
    bindings.push(new Date(start).toISOString(), new Date(end).toISOString());
  }
  const { results } = await db.prepare(reportStatements[report]).bind(...bindings).all<ReportRow>();
  return { ok: true, report, window, generatedAt, rows: results };
}

const sqlEnum = (values: readonly string[]) => `(${values.map(value => `'${value}'`).join(', ')})`;
// Split stored integers before summing so values above SQLite's integer range still aggregate exactly.
const amountBase = 1_000_000_000;
const validAmount = `bucket NOT IN ('test', 'cancelled') AND currency IS NOT NULL`;
const businessDay = `COALESCE(NULLIF(TRIM(po.business_date), ''), date(po.source_created_at, '+8 hours'))`;

async function readPlatformOrderReport(db: D1Database, tenantId: string, window: ReportWindow, generatedAt: string, filters: PlatformReportFilters): Promise<ReportResult> {
  const day = filters.groupBy === 'day' ? ', business_day' : '';
  const storeFilter = filters.store ? 'AND ps.platform = ? AND ps.connector_key = ?' : '';
  const [summary, stores] = await db.batch<ReportRow | ReportStoreOption>([
    db.prepare(`WITH in_scope AS (
      SELECT po.platform, ps.display_name AS store, ps.connector_key AS store_key, ps.id AS store_id,
        ${businessDay} AS business_day,
        NULLIF(UPPER(TRIM(po.currency)), '') AS currency,
        CASE WHEN typeof(po.current_total_minor) = 'integer' THEN po.current_total_minor END AS amount_minor,
        CASE WHEN COALESCE(po.test, 0) = 1 THEN 'test'
          WHEN NULLIF(TRIM(po.source_cancelled_at), '') IS NOT NULL
            OR UPPER(TRIM(po.fulfillment_status)) IN ${sqlEnum(cancelledFulfillmentStatuses)} THEN 'cancelled'
          WHEN UPPER(TRIM(po.fulfillment_status)) IN ${sqlEnum(pendingFulfillmentStatuses)} THEN 'pending'
          WHEN UPPER(TRIM(po.fulfillment_status)) IN ${sqlEnum(completedFulfillmentStatuses)} THEN 'fulfilled'
          ELSE 'unknown' END AS bucket,
        (COALESCE(po.refunded_minor, 0) > 0 OR COALESCE(UPPER(TRIM(po.financial_status)), '') IN ('REFUNDED', 'PARTIALLY_REFUNDED')
          OR EXISTS (SELECT 1 FROM platform_refunds refund WHERE refund.tenant_id = po.tenant_id AND refund.order_id = po.id AND refund.is_current = 1)) AS has_refund
      FROM platform_orders po
      JOIN platform_stores ps ON ps.id = po.platform_store_id AND ps.tenant_id = po.tenant_id AND ps.platform = po.platform
      WHERE po.tenant_id = ? ${storeFilter}
        AND ${businessDay} BETWEEN ? AND ?
    )
    SELECT platform, store, store_key, currency${day}, COUNT(*) AS order_count,
      SUM(bucket NOT IN ('test', 'cancelled')) AS active_count,
      SUM(bucket = 'test') AS test_count, SUM(bucket = 'cancelled') AS cancelled_count,
      SUM(bucket = 'pending') AS pending_count, SUM(bucket = 'fulfilled') AS fulfilled_count,
      SUM(bucket = 'unknown') AS unknown_status_count, SUM(bucket <> 'test' AND has_refund) AS refund_count,
      SUM(bucket NOT IN ('test', 'cancelled') AND (amount_minor IS NULL OR currency IS NULL)) AS missing_amount_count,
      CAST(SUM(CASE WHEN ${validAmount} THEN amount_minor / ${amountBase} END) AS TEXT) AS amount_high,
      CAST(SUM(CASE WHEN ${validAmount} THEN amount_minor % ${amountBase} END) AS TEXT) AS amount_low
    FROM in_scope
    GROUP BY platform, store_id, store, store_key, currency${day}
    ORDER BY ${day ? 'business_day DESC, ' : ''}platform, store, currency, store_id`)
      .bind(tenantId, ...(filters.store?.split('/') ?? []), window.from, window.to),
    db.prepare(`SELECT platform || '/' || connector_key AS key, platform, display_name AS name
      FROM platform_stores WHERE tenant_id = ? ORDER BY platform, name, connector_key`).bind(tenantId),
  ]);
  const rows = (summary.results as ReportRow[]).map(({ amount_high, amount_low, ...row }) => {
    const knownCurrency = typeof row.currency === 'string' && decimalToMinor('1', row.currency) !== null;
    const amount = amount_high !== null && amount_low !== null && knownCurrency
      ? (BigInt(amount_high) * BigInt(amountBase) + BigInt(amount_low)).toString() : null;
    return { ...row, missing_amount_count: knownCurrency ? row.missing_amount_count : row.active_count, amount_minor: amount };
  });
  return { ok: true, report: 'platform', window, generatedAt, rows, platform: { filters, stores: stores.results as ReportStoreOption[] } };
}

function parseReportDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return NaN;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value ? time : NaN;
}

function invalidDateRange() {
  return new HttpError(400, '请选择有效日期，最多可查询 366 天', 'REPORT_DATE_RANGE_INVALID');
}
