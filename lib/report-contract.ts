import { decimalToMinor } from './connectors/canonical';

export const reportKinds = ['orders', 'platform', 'purchases', 'inventory', 'feishu-sales'] as const;
export type ReportKind = (typeof reportKinds)[number];
export type ReportWindow = { from: string; to: string };
export type PlatformReportFilters = { store?: string; groupBy: 'store' | 'day' };
export type ReportStoreOption = { key: string; platform: string; name: string };
export const defaultPlatformReportFilters: PlatformReportFilters = { groupBy: 'store' };
export type ReportRow = Record<string, string | number | null>;
export type ReportResult = {
  ok: true;
  report: ReportKind;
  window: ReportWindow | null;
  generatedAt: string;
  snapshot?: { date: string; importedAt: string } | null;
  platform?: { filters: PlatformReportFilters; stores: ReportStoreOption[] };
  rows: ReportRow[];
};

export type ReportMinorEncoding = 'fixed-hundredths' | 'canonical';
type ReportColumn = { key: string; label: string; minorAmount?: ReportMinorEncoding };
type ReportDefinition = {
  label: string;
  source: string;
  columns: ReportColumn[];
  summary: ReportColumn[];
};

export const reportDefinitions: Record<ReportKind, ReportDefinition> = {
  orders: {
    label: '系统订单',
    source: '按订单创建日（北京时间）筛选。按渠道、原币汇总，件数和订单金额均剔除取消单。',
    columns: [
      { key: 'channel', label: '渠道' }, { key: 'currency', label: '币种' },
      { key: 'order_count', label: '订单' }, { key: 'pending_count', label: '待审核' },
      { key: 'reserved_count', label: '待发货' }, { key: 'shipped_count', label: '已发货' },
      { key: 'cancelled_count', label: '已取消' }, { key: 'active_qty', label: '有效订单件数' },
      { key: 'amount_minor', label: '有效订单金额', minorAmount: 'fixed-hundredths' },
    ],
    summary: [
      { key: 'order_count', label: '订单总数' }, { key: 'pending_count', label: '待审核' },
      { key: 'reserved_count', label: '待发货' }, { key: 'shipped_count', label: '已发货' },
    ],
  },
  platform: {
    label: '平台订单',
    source: '统计平台直连订单。优先使用店铺业务日，缺失时用创建日（北京时间）。有效订单及金额剔除测试单和取消单。退款数按已保存的证据统计，可与履约或取消状态重合。',
    columns: [
      { key: 'platform', label: '平台' }, { key: 'store', label: '店铺' }, { key: 'currency', label: '币种' },
      { key: 'order_count', label: '已入库订单' }, { key: 'active_count', label: '有效订单' },
      { key: 'pending_count', label: '待发货' }, { key: 'fulfilled_count', label: '已发货' },
      { key: 'unknown_status_count', label: '状态待核' }, { key: 'cancelled_count', label: '已取消' },
      { key: 'refund_count', label: '有退款记录' }, { key: 'test_count', label: '测试单' },
      { key: 'missing_amount_count', label: '缺金额或币种' },
      { key: 'amount_minor', label: '当前订单额', minorAmount: 'canonical' },
    ],
    summary: [
      { key: 'order_count', label: '已入库订单' }, { key: 'cancelled_count', label: '已取消' },
      { key: 'pending_count', label: '待发货' }, { key: 'fulfilled_count', label: '已发货' },
      { key: 'unknown_status_count', label: '状态待核' }, { key: 'refund_count', label: '有退款记录' },
    ],
  },
  purchases: {
    label: '采购执行',
    source: '按采购单创建日（北京时间）筛选，展示采购单当前状态。实收数量已扣除冲正，待到仅统计已下达及部分到货的采购单。',
    columns: [
      { key: 'status', label: '状态' }, { key: 'order_count', label: '采购单' },
      { key: 'ordered_qty', label: '明细件数' }, { key: 'received_qty', label: '实收件数' },
      { key: 'pending_qty', label: '待到件数' },
    ],
    summary: [
      { key: 'order_count', label: '采购单总数' }, { key: 'issued_count', label: '执行中采购单' },
      { key: 'received_qty', label: '实收件数' }, { key: 'pending_qty', label: '待到件数' },
    ],
  },
  inventory: {
    label: '仓库库存',
    source: '使用当前 ERP 库存账本。低库存统计可售量不超过 10 件的 SKU 仓库记录。',
    columns: [
      { key: 'warehouse_code', label: '仓库编码' }, { key: 'warehouse_name', label: '仓库' },
      { key: 'sku_count', label: 'SKU 数' }, { key: 'on_hand_qty', label: '现存件数' },
      { key: 'reserved_qty', label: '预占件数' }, { key: 'available_qty', label: '可售件数' },
      { key: 'low_count', label: '低库存 SKU 数' }, { key: 'latest_update', label: '账本最后更新' },
    ],
    summary: [
      { key: 'on_hand_qty', label: '现存件数' }, { key: 'reserved_qty', label: '预占件数' },
      { key: 'available_qty', label: '可售件数' }, { key: 'low_count', label: '低库存记录' },
    ],
  },
  'feishu-sales': {
    label: '飞书店铺销量',
    source: '按平台和店铺汇总最近保存的飞书采购快照。只列快照中有 SKU 销量记录的店铺。核验件数与待核件数分列，未出现的店铺覆盖待核。',
    columns: [
      { key: 'platform', label: '平台' }, { key: 'store', label: '店铺' },
      { key: 'verified_sales', label: '已核验件数' }, { key: 'other_sales', label: '待核件数' },
      { key: 'sku_count', label: '快照 SKU 数' }, { key: 'trusted_days', label: '已核验天数' },
      { key: 'gap_days', label: '覆盖缺口天数' }, { key: 'coverage_status', label: '覆盖状态' },
    ],
    summary: [
      { key: 'verified_sales', label: '已核验件数' }, { key: 'other_sales', label: '待核件数' },
      { key: 'reported_stores', label: '快照所列店铺' }, { key: 'store_with_gap', label: '已知覆盖有缺口的店铺' },
    ],
  },
};

export function reportColumns(report: ReportKind, groupBy?: PlatformReportFilters['groupBy']) {
  const columns = reportDefinitions[report].columns;
  return report === 'platform' && groupBy === 'day' ? [{ key: 'business_day', label: '店铺业务日' }, ...columns] : columns;
}

export function formatReportMinor(value: string | number, currency: string, encoding: ReportMinorEncoding) {
  const amount = String(value);
  if (!/^-?\d+$/u.test(amount) || !/^[A-Z]{3}$/u.test(currency)) return null;
  const scale = encoding === 'fixed-hundredths' ? 100 : decimalToMinor('1', currency);
  if (scale === null) return null;
  const digits = String(scale).length - 1;
  if (digits === 0) return amount;
  const negative = amount.startsWith('-');
  const absolute = (negative ? amount.slice(1) : amount).padStart(digits + 1, '0');
  return `${negative ? '-' : ''}${absolute.slice(0, -digits)}.${absolute.slice(-digits)}`;
}

export function isSnapshotReport(report: ReportKind) {
  return report === 'inventory' || report === 'feishu-sales';
}

export function defaultReportWindow(now = new Date()): ReportWindow {
  const beijing = new Date(now.getTime() + 8 * 60 * 60 * 1_000);
  const to = beijing.toISOString().slice(0, 10);
  beijing.setUTCDate(beijing.getUTCDate() - 29);
  return { from: beijing.toISOString().slice(0, 10), to };
}
