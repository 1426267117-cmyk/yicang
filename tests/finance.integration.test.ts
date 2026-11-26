import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { GET, POST } from '../app/api/finance/route';
import { POST as POST_INVOICE } from '../app/api/finance/invoices/route';
import { openSqliteD1 } from '../lib/aws/sqlite-d1';
import { HttpError, type UserContext } from '../lib/db';
import { ROLE_PERMISSIONS, type Role } from '../lib/domain';
import { createOrder, executeOrderAction } from '../lib/erp-service';
import { addPurchaseInvoice, addPurchasePayment, getFinanceLedger, type FinanceLedger, type FinanceWorkspace } from '../lib/finance';
import { appendTrackingEvent, getTrackingHistory, listManualLogistics } from '../lib/logistics-service';
import { createPurchaseOrder, createPurchaseReceipt, createSupplier, createWarehouse, executePurchaseOrderAction } from '../lib/purchase-order-service';
import { createPurchaseSku } from '../lib/purchase-sku-service';
import { createManualPurchaseRequest, executePurchaseRequestAction } from '../lib/purchase-workflow-service';
import { getWarehouseOutbound, recordWarehouseOutboundStep } from '../lib/warehouse-outbound-service';

const { requestContext } = vi.hoisted(() => ({ requestContext: vi.fn() }));
vi.mock('cloudflare:workers', () => ({ env: {} }));
vi.mock('../lib/db', async (original) => ({ ...await original<typeof import('../lib/db')>(), requestContext }));

const endpoint = 'https://erp.example.invalid/api/finance';
const issueDate = '2026-06-01T08:00:00.000Z';
const paymentDate = '2026-06-02T08:00:00.000Z';
const reversalDate = '2026-06-03T08:00:00.000Z';

function member(tenantId: string, role: Role): UserContext {
  const id = `${tenantId}-${role}`;
  return { id, tenantId, tenantName: tenantId, displayName: id, email: `${id}@example.invalid`, role, permissions: ROLE_PERMISSIONS[role] };
}

const financeAdmin = member('finance-main', 'admin');
const buyer = member(financeAdmin.tenantId, 'operator');
const otherAdmin = member('finance-other', 'admin');
const otherBuyer = member(otherAdmin.tenantId, 'operator');

