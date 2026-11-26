import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import { GET as readFeishuPreview } from '../app/api/purchase/feishu-preview/route';
import { openSqliteD1 } from '../lib/aws/sqlite-d1';
import type { UserContext } from '../lib/db';
import { ROLE_PERMISSIONS, type Role } from '../lib/domain';
import { createOrder, executeOrderAction, getErpPayload } from '../lib/erp-service';
import { feishuProcurementPreviewSchema } from '../lib/feishu-procurement-preview-contract';
import { claimFeishuSync, completeFeishuSync, FEISHU_SYNC_TENANT_ID } from '../lib/feishu-procurement-sync';
import { buildFeishuPilotCandidates, calculateFeishuPilot, feishuPilotSkuKey } from '../lib/feishu-replenishment-pilot';
import { addPurchaseInvoice, addPurchasePayment, getFinanceLedger } from '../lib/finance';
import { appendTrackingEvent, getTrackingHistory } from '../lib/logistics-service';
import { createPurchaseOrder, createPurchaseReceipt, createSupplier, createWarehouse, executePurchaseOrderAction } from '../lib/purchase-order-service';
import { createPurchaseReceiptCorrection } from '../lib/purchase-receipt-correction-service';
import { changePaymentRequest, getPaymentRequestDetails } from '../lib/purchase-payment-requests';
import { writePurchaseQuality } from '../lib/purchase-quality-service';
import { createPurchaseSku, findPurchaseSkus } from '../lib/purchase-sku-service';
import { createManualPurchaseRequest, executePurchaseRequestAction } from '../lib/purchase-workflow-service';
import { getSupplierQuoteBook, writeSupplierQuote } from '../lib/supplier-quotes';
import { recordWarehouseOutboundStep } from '../lib/warehouse-outbound-service';
import { getWarehousePage, recordWarehouseStockCount } from '../lib/warehouse-service';

const { requestContext } = vi.hoisted(() => ({ requestContext: vi.fn() }));
vi.mock('cloudflare:workers', () => ({ env: {} }));
vi.mock('../lib/db', async (original) => ({ ...await original<typeof import('../lib/db')>(), requestContext }));

const migrations = fileURLToPath(new URL('../drizzle/', import.meta.url));
const timestamp = '2026-11-25T06:00:00.000Z';
const skuCode = 'FLOW-SKU-01';
const preview = feishuProcurementPreviewSchema.parse({
  snapshotDate: '2026-11-25', salesStart: '2026-10-27', salesEnd: '2026-11-25',
  skus: [{ sku: skuCode, verifiedSales: 20, otherSales: null, storeCount: 2,
    ca: 0, ga: 0, nj: 0, stockTotal: 0, warehouseCount: 3, transitPcs: 6, status: '三仓确认可用为 0' }],
  storeSales: [
    { sku: skuCode, platform: 'Amazon', store: '测试亚马逊', verifiedSales: 12, otherSales: null, trustedDays: 24, averagePerDay: null },
    { sku: skuCode, platform: 'Shopify', store: '测试独立站', verifiedSales: 8, otherSales: null, trustedDays: 20, averagePerDay: null },
  ],
  transit: [{ sku: skuCode, region: '美西', arrivalDate: '2026-12-05', pcs: 6, batch: null, container: null }],
  review: [],
});

function actor(id: string, role: Role, tenantId = FEISHU_SYNC_TENANT_ID): UserContext {
  return { id, tenantId, tenantName: tenantId, role, displayName: id,
    email: `${id}@example.invalid`, permissions: ROLE_PERMISSIONS[role] };
}

