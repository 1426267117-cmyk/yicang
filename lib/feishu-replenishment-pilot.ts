import type { FeishuProcurementPreview } from './feishu-procurement-preview-contract';

export const FEISHU_PILOT_LIMIT = 5;
export const FEISHU_PILOT_MAX_DAYS = 365;

const dayMilliseconds = 86_400_000;

export type FeishuPilotCandidate = {
  sku: string;
  availableQty: number;
  verifiedSales: number;
  dailySales: number;
  minTrustedDays: number;
  maxTrustedDays: number;
  verifiedStores: number;
  unverifiedStores: number;
  heldSalesRows: number;
  transit: Array<{ arrivalDate: string; pcs: number }>;
};

export type FeishuPilotPurchaseContext = {
  skuId: string | null;
  outstanding: number;
  pendingRequests: number;
};

export function feishuPilotSkuKey(sku: string) {
  return sku.trim().toUpperCase();
}

export function buildFeishuPilotCandidates(snapshot: FeishuProcurementPreview): FeishuPilotCandidate[] {
  const salesWindowDays = 1 + (Date.parse(snapshot.salesEnd) - Date.parse(snapshot.salesStart)) / dayMilliseconds;
  if (!Number.isInteger(salesWindowDays) || salesWindowDays <= 0) return [];

  const salesBySku = new Map<string, FeishuProcurementPreview['storeSales']>();
  for (const sale of snapshot.storeSales) {
    const key = feishuPilotSkuKey(sale.sku);
    const rows = salesBySku.get(key) ?? [];
    rows.push(sale);
    salesBySku.set(key, rows);
  }

  const transitBySku = new Map<string, FeishuPilotCandidate['transit']>();
  for (const shipment of snapshot.transit) {
    const key = feishuPilotSkuKey(shipment.sku);
    const rows = transitBySku.get(key) ?? [];
    rows.push({ arrivalDate: shipment.arrivalDate, pcs: shipment.pcs });
    transitBySku.set(key, rows);
  }

  const heldSalesBySku = new Map<string, number>();
  for (const row of snapshot.review) {
    if (row.category !== '销量待核' && row.category !== '归属待核') continue;
    if (row.source.includes('库存')) continue;
    const key = feishuPilotSkuKey(row.sku);
    heldSalesBySku.set(key, (heldSalesBySku.get(key) ?? 0) + 1);
  }

  const candidates: FeishuPilotCandidate[] = [];
  for (const row of snapshot.skus) {
    if (row.verifiedSales === null || row.verifiedSales <= 0 || row.warehouseCount !== 3 || row.status === '库存归属待核'
      || row.ca === null || row.ga === null || row.nj === null) continue;

    const availableQty = row.ca + row.ga + row.nj;
    if (!Number.isSafeInteger(availableQty) || availableQty !== row.stockTotal) continue;

    const key = feishuPilotSkuKey(row.sku);
    const allSales = salesBySku.get(key) ?? [];
    const confirmed = allSales.flatMap((sale) => sale.verifiedSales !== null && sale.verifiedSales > 0
      ? [{ units: sale.verifiedSales, days: sale.trustedDays }] : []);
    if (confirmed.reduce((sum, sale) => sum + sale.units, 0) !== row.verifiedSales
      || confirmed.some((sale) => !Number.isInteger(sale.days) || sale.days < 1 || sale.days > salesWindowDays)) continue;

    const trustedDays = confirmed.map((sale) => sale.days);
    candidates.push({
      sku: row.sku,
      availableQty,
      verifiedSales: row.verifiedSales,
      dailySales: confirmed.reduce((sum, sale) => sum + sale.units / sale.days, 0),
      minTrustedDays: Math.min(...trustedDays),
      maxTrustedDays: Math.max(...trustedDays),
      verifiedStores: confirmed.length,
      unverifiedStores: allSales.filter((sale) => !sale.verifiedSales && Boolean(sale.otherSales)).length,
      heldSalesRows: heldSalesBySku.get(key) ?? 0,
      transit: transitBySku.get(key) ?? [],
    });
  }

  return candidates.sort((left, right) => right.verifiedSales - left.verifiedSales || left.sku.localeCompare(right.sku));
}

export function calculateFeishuPilot(
  candidate: FeishuPilotCandidate,
  snapshotDate: string,
  leadDays: number,
  safetyDays: number,
  confirmInbound: boolean,
) {
  if (!validDayCount(leadDays, 1) || !validDayCount(safetyDays, 0)) return null;
  const snapshotTime = Date.parse(snapshotDate);
  if (!Number.isFinite(snapshotTime) || new Date(snapshotTime).toISOString().slice(0, 10) !== snapshotDate) return null;

  const cutoffDate = new Date(snapshotTime + leadDays * dayMilliseconds).toISOString().slice(0, 10);
  const eligibleInboundQty = candidate.transit.reduce((sum, shipment) => (
    shipment.arrivalDate >= snapshotDate && shipment.arrivalDate <= cutoffDate ? sum + shipment.pcs : sum
  ), 0);
  const countedInboundQty = confirmInbound ? eligibleInboundQty : 0;
  const targetQty = Math.ceil(Number((candidate.dailySales * (leadDays + safetyDays)).toFixed(9)));
  if (!Number.isSafeInteger(targetQty) || !Number.isSafeInteger(eligibleInboundQty)) return null;

  return {
    targetQty,
    cutoffDate,
    eligibleInboundQty,
    countedInboundQty,
    recommendedQty: Math.max(0, targetQty - candidate.availableQty - countedInboundQty),
  };
}

function validDayCount(value: number, minimum: number) {
  return Number.isInteger(value) && value >= minimum && value <= FEISHU_PILOT_MAX_DAYS;
}
