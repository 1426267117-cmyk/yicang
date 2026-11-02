import { requirePermission, type UserContext } from './db';

export type PurchaseDemandStatus = 'needs_mapping' | 'open' | 'not_required';

type PurchaseDemandRow = {
  id: string;
  platform: string;
  connector_key: string;
  store_name: string;
  source_order_id: string;
  source_order_name: string | null;
  source_order_line_id: string;
  raw_sku: string | null;
  normalized_sku: string | null;
  mapped_sku_id: string | null;
  mapped_sku_code: string | null;
  mapped_sku_name: string | null;
  title: string | null;
  name: string | null;
  ordered_quantity: number;
  current_quantity: number | null;
  unfulfilled_quantity: number | null;
  required_quantity: number;
  status: PurchaseDemandStatus;
  reason_code: string | null;
  source_updated_at: string;
  first_seen_at: string;
  last_refreshed_at: string;
  updated_at: string;
};

type PurchaseDemandSummaryRow = {
  total: number;
  open_count: number;
  needs_mapping_count: number;
  not_required_count: number;
  open_quantity: number;
  needs_mapping_quantity: number;
};

export async function getPurchaseDemands(db: D1Database, user: UserContext) {
  requirePermission(user, 'orders:read');
  const [rows, summaryRow] = await Promise.all([
    db.prepare(`
      SELECT
        pd.id,
        pd.platform,
        ps.connector_key,
        ps.display_name AS store_name,
        pd.source_order_id,
        po.source_order_name,
        pd.source_order_line_id,
        pd.raw_sku,
        pd.normalized_sku,
        pd.mapped_sku_id,
        sku.code AS mapped_sku_code,
        sku.name AS mapped_sku_name,
        line.title,
        line.name,
        pd.ordered_quantity,
        pd.current_quantity,
        pd.unfulfilled_quantity,
        pd.required_quantity,
        pd.status,
        pd.reason_code,
        pd.source_updated_at,
        pd.first_seen_at,
        pd.last_refreshed_at,
        pd.updated_at
      FROM purchase_demands pd
      JOIN platform_stores ps
        ON ps.id = pd.platform_store_id AND ps.tenant_id = pd.tenant_id
      JOIN platform_orders po
        ON po.id = pd.order_id AND po.tenant_id = pd.tenant_id
      JOIN platform_order_lines line
        ON line.id = pd.order_line_id AND line.tenant_id = pd.tenant_id
      LEFT JOIN skus sku
        ON sku.id = pd.mapped_sku_id AND sku.tenant_id = pd.tenant_id
      WHERE pd.tenant_id = ?
      ORDER BY
        CASE pd.status WHEN 'open' THEN 0 WHEN 'needs_mapping' THEN 1 ELSE 2 END,
        pd.source_updated_at DESC,
        pd.source_order_id DESC,
        pd.source_order_line_id ASC
      LIMIT 500
    `).bind(user.tenantId).all<PurchaseDemandRow>(),
    db.prepare(`
      SELECT
        COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END), 0) AS open_count,
        COALESCE(SUM(CASE WHEN status = 'needs_mapping' THEN 1 ELSE 0 END), 0) AS needs_mapping_count,
        COALESCE(SUM(CASE WHEN status = 'not_required' THEN 1 ELSE 0 END), 0) AS not_required_count,
        COALESCE(SUM(CASE WHEN status = 'open' THEN required_quantity ELSE 0 END), 0) AS open_quantity,
        COALESCE(SUM(CASE WHEN status = 'needs_mapping' THEN required_quantity ELSE 0 END), 0) AS needs_mapping_quantity
      FROM purchase_demands
      WHERE tenant_id = ?
    `).bind(user.tenantId).first<PurchaseDemandSummaryRow>(),
  ]);

  const summary = summaryRow ?? {
    total: 0,
    open_count: 0,
    needs_mapping_count: 0,
    not_required_count: 0,
    open_quantity: 0,
    needs_mapping_quantity: 0,
  };

  return {
    ok: true as const,
    demands: rows.results.map((row) => ({
      id: row.id,
      platform: row.platform,
      storeKey: row.connector_key,
      storeName: row.store_name,
      sourceOrderId: row.source_order_id,
      sourceOrderName: row.source_order_name,
      sourceOrderLineId: row.source_order_line_id,
      rawSku: row.raw_sku,
      normalizedSku: row.normalized_sku,
      mappedSkuId: row.mapped_sku_id,
      mappedSkuCode: row.mapped_sku_code,
      mappedSkuName: row.mapped_sku_name,
      title: row.title,
      name: row.name,
      orderedQuantity: Number(row.ordered_quantity),
      currentQuantity: row.current_quantity === null ? null : Number(row.current_quantity),
      unfulfilledQuantity: row.unfulfilled_quantity === null ? null : Number(row.unfulfilled_quantity),
      requiredQuantity: Number(row.required_quantity),
      status: row.status,
      reasonCode: row.reason_code,
      sourceUpdatedAt: row.source_updated_at,
      firstSeenAt: row.first_seen_at,
      lastRefreshedAt: row.last_refreshed_at,
      updatedAt: row.updated_at,
    })),
    summary: {
      total: Number(summary.total),
      open: Number(summary.open_count),
      needsMapping: Number(summary.needs_mapping_count),
      notRequired: Number(summary.not_required_count),
      openQuantity: Number(summary.open_quantity),
      needsMappingQuantity: Number(summary.needs_mapping_quantity),
    },
    readOnly: true as const,
  };
}