it('从已同步的飞书补货试算延续同一 SKU 到采购、质检、出库和财务对账', async () => {
  const database = openSqliteD1(':memory:', migrations);
  vi.setSystemTime(new Date(timestamp));
  try {
    const { db } = database;
    const buyer = actor('flow-buyer', 'operator');
    const reviewer = actor('flow-reviewer', 'admin');
    const warehouseOperator = actor('flow-receiver', 'operator');
    const outside = actor('flow-outside', 'admin', 'erp-flow-shenzhen');
    await db.batch([
      ...[buyer, outside].map((user) => db.prepare('INSERT INTO tenants (id, name, created_at) VALUES (?, ?, ?)')
        .bind(user.tenantId, user.tenantName, timestamp)),
      ...[buyer, reviewer, warehouseOperator, outside].map((user) => db.prepare(`
        INSERT INTO members (id, tenant_id, auth_user_id, email, display_name, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(user.id, user.tenantId, user.id, user.email, user.displayName, user.role, timestamp)),
    ]);

    const claim = await claimFeishuSync(db);
    if (!claim) throw new Error('No Feishu worker lease');
    expect(await completeFeishuSync(db, claim.id, preview)).toEqual({ replayed: false });
    const source = new Request('https://erp.example.invalid/api/purchase/feishu-preview');
    requestContext.mockResolvedValueOnce({ db, user: buyer }).mockResolvedValueOnce({ db, user: outside });
    const imported = await readFeishuPreview(source);
    expect(imported.status).toBe(200);
    const result = await imported.json() as { snapshot: unknown };
    const snapshot = feishuProcurementPreviewSchema.parse(result.snapshot);
    expect(snapshot).toEqual(preview);
    expect(await (await readFeishuPreview(source)).json()).toMatchObject({ snapshot: null });

    const [candidate] = buildFeishuPilotCandidates(snapshot);
    const calculation = calculateFeishuPilot(candidate, snapshot.snapshotDate, 10, 5, true);
    expect(calculation).toMatchObject({ targetQty: 14, countedInboundQty: 6, recommendedQty: 8 });
    if (!calculation) throw new Error('No replenishment calculation');
    const { sku } = await createPurchaseSku(db, buyer, { code: skuCode, name: '验收商品' }, 'flow-test-new-sku');
    const matches = (await findPurchaseSkus(db, buyer, candidate.sku))
      .filter((item) => feishuPilotSkuKey(item.code) === feishuPilotSkuKey(candidate.sku));
    expect(matches).toEqual([sku]);
    const basis = `飞书 ${snapshot.snapshotDate} 快照，建议采购 ${calculation.recommendedQty} 件`;
    const input = { purchaserMemberId: buyer.id, reviewerMemberId: reviewer.id, note: basis,
      lines: [{ skuId: sku.id, quantity: calculation.recommendedQty }] };
    const { request } = await createManualPurchaseRequest(db, buyer, input, 'flow-test-request');
    expect(request).toMatchObject({ status: 'draft', note: basis, totalQuantity: 8,
      lines: [{ skuId: sku.id, requestedQuantity: 8 }] });
    expect(await createManualPurchaseRequest(db, buyer, input, 'flow-test-request'))
      .toMatchObject({ replayed: true, request: { id: request.id } });
    await executePurchaseRequestAction(db, buyer, request.id, { action: 'submit' }, 'flow-test-submit');
    await expect(executePurchaseRequestAction(db, buyer, request.id, { action: 'approve' }, 'flow-test-approve-denied'))
      .rejects.toMatchObject({ status: 403 });
    expect(await executePurchaseRequestAction(db, reviewer, request.id, { action: 'approve' }, 'flow-test-approve'))
      .toMatchObject({ request: { status: 'approved' } });

    const { supplier } = await createSupplier(db, buyer, { code: 'FLOW-SUPPLIER', name: '验收供应商' }, 'flow-test-supplier');
    const { warehouse } = await createWarehouse(db, buyer, { code: 'FLOW-WH', name: '验收入库仓' }, 'flow-test-warehouse');
    await writeSupplierQuote(db, buyer, { action: 'publish', skuId: sku.id, supplierId: supplier.id, currency: 'USD',
      expectedVersion: 0, validFrom: '2026-11-25', validThrough: '2026-12-31',
      tiers: [{ minimumQuantity: 1, unitCostMinor: 1500 }, { minimumQuantity: 8, unitCostMinor: 1234 }],
    }, 'flow-test-quote');
    const { quotes: [quote] } = await getSupplierQuoteBook(db, buyer, {
      skuId: sku.id, supplierId: supplier.id, currency: 'USD', quantity: request.totalQuantity,
    });
    expect(quote).toMatchObject({ supplier: { id: supplier.id }, matchedTier: { minimumQuantity: 8, unitCostMinor: 1234 }, totalMinor: '9872' });
    if (!quote.matchedTier) throw new Error('No matching quote tier');
    const { purchaseOrder } = await createPurchaseOrder(db, buyer, { purchaseRequestId: request.id, supplierId: supplier.id,
      deliveryWarehouseId: warehouse.id, expectedDeliveryAt: '2026-12-05', currency: quote.currency,
      lineCosts: [{ purchaseRequestLineId: request.lines[0].id, unitCostMinor: quote.matchedTier.unitCostMinor }],
    }, 'flow-test-purchase-order');
    expect(purchaseOrder).toMatchObject({ purchaseRequestId: request.id, orderedQuantity: 8, lines: [{ skuId: sku.id }] });
    await writePurchaseQuality(db, buyer, purchaseOrder.id, { action: 'require', reason: '本批全检' }, 'flow-test-require-quality');
    await executePurchaseOrderAction(db, buyer, purchaseOrder.id, { action: 'issue' }, 'flow-test-issue');
    const lineId = purchaseOrder.lines[0].id;
    await writePurchaseQuality(db, warehouseOperator, purchaseOrder.id, { action: 'inspect', batchReference: 'FLOW-LOT-01',
      lines: [{ purchaseOrderLineId: lineId, passedQty: 6, rejectedQty: 2, defectReason: '配件损坏' }],
    }, 'flow-test-inspection');
    const receive = (quantity: number, key: string) => createPurchaseReceipt(db, warehouseOperator, purchaseOrder.id,
      { warehouseId: warehouse.id, lines: [{ purchaseOrderLineId: lineId, quantity }] }, key);
    const inventory = async () => (await getErpPayload(db, warehouseOperator)).inventory;
    await expect(receive(8, 'flow-test-receipt-rejected')).rejects.toMatchObject({ code: 'PURCHASE_RECEIPT_QUALITY_LIMIT' });
    expect(await inventory()).toEqual([]);
    const firstReceipt = await receive(6, 'flow-test-receipt-approved');
    expect(firstReceipt).toMatchObject({ purchaseOrder: { status: 'partially_received', receivedQuantity: 6 } });
    expect(await receive(6, 'flow-test-receipt-approved')).toMatchObject({ replayed: true });
    expect(await inventory()).toMatchObject([{ skuId: sku.id, warehouseId: warehouse.id, onHandQty: 6, reservedQty: 0 }]);

    const { order: sale } = await createOrder(db, warehouseOperator, { warehouseId: warehouse.id, skuId: sku.id,
      channel: 'Amazon US', destination: '隔离测试目的地', customerName: '验收订单', currency: 'USD', amountMinor: 3000, quantity: 1,
    }, 'flow-test-sale');
    await executeOrderAction(db, reviewer, sale.id, 'approve', 'flow-test-reserve');
    expect(await inventory()).toMatchObject([{ onHandQty: 6, reservedQty: 1 }]);
    expect(await getWarehousePage(db, warehouseOperator, { kind: 'outbound', warehouse: warehouse.id, q: skuCode, page: 1 }))
      .toMatchObject({ rows: [{ id: sale.id, skuCode, quantity: 1 }] });
    await recordWarehouseOutboundStep(db, warehouseOperator, sale.id, { step: 'pick', expectedVersion: 0, quantity: 1 }, 'flow-test-pick');
    await recordWarehouseOutboundStep(db, warehouseOperator, sale.id, { step: 'verify', expectedVersion: 1, quantity: 1, skuCode }, 'flow-test-verify');
    await recordWarehouseOutboundStep(db, warehouseOperator, sale.id, { step: 'pack', expectedVersion: 2, packageCount: 1 }, 'flow-test-pack');
    await executeOrderAction(db, warehouseOperator, sale.id, 'ship', 'flow-test-ship');
    const { packageId } = await appendTrackingEvent(db, warehouseOperator, { orderId: sale.id, expectedVersion: 0,
      carrier: '验收承运商', trackingNumber: 'FLOW-TEST-TRACK-01', status: 'registered', note: '',
    }, 'flow-test-track');
    expect(await getTrackingHistory(db, warehouseOperator, packageId)).toMatchObject([{ status: 'registered' }]);
    expect(await inventory()).toMatchObject([{ onHandQty: 5, reservedQty: 0, availableQty: 5 }]);
    expect((await getErpPayload(db, outside)).inventory).toEqual([]);

    const { requestId: paymentRequest } = await changePaymentRequest(db, buyer, { action: 'create', orderId: purchaseOrder.id,
      amountMinor: 7404, currency: 'USD', businessType: 'balance', dueOn: '2026-12-05', reason: '六件合格货款',
    }, 'flow-test-payment-request');
    await changePaymentRequest(db, reviewer, { action: 'approve', requestId: paymentRequest, expectedVersion: 1 }, 'flow-test-approve-payment');
    expect((await getFinanceLedger(db, reviewer, purchaseOrder.id, 'payment', 1)).order.paidMinor).toBe('0');
    await addPurchaseInvoice(db, reviewer, { kind: 'invoice', purchaseOrderId: purchaseOrder.id, amountMinor: 7404,
      currency: 'USD', invoiceOn: '2026-11-25', reference: 'FLOW-TEST-INVOICE',
    }, 'flow-test-record-invoice');
    const { id: paymentId } = await addPurchasePayment(db, reviewer, { kind: 'payment', purchaseOrderId: purchaseOrder.id,
      amountMinor: 7404, currency: 'USD', paidAt: timestamp, reference: 'FLOW-TEST-PAYMENT',
    }, 'flow-test-record-payment');
    await changePaymentRequest(db, reviewer, { action: 'link', requestId: paymentRequest, expectedVersion: 2, paymentId }, 'flow-test-link-payment');
    expect((await getPaymentRequestDetails(db, reviewer, paymentRequest)).request)
      .toMatchObject({ orderId: purchaseOrder.id, status: 'approved', linkedMinor: '7404', outstandingMinor: '0' });
    expect((await getFinanceLedger(db, reviewer, purchaseOrder.id, 'invoice', 1)).order).toMatchObject({ orderedMinor: '9872',
      receivedMinor: '7404', invoicedMinor: '7404', paidMinor: '7404', invoiceOrderDifferenceMinor: '-2468',
      invoiceReceiptDifferenceMinor: '0', invoicePaymentDifferenceMinor: '0' });

    const { order: cancelledSale } = await createOrder(db, warehouseOperator, { warehouseId: warehouse.id, skuId: sku.id,
      channel: 'Amazon US', destination: '隔离测试地址', customerName: '不进入库存流水的客户名', currency: 'USD', amountMinor: 4500, quantity: 2,
    }, 'flow-test-sale-cancelled');
    await executeOrderAction(db, reviewer, cancelledSale.id, 'approve', 'flow-test-cancelled-reserve');
    await executeOrderAction(db, warehouseOperator, cancelledSale.id, 'cancel', 'flow-test-cancelled-release');
    const { receipt } = firstReceipt;
    const { correction } = await createPurchaseReceiptCorrection(db, warehouseOperator, receipt.id, {
      reason: '验收复盘少一件', lines: [{ purchaseReceiptLineId: receipt.lines[0].id, quantity: 1 }],
    }, 'flow-test-correction');
    const [beforeCount] = await inventory();
    expect(beforeCount).toMatchObject({ onHandQty: 4, reservedQty: 0 });
    const count = await recordWarehouseStockCount(db, warehouseOperator, { warehouseId: warehouse.id, skuId: sku.id,
      expectedVersion: beforeCount.version, countedQty: 7, reason: '验收复盘按实物调整' }, 'flow-test-stock-count');
    const query = { kind: 'movements', warehouse: warehouse.id, sku: sku.id, page: 1 } as const;
    const ledger = await getWarehousePage(db, warehouseOperator, query);
    if (ledger.kind !== 'movements') throw new Error('No inventory movement ledger');
    expect(ledger.rows).toHaveLength(7);
    expect(ledger.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'receipt', reference: receipt.receiptNo, purchaseOrderNo: purchaseOrder.orderNo, onHandDelta: 6, actor: warehouseOperator.displayName }),
      expect.objectContaining({ type: 'receipt_correction', reference: correction.correctionNo, originalReceiptNo: receipt.receiptNo, onHandDelta: -1, reason: '验收复盘少一件' }),
      expect.objectContaining({ type: 'ship', reference: sale.orderNo, onHandDelta: -1, reservedDelta: -1 }),
      expect.objectContaining({ type: 'release', reference: cancelledSale.orderNo, onHandDelta: 0, reservedDelta: -2 }),
      expect.objectContaining({ type: 'count', reference: count.id, beforeOnHandQty: 4, afterOnHandQty: 7, onHandDelta: 3 }),
    ]));
    expect(JSON.stringify(ledger)).not.toContain('不进入库存流水的客户名');
    const current = (await inventory())[0];
    expect(ledger.rows.reduce((sum, row) => sum + row.onHandDelta, 0)).toBe(current.onHandQty);
    expect(ledger.rows.reduce((sum, row) => sum + row.reservedDelta, 0)).toBe(current.reservedQty);
    expect(await getWarehousePage(db, warehouseOperator, { ...query, q: receipt.receiptNo.toLowerCase() }))
      .toMatchObject({ rows: expect.arrayContaining([expect.objectContaining({ type: 'receipt' }), expect.objectContaining({ type: 'receipt_correction' })]) });
    expect(await getWarehousePage(db, outside, query)).toMatchObject({ rows: [] });
  } finally {
    vi.useRealTimers();
    database.close();
  }
});