async function seedProcurement(db: D1Database, purchaser: UserContext, reviewer: UserContext, currency: string, large = false) {
  await db.batch([
    db.prepare('INSERT INTO tenants (id, name, created_at) VALUES (?, ?, ?)').bind(reviewer.tenantId, reviewer.tenantName, issueDate),
    ...[purchaser, reviewer].map((user) => db.prepare(`
      INSERT INTO members (id, tenant_id, auth_user_id, email, display_name, role, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(user.id, user.tenantId, user.id, user.email, user.displayName, user.role, issueDate)),
  ]);
  const lineCount = large ? 10 : 1;
  const skus = [];
  for (let index = 0; index < lineCount; index += 1) {
    const { sku } = await createPurchaseSku(db, purchaser, { code: `FINANCE-SKU-${index}`, name: '测试商品' }, `finance-create-sku-${index}`);
    skus.push(sku);
  }
  const { warehouse } = await createWarehouse(db, purchaser, { code: 'FINANCE-WH', name: '测试仓' }, 'finance-create-warehouse');
  const { supplier } = await createSupplier(db, purchaser, { code: 'FINANCE-SUPPLIER', name: '测试供应商' }, 'finance-create-supplier');
  const { request } = await createManualPurchaseRequest(db, purchaser, {
    purchaserMemberId: purchaser.id, reviewerMemberId: reviewer.id, note: '采购财务测试',
    lines: skus.map((sku) => ({ skuId: sku.id, quantity: large ? 100_000_000 : 5 })),
  }, 'finance-create-request');
  await executePurchaseRequestAction(db, purchaser, request.id, { action: 'submit' }, 'finance-submit-request');
  await executePurchaseRequestAction(db, reviewer, request.id, { action: 'approve' }, 'finance-approve-request');
  const { purchaseOrder } = await createPurchaseOrder(db, purchaser, {
    purchaseRequestId: request.id, supplierId: supplier.id, deliveryWarehouseId: warehouse.id,
    expectedDeliveryAt: '2026-12-01', currency,
    lineCosts: request.lines.map((line) => ({ purchaseRequestLineId: line.id, unitCostMinor: large ? 10_000_000_000 : 1250 })),
  }, 'finance-create-purchase-order');
  await executePurchaseOrderAction(db, purchaser, purchaseOrder.id, { action: 'issue' }, 'finance-issue-purchase-order');
  await createPurchaseReceipt(db, purchaser, purchaseOrder.id, {
    warehouseId: warehouse.id, lines: [{ purchaseOrderLineId: purchaseOrder.lines[0].id, quantity: 2 }],
  }, 'finance-receive-purchase-order');
  return { purchaseOrderId: purchaseOrder.id, warehouseId: warehouse.id, skuId: purchaseOrder.lines[0].skuId, skuCode: purchaseOrder.lines[0].skuCode };
}

function get(query = '') {
  return GET(new Request(`${endpoint}${query}`));
}

function post(body: object, key: string) {
  return POST(new Request(endpoint, { method: 'POST', headers: { 'Idempotency-Key': key }, body: JSON.stringify(body) }));
}

function invoiceEntry(body: object, key: string) {
  return POST_INVOICE(new Request(`${endpoint}/invoices`, { method: 'POST', headers: { 'Idempotency-Key': key }, body: JSON.stringify(body) }));
}

describe('采购财务和实付台账', () => {
  let sqlite: ReturnType<typeof openSqliteD1>;
  let orderId: string;
  let outsideOrderId: string;

  function signIn(user: UserContext) {
    requestContext.mockResolvedValue({ db: sqlite.db, user });
  }

  beforeAll(async () => {
    sqlite = openSqliteD1(':memory:', resolve('drizzle'));
    ({ purchaseOrderId: orderId } = await seedProcurement(sqlite.db, buyer, financeAdmin, 'USD'));
    ({ purchaseOrderId: outsideOrderId } = await seedProcurement(sqlite.db, otherBuyer, otherAdmin, 'CNY', true));
  });

  afterAll(() => sqlite?.close());

  it('按登录工作区和管理角色限制对账范围，保留货值与支付事实的区别', async () => {
    requestContext.mockRejectedValueOnce(new HttpError(401, '请先登录', 'AUTH_REQUIRED'));
    expect((await get()).status).toBe(401);
    signIn(buyer);
    expect((await get()).status).toBe(403);
    signIn(financeAdmin);
    expect((await get(`?orderId=${outsideOrderId}`)).status).toBe(404);
    expect((await get('?tenantId=finance-other')).status).toBe(400);
    const response = await get('?scope=all&search=测试供应商');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    const report = await response.json() as FinanceWorkspace;
    expect(report).toMatchObject({ ok: true, total: 1, currencies: [{ currency: 'USD', orderCount: 1 }] });
    expect(report.orders).toEqual([expect.objectContaining({ id: orderId, orderedMinor: '6250', receivedMinor: '2500', paidMinor: '0', paymentCount: 0 })]);
  });

  it('追加实付与冲正，拒绝错误币种和超额冲正，并在并发重试时按同一凭证键只记一次', async () => {
    signIn(financeAdmin);
    const payment = { kind: 'payment', purchaseOrderId: orderId, amountMinor: 3000, currency: 'USD', paidAt: paymentDate, reference: '付款凭证 A' };
    expect((await post({ ...payment, currency: 'CNY' }, 'finance-bad-currency')).status).toBe(409);
    expect((await post({ ...payment, purchaseOrderId: outsideOrderId }, 'finance-other-tenant')).status).toBe(404);
    const replies = await Promise.all([post(payment, 'finance-payment-idem'), post(payment, 'finance-payment-idem')]);
    expect(replies.map((response) => response.status).sort()).toEqual([200, 201]);
    const [first, replay] = await Promise.all(replies.map(async (response) => await response.json() as { id: string }));
    expect(first.id).toBe(replay.id);
    expect((await post({ ...payment, amountMinor: 3001 }, 'finance-payment-idem')).status).toBe(409);
    const reversal = { ...payment, kind: 'reversal', originalPaymentId: first.id, paidAt: reversalDate, amountMinor: 2000, reference: '冲正凭证 B' };
    const reversals = await Promise.all([post(reversal, 'finance-reversal-one'), post(reversal, 'finance-reversal-two')]);
    expect(reversals.map((response) => response.status).sort()).toEqual([201, 409]);
    const ledger = await (await get(`?orderId=${orderId}`)).json() as FinanceLedger;
    expect(ledger.order).toMatchObject({ orderedMinor: '6250', receivedMinor: '2500', paidMinor: '1000', differenceMinor: '5250', paymentCount: 2 });
    expect(ledger.entries).toEqual([
      expect.objectContaining({ kind: 'reversal', amountMinor: '2000', originalReference: '付款凭证 A' }),
      expect.objectContaining({ kind: 'payment', amountMinor: '3000', reversibleMinor: '1000' }),
    ]);
    const audit = await sqlite.db.prepare("SELECT action FROM audit_logs WHERE tenant_id = ? AND entity_type = 'purchase_payment' ORDER BY action")
      .bind(financeAdmin.tenantId).all();
    expect(audit.results).toEqual([{ action: 'purchase_payment_recorded' }, { action: 'purchase_payment_reversed' }]);
  });

  it('保留超大合同货值的精度，并按原币核对实付、发票以及冲正', async () => {
    const invoice = { kind: 'invoice', purchaseOrderId: outsideOrderId, amountMinor: 3000,
      currency: 'CNY', invoiceOn: '2026-06-02', reference: 'INV-TS-01' };
    signIn(financeAdmin);
    expect((await invoiceEntry(invoice, 'finance-foreign-invoice')).status).toBe(404);
    signIn(otherBuyer);
    expect((await invoiceEntry(invoice, 'finance-denied-invoice')).status).toBe(403);
    signIn(otherAdmin);
    const amount = '10000000000000000000';
    const report = await (await get()).json() as FinanceWorkspace;
    expect(report.currencies).toEqual([expect.objectContaining({ currency: 'CNY', orderedMinor: amount, receivedMinor: '20000000000' })]);
    expect(report.orders).toEqual([expect.objectContaining({ id: outsideOrderId, orderedMinor: amount })]);

    const payment = { kind: 'payment', purchaseOrderId: outsideOrderId, amountMinor: 1000,
      currency: 'CNY', paidAt: paymentDate, reference: 'PAY-TS-01' };
    expect((await post(payment, 'finance-invoice-seed-payment')).status).toBe(201);
    expect((await invoiceEntry({ ...invoice, currency: 'USD' }, 'finance-invoice-wrong-currency')).status).toBe(409);
    const recorded = await invoiceEntry(invoice, 'finance-record-invoice');
    expect(recorded.status).toBe(201);
    const { id } = await recorded.json() as { id: string };
    expect((await invoiceEntry(invoice, 'finance-record-invoice')).status).toBe(200);
    expect((await invoiceEntry({ ...invoice, reference: invoice.reference.toLowerCase() }, 'finance-duplicate-invoice')).status).toBe(409);
    const reversal = { ...invoice, kind: 'reversal', originalInvoiceId: id,
      invoiceOn: '2026-06-03', amountMinor: 500, reference: 'CREDIT-TS-01' };
    expect((await invoiceEntry(reversal, 'finance-invoice-reversal')).status).toBe(201);
    expect((await invoiceEntry(reversal, 'finance-invoice-reversal-dup')).status).toBe(409);
    const ledger = await (await get(`?orderId=${outsideOrderId}&ledger=invoice`)).json() as FinanceLedger;
    expect(ledger.order).toMatchObject({
      orderedMinor: amount, paidMinor: '1000', invoicedMinor: '2500', invoiceCount: 2,
      invoiceOrderDifferenceMinor: '-9999999999999997500', invoiceReceiptDifferenceMinor: '-19999997500', invoicePaymentDifferenceMinor: '1500',
    });
    expect(ledger.entries).toEqual([
      expect.objectContaining({ kind: 'reversal', amountMinor: '500', originalReference: 'INV-TS-01' }),
      expect.objectContaining({ kind: 'invoice', amountMinor: '3000', reversibleMinor: '2500' }),
    ]);
    const audit = await sqlite.db.prepare("SELECT action FROM audit_logs WHERE tenant_id = ? AND entity_type = 'purchase_invoice' ORDER BY action")
      .bind(otherAdmin.tenantId).all();
    expect(audit.results).toEqual([{ action: 'purchase_invoice_recorded' }, { action: 'purchase_invoice_reversed' }]);
  });
});

it('实付登记按同一采购单原币余额约束并发，并在冲正后恢复可登记额度', async () => {
  const database = openSqliteD1(':memory:', resolve('drizzle'));
  try {
    const { db } = database;
    const admin = member('payment-cap', 'admin');
    const operator = member(admin.tenantId, 'operator');
    const { purchaseOrderId } = await seedProcurement(db, operator, admin, 'USD');
    const payment = { kind: 'payment', purchaseOrderId, amountMinor: 4000, currency: 'USD', paidAt: paymentDate } as const;
    const payments = await Promise.allSettled([
      addPurchasePayment(db, admin, { ...payment, reference: 'CAP-PAYMENT-A' }, 'finance-cap-payment-a'),
      addPurchasePayment(db, admin, { ...payment, reference: 'CAP-PAYMENT-B' }, 'finance-cap-payment-b'),
    ]);
    const completed = payments.find((result) => result.status === 'fulfilled');
    expect(completed?.value.replayed).toBe(false);
    expect(payments.find((result) => result.status === 'rejected')?.reason).toMatchObject({ code: 'FINANCE_PAYMENT_BALANCE_EXCEEDED' });
    const first = await getFinanceLedger(db, admin, purchaseOrderId, 'payment', 1);
    expect(first.order).toMatchObject({ paidMinor: '4000', differenceMinor: '2250', paymentCount: 1 });
    expect(first.entries).toHaveLength(1);
    await expect(addPurchasePayment(db, admin, { ...payment, amountMinor: 100, reference: first.entries[0].reference.toLowerCase() }, 'finance-cap-duplicate'))
      .rejects.toMatchObject({ code: 'DUPLICATE_FINANCE_REFERENCE' });
    const balance = { ...payment, amountMinor: 2250, reference: 'CAP-PAYMENT-FINAL' };
    const exact = await addPurchasePayment(db, admin, balance, 'finance-cap-payment-final');
    await expect(addPurchasePayment(db, admin, balance, 'finance-cap-payment-final')).resolves.toMatchObject({ id: exact.id, replayed: true });
    expect((await getFinanceLedger(db, admin, purchaseOrderId, 'payment', 1)).order)
      .toMatchObject({ paidMinor: '6250', differenceMinor: '0', canRecordPayment: false, canRecordInvoice: true });
    await addPurchasePayment(db, admin, { ...balance, kind: 'reversal', originalPaymentId: exact.id, amountMinor: 25,
      paidAt: reversalDate, reference: 'CAP-PAYMENT-REVERSAL' }, 'finance-cap-payment-reversal');
    expect((await getFinanceLedger(db, admin, purchaseOrderId, 'payment', 1)).order)
      .toMatchObject({ paidMinor: '6225', differenceMinor: '25', canRecordPayment: true });
    await addPurchasePayment(db, admin, { ...payment, amountMinor: 25, reference: 'CAP-PAYMENT-CORRECTED' }, 'finance-cap-payment-corrected');
    await db.prepare('UPDATE purchase_order_lines SET unit_cost_minor = NULL WHERE purchase_order_id = ?').bind(purchaseOrderId).run();
    await expect(addPurchasePayment(db, admin, { ...payment, reference: 'CAP-PAYMENT-UNPRICED' }, 'finance-cap-payment-unpriced'))
      .rejects.toMatchObject({ code: 'FINANCE_PAYMENT_AMOUNT_UNKNOWN' });
    expect((await getFinanceLedger(db, admin, purchaseOrderId, 'payment', 1)).order)
      .toMatchObject({ paidMinor: '6250', differenceMinor: null, paymentCount: 4, canRecordPayment: false, canRecordInvoice: true });
  } finally {
    database.close();
  }
});

it('从供应商采购到销售出库、签收与财务对账，库存只在采购收货和确认出库时增减', async () => {
  const database = openSqliteD1(':memory:', resolve('drizzle'));
  try {
    const { db } = database;
    const admin = member('flow-main', 'admin');
    const operator = member(admin.tenantId, 'operator');
    const { purchaseOrderId, warehouseId, skuId, skuCode } = await seedProcurement(db, operator, admin, 'USD');
    const inventory = () => db.prepare(`
      SELECT on_hand_qty, reserved_qty FROM inventory_balances
      WHERE tenant_id = ? AND warehouse_id = ? AND sku_id = ?
    `).bind(admin.tenantId, warehouseId, skuId).first();
    expect(await inventory()).toEqual({ on_hand_qty: 2, reserved_qty: 0 });

    const { order } = await createOrder(db, operator, {
      channel: 'Amazon US', destination: '测试目的地', customerName: '测试收件人', currency: 'USD',
      amountMinor: 4200, quantity: 1, warehouseId, skuId,
    }, 'business-flow-new-order');
    expect(await inventory()).toEqual({ on_hand_qty: 2, reserved_qty: 0 });
    await executeOrderAction(db, admin, order.id, 'approve', 'business-flow-reserve');
    expect(await inventory()).toEqual({ on_hand_qty: 2, reserved_qty: 1 });

    const tracking = { orderId: order.id, expectedVersion: 0, carrier: '测试承运商', trackingNumber: 'FLOW-TEST-001',
      status: 'registered', note: '' } as const;
    await expect(appendTrackingEvent(db, operator, tracking, 'business-flow-early-track'))
      .rejects.toMatchObject({ code: 'ORDER_NOT_SHIPPED' });
    await recordWarehouseOutboundStep(db, operator, order.id, { step: 'pick', expectedVersion: 0, quantity: 1 }, 'business-flow-pick');
    await expect(executeOrderAction(db, operator, order.id, 'ship', 'business-flow-early-ship')).rejects.toThrow('WAREHOUSE_PACK_REQUIRED');
    await recordWarehouseOutboundStep(db, operator, order.id, { step: 'verify', expectedVersion: 1, quantity: 1, skuCode }, 'business-flow-verify');
    await recordWarehouseOutboundStep(db, operator, order.id, { step: 'pack', expectedVersion: 2, packageCount: 1 }, 'business-flow-pack');
    expect(await getWarehouseOutbound(db, operator, order.id)).toMatchObject({ version: 3, orderStatus: 'reserved' });
    expect(await inventory()).toEqual({ on_hand_qty: 2, reserved_qty: 1 });

    expect(await executeOrderAction(db, operator, order.id, 'ship', 'business-flow-ship'))
      .toMatchObject({ order: { status: 'shipped' }, replayed: false });
    expect(await executeOrderAction(db, operator, order.id, 'ship', 'business-flow-ship'))
      .toMatchObject({ order: { status: 'shipped' }, replayed: true });
    expect(await listManualLogistics(db, operator, '', 1, 'unregistered')).toMatchObject({ rows: [{ orderId: order.id }] });
    expect(await inventory()).toEqual({ on_hand_qty: 1, reserved_qty: 0 });

    const { packageId } = await appendTrackingEvent(db, operator, tracking, 'business-flow-track');
    await appendTrackingEvent(db, operator, { ...tracking, packageId, expectedVersion: 1, status: 'in_transit' }, 'business-flow-in-transit');
    await appendTrackingEvent(db, operator, { ...tracking, packageId, expectedVersion: 2, status: 'delivered' }, 'business-flow-delivered');
    expect(await getTrackingHistory(db, operator, packageId)).toMatchObject([
      { version: 3, status: 'delivered' }, { version: 2, status: 'in_transit' }, { version: 1, status: 'registered' },
    ]);
    expect(await inventory()).toEqual({ on_hand_qty: 1, reserved_qty: 0 });

    await addPurchaseInvoice(db, admin, { kind: 'invoice', purchaseOrderId, currency: 'USD', amountMinor: 2500,
      invoiceOn: '2026-06-02', reference: 'FLOW-INVOICE-01' }, 'business-flow-invoice');
    await addPurchasePayment(db, admin, { kind: 'payment', purchaseOrderId, currency: 'USD', amountMinor: 2500,
      paidAt: paymentDate, reference: 'FLOW-PAYMENT-01' }, 'business-flow-payment');
    const { order: balance } = await getFinanceLedger(db, admin, purchaseOrderId, 'invoice', 1);
    expect(balance).toMatchObject({ orderedMinor: '6250', receivedMinor: '2500', invoicedMinor: '2500', paidMinor: '2500',
      invoiceOrderDifferenceMinor: '-3750', invoiceReceiptDifferenceMinor: '0', invoicePaymentDifferenceMinor: '0' });
    expect(await inventory()).toEqual({ on_hand_qty: 1, reserved_qty: 0 });
    const movements = await db.prepare(`
      SELECT type, on_hand_delta, reserved_delta FROM inventory_movements WHERE tenant_id = ? AND order_id = ? ORDER BY rowid
    `).bind(admin.tenantId, order.id).all();
    expect(movements.results).toEqual([
      { type: 'reserve', on_hand_delta: 0, reserved_delta: 1 },
      { type: 'ship', on_hand_delta: -1, reserved_delta: -1 },
    ]);
    expect(await db.prepare('SELECT COUNT(*) AS count FROM inventory_inbound_movements WHERE tenant_id = ? AND purchase_order_id = ?')
      .bind(admin.tenantId, purchaseOrderId).first('count')).toBe(1);
  } finally {
    database.close();
  }
});
