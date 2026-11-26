import { requirePermission, type UserContext } from './db';
import { feishuProcurementPreviewSchema, type FeishuProcurementPreview } from './feishu-procurement-preview-contract';
import type { ReportResult } from './report-contract';

type StoreSale = FeishuProcurementPreview['storeSales'][number];

export async function readFeishuSalesReport(db: D1Database, user: UserContext, generatedAt: string): Promise<ReportResult> {
  requirePermission(user, 'purchase:read');
  const stored = await db.prepare(`
    SELECT payload_json, imported_at FROM feishu_procurement_previews
    WHERE tenant_id = ?
    ORDER BY snapshot_date DESC, id DESC
    LIMIT 1
  `).bind(user.tenantId).first<{ payload_json: string; imported_at: string }>();
  if (!stored) return { ok: true, report: 'feishu-sales', window: null, snapshot: null, generatedAt, rows: [] };

  const source = feishuProcurementPreviewSchema.parse(JSON.parse(stored.payload_json));
  const window = { from: source.salesStart, to: source.salesEnd };
  const days = 1 + (Date.parse(`${window.to}T00:00:00Z`) - Date.parse(`${window.from}T00:00:00Z`)) / 86_400_000;
  const groups = new Map<string, StoreSale[]>();
  for (const row of source.storeSales) {
    const key = JSON.stringify([row.platform.toUpperCase(), row.store.toUpperCase()]);
    const existing = groups.get(key);
    if (existing) existing.push(row);
    else groups.set(key, [row]);
  }

  const rows = [...groups.values()].map((storeRows) => {
    const { platform, store, trustedDays } = storeRows[0];
    const validCoverage = trustedDays <= days && storeRows.every((row) => row.trustedDays === trustedDays);
    const gapDays = validCoverage ? days - trustedDays : null;
    return {
      platform, store,
      verified_sales: sumKnownCounts(storeRows, 'verifiedSales'),
      other_sales: sumKnownCounts(storeRows, 'otherSales'),
      sku_count: storeRows.length,
      trusted_days: validCoverage ? trustedDays : null,
      gap_days: gapDays,
      coverage_status: gapDays === null ? 'unknown' : gapDays === 0 ? 'complete' : 'partial',
      reported_stores: 1,
      store_with_gap: gapDays === null ? null : Number(gapDays > 0),
    };
  }).sort((left, right) => left.platform.localeCompare(right.platform, 'zh-CN') || left.store.localeCompare(right.store, 'zh-CN'));
  return {
    ok: true, report: 'feishu-sales', window, generatedAt, rows,
    snapshot: { date: source.snapshotDate, importedAt: stored.imported_at },
  };
}

function sumKnownCounts(rows: StoreSale[], field: 'verifiedSales' | 'otherSales') {
  let sum: bigint | null = null;
  for (const row of rows) {
    const value = row[field];
    if (value !== null) sum = (sum ?? BigInt(0)) + BigInt(value);
  }
  if (sum === null) return null;
  const asNumber = Number(sum);
  return Number.isSafeInteger(asNumber) ? asNumber : sum.toString();
}
