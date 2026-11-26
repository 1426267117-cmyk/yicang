import { describe, expect, it } from 'vitest';
import type { FeishuProcurementPreview } from '../lib/feishu-procurement-preview-contract';
import { buildFeishuPilotCandidates, calculateFeishuPilot } from '../lib/feishu-replenishment-pilot';

const zeroStockSku = {
  sku: 'SKU-1', verifiedSales: 20, otherSales: 40, storeCount: 3,
  ca: 0, ga: 0, nj: 0, stockTotal: 0, warehouseCount: 3,
  transitPcs: 66, status: '三仓确认可用为 0',
};

const preview: FeishuProcurementPreview = {
  snapshotDate: '2026-11-25', salesStart: '2026-10-27', salesEnd: '2026-11-25',
  skus: [zeroStockSku],
  storeSales: [
    { sku: 'SKU-1', platform: 'Amazon', store: 'A', verifiedSales: 12, otherSales: null, trustedDays: 24, averagePerDay: null },
    { sku: 'SKU-1', platform: 'Amazon', store: 'B', verifiedSales: 8, otherSales: null, trustedDays: 20, averagePerDay: null },
    { sku: 'SKU-1', platform: 'Amazon', store: 'C', verifiedSales: null, otherSales: 40, trustedDays: 20, averagePerDay: null },
  ],
  transit: [
    { sku: 'SKU-1', region: '美东', arrivalDate: '2026-11-24', pcs: 20, batch: null, container: null },
    { sku: 'SKU-1', region: '美西', arrivalDate: '2026-12-05', pcs: 6, batch: null, container: null },
    { sku: 'SKU-1', region: '美东', arrivalDate: '2026-12-06', pcs: 40, batch: null, container: null },
  ],
  review: [],
};

describe('Guangzhou Feishu replenishment pilot', () => {
  it('keeps verified zero stock and estimates sales using each confirmed store’s own coverage', () => {
    const [candidate] = buildFeishuPilotCandidates(preview);
    expect(candidate).toMatchObject({
      availableQty: 0, verifiedSales: 20, dailySales: 0.9, minTrustedDays: 20, maxTrustedDays: 24,
      verifiedStores: 2, unverifiedStores: 1,
    });
  });

  it('holds warehouse gaps, ownership exceptions and sales without matching verified detail', () => {
    expect(buildFeishuPilotCandidates({ ...preview, skus: [{ ...zeroStockSku, nj: null }] })).toEqual([]);
    expect(buildFeishuPilotCandidates({ ...preview, skus: [{ ...zeroStockSku, status: '库存归属待核' }] })).toEqual([]);
    expect(buildFeishuPilotCandidates({ ...preview, skus: [{ ...zeroStockSku, verifiedSales: 21 }] })).toEqual([]);
  });

  it('counts only confirmed inbound up to and including the lead-time date', () => {
    const [candidate] = buildFeishuPilotCandidates(preview);
    expect(calculateFeishuPilot(candidate, preview.snapshotDate, 10, 5, false)).toEqual({
      targetQty: 14, cutoffDate: '2026-12-05', eligibleInboundQty: 6, countedInboundQty: 0, recommendedQty: 14,
    });
    expect(calculateFeishuPilot(candidate, preview.snapshotDate, 10, 5, true)).toMatchObject({
      countedInboundQty: 6, recommendedQty: 8,
    });
    expect(calculateFeishuPilot(candidate, preview.snapshotDate, 0, 5, true)).toBeNull();
  });
});
