import { z } from 'zod';

export const FEISHU_PROCUREMENT_PREVIEW_MAX_BYTES = 768 * 1024;

const shortText = z.string().trim().min(1).max(160);
const quantity = z.int().nullable();
const stock = z.int().nonnegative().nullable();
const date = z.iso.date();

export const feishuProcurementPreviewSchema = z.strictObject({
  snapshotDate: date,
  salesStart: date,
  salesEnd: date,
  skus: z.array(z.strictObject({
    sku: shortText,
    verifiedSales: quantity,
    otherSales: quantity,
    storeCount: z.int().nonnegative(),
    ca: stock,
    ga: stock,
    nj: stock,
    stockTotal: stock,
    warehouseCount: z.int().min(0).max(3),
    transitPcs: stock,
    status: shortText,
  })).max(5000),
  storeSales: z.array(z.strictObject({
    sku: shortText,
    platform: shortText,
    store: shortText,
    verifiedSales: quantity,
    otherSales: quantity,
    trustedDays: z.int().nonnegative(),
    averagePerDay: z.number().nullable(),
  })).max(15000),
  transit: z.array(z.strictObject({
    sku: shortText,
    region: shortText,
    arrivalDate: date,
    pcs: z.int().nonnegative(),
    batch: shortText.nullable(),
    container: shortText.nullable(),
  })).max(5000),
  review: z.array(z.strictObject({
    category: shortText,
    source: shortText,
    date: date.nullable(),
    sku: shortText,
    quantity,
    unit: shortText,
    reason: z.string().trim().min(1).max(1000),
    evidence: z.string().trim().max(1000),
  })).max(15000),
}).superRefine((snapshot, context) => {
  if (snapshot.salesStart > snapshot.salesEnd || snapshot.salesEnd > snapshot.snapshotDate) {
    context.addIssue({ code: 'custom', message: '销售区间与快照日期不一致', path: ['salesEnd'] });
  }
  const skus = new Set<string>();
  snapshot.skus.forEach((row, index) => {
    const key = row.sku.toUpperCase();
    if (skus.has(key)) {
      context.addIssue({ code: 'custom', message: 'SKU 重复', path: ['skus', index, 'sku'] });
    }
    skus.add(key);
  });
  const storeKeys = new Set<string>();
  snapshot.storeSales.forEach((row, index) => {
    const key = JSON.stringify([row.sku, row.platform, row.store].map((value) => value.toUpperCase()));
    if (storeKeys.has(key)) {
      context.addIssue({ code: 'custom', message: '店铺 SKU 重复', path: ['storeSales', index, 'sku'] });
    }
    storeKeys.add(key);
  });
});

export type FeishuProcurementPreview = z.infer<typeof feishuProcurementPreviewSchema>;

export const INSERT_FEISHU_PROCUREMENT_PREVIEW = `
  INSERT INTO feishu_procurement_previews
    (tenant_id, snapshot_date, payload_hash, payload_json, imported_by, imported_at)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT (tenant_id, payload_hash) DO NOTHING
`;

export async function feishuProcurementPreviewInsertValues(
  tenantId: string,
  importedBy: string,
  snapshot: FeishuProcurementPreview,
) {
  const payloadJson = JSON.stringify(snapshot);
  const bytes = new TextEncoder().encode(payloadJson);
  if (bytes.byteLength > FEISHU_PROCUREMENT_PREVIEW_MAX_BYTES) {
    throw new RangeError('FEISHU_PROCUREMENT_PREVIEW_TOO_LARGE');
  }
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const payloadHash = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('');
  return [tenantId, snapshot.snapshotDate, payloadHash, payloadJson, importedBy, new Date().toISOString()];
}
