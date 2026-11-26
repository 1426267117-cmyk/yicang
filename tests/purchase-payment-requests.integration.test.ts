import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET, POST } from '../app/api/finance/payment-requests/route';
import { GET as GET_PAYMENT_OVERVIEW } from '../app/api/purchase/orders/[id]/payment-overview/route';
import { openSqliteD1 } from '../lib/aws/sqlite-d1';
import type { UserContext } from '../lib/db';
import { resolveMemberAccess, ROLE_PERMISSIONS, type Role } from '../lib/domain';
import { addPurchasePayment } from '../lib/finance';
import { createPurchaseOrder, createSupplier, createWarehouse, executePurchaseOrderAction } from '../lib/purchase-order-service';
import type { PaymentRequestCapacity, PaymentRequestDetails, PaymentRequestList, PaymentRequestOrderList } from '../lib/purchase-payment-requests';
import { createPurchaseSku } from '../lib/purchase-sku-service';
import { createManualPurchaseRequest, executePurchaseRequestAction, getPurchaseWorkspace } from '../lib/purchase-workflow-service';

const { requestContext } = vi.hoisted(() => ({ requestContext: vi.fn() }));
vi.mock('cloudflare:workers', () => ({ env: {} }));
vi.mock('../lib/db', async (original) => ({ ...await original<typeof import('../lib/db')>(), requestContext }));

const endpoint = 'https://erp.example.invalid/api/finance/payment-requests';
const now = '2026-11-25T04:00:00Z';
const paidAt = '2026-11-25T03:00:00.000Z';

function member(tenantId: string, id: string, role: Role): UserContext {
  return { id, role, tenantId, tenantName: tenantId, email: `${id}@example.invalid`, displayName: id, permissions: ROLE_PERMISSIONS[role] };
}

const requester = member('finance-request-main', 'req-test-operator', 'operator');
const admin = member(requester.tenantId, 'req-test-admin', 'admin');
const secondOperator = member(requester.tenantId, 'req-test-operator-two', 'operator');
const outsider = member('finance-request-outside', 'req-test-other', 'admin');

describe('采购请款审批与实际付款关联', () => {
  let sqlite: ReturnType<typeof openSqliteD1>;
  let orderId: string;

  function signIn(user: UserContext) {
    requestContext.mockResolvedValue({ db: sqlite.db, user });
  }

  function get(options: Record<string, string>) {
    return GET(new Request(`${endpoint}?${new URLSearchParams(options)}`));
  }

  function post(body: object, key: string) {
    return POST(new Request(endpoint, { method: 'POST', headers: { 'Idempotency-Key': key }, body: JSON.stringify(body) }));
  }

  function create(amountMinor = 3200, reason = '合同约定预付款') {
    return { action: 'create', orderId, businessType: 'prepayment', currency: 'USD', amountMinor, dueOn: '2026-12-03', reason } as const;
  }

  async function request(body = create(), key = 'request-create-first') {
    const response = await post(body, key);
    expect(response.status).toBe(201);
    return (await response.json() as { requestId: string }).requestId;
  }

  async function details(requestId: string) {
    const response = await get({ view: 'detail', requestId });
    expect(response.status).toBe(200);
    return await response.json() as PaymentRequestDetails;
  }

  async function capacity() {
    const response = await get({ view: 'capacity', orderId });
    expect(response.status).toBe(200);
    return await response.json() as PaymentRequestCapacity;
  }

  function paymentOverview(id = orderId) {
    return GET_PAYMENT_OVERVIEW(new Request(`https://erp.example.invalid/api/purchase/orders/${id}/payment-overview`), {
      params: Promise.resolve({ id }),
    });
  }

  beforeEach(async () => {
    vi.setSystemTime(new Date(now));
    sqlite = openSqliteD1(':memory:', resolve('drizzle'));
    const { db } = sqlite;
    await db.batch([
      ...[requester, outsider].map((user) => db.prepare('INSERT INTO tenants (id, name, created_at) VALUES (?, ?, ?)').bind(user.tenantId, user.tenantName, now)),
      ...[requester, admin, secondOperator, outsider].map((user) => db.prepare(`
        INSERT INTO members (id, tenant_id, auth_user_id, email, display_name, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(user.id, user.tenantId, user.id, user.email, user.displayName, user.role, now)),
    ]);
    const { sku } = await createPurchaseSku(db, requester, { code: 'REQ-TEST-01', name: '请款测试商品' }, 'request-test-new-sku');
    const { warehouse } = await createWarehouse(db, requester, { code: 'REQ-TEST-WH', name: '请款测试仓' }, 'request-test-new-warehouse');
    const { supplier } = await createSupplier(db, requester, { code: 'REQ-TEST-SUP', name: '请款测试供应商' }, 'request-test-new-supplier');
    const { request: procurement } = await createManualPurchaseRequest(db, requester, {
      purchaserMemberId: requester.id, reviewerMemberId: admin.id, note: '采购请款测试', lines: [{ skuId: sku.id, quantity: 5 }],
    }, 'request-test-new-procurement');
    await executePurchaseRequestAction(db, requester, procurement.id, { action: 'submit' }, 'request-test-procurement-submit');
    await executePurchaseRequestAction(db, admin, procurement.id, { action: 'approve' }, 'request-test-procurement-approve');
    const { purchaseOrder } = await createPurchaseOrder(db, requester, { purchaseRequestId: procurement.id, supplierId: supplier.id,
      deliveryWarehouseId: warehouse.id, expectedDeliveryAt: '2026-12-03', currency: 'USD',
      lineCosts: [{ purchaseRequestLineId: procurement.lines[0].id, unitCostMinor: 1250 }],
    }, 'request-test-new-purchase-order');
    orderId = purchaseOrder.id;
    await executePurchaseOrderAction(db, requester, orderId, { action: 'issue' }, 'request-test-purchase-order-issue');
    signIn(requester);
  });

  afterEach(() => { vi.useRealTimers(); sqlite?.close(); });

  it('按公司与请求人权限读取，采购员提交，另一管理员审批或驳回', async () => {
    const orders = await (await get({ view: 'orders', q: '请款测试供应商' })).json() as PaymentRequestOrderList;
    expect(orders.orders).toMatchObject([{ id: orderId, currency: 'USD' }]);
    expect(await capacity()).toMatchObject({ orderMinor: '6250', availableMinor: '6250' });
    expect((await post({ ...create(), currency: 'CNY' }, 'request-wrong-currency')).status).toBe(409);
    const id = await request();
    expect((await details(id)).request).toMatchObject({ isMine: true, canReview: false, canWithdraw: true, status: 'pending' });
    expect((await post({ action: 'approve', requestId: id, expectedVersion: 1 }, 'request-operator-review')).status).toBe(403);
    signIn(secondOperator);
    expect((await get({ view: 'detail', requestId: id })).status).toBe(404);
    const list = await (await get({ view: 'requests', status: 'all' })).json() as PaymentRequestList;
    expect(list.requests).toHaveLength(0);
    signIn(outsider);
    expect((await get({ view: 'capacity', orderId })).status).toBe(404);
    expect((await get({ view: 'detail', requestId: id })).status).toBe(404);
    signIn(admin);
    expect((await details(id)).request).toMatchObject({ canReview: true, canWithdraw: false, status: 'pending' });
    expect((await post({ action: 'reject', requestId: id, expectedVersion: 1, note: '合同条款须核对' }, 'request-admin-reject')).status).toBe(200);
    expect((await details(id)).request).toMatchObject({ status: 'rejected', reviewNote: '合同条款须核对', reviewedBy: admin.displayName });
    expect(await capacity()).toMatchObject({ availableMinor: '6250' });
    const own = await request(create(1000), 'request-admin-own');
    expect((await post({ action: 'approve', requestId: own, expectedVersion: 1 }, 'request-self-review')).status).toBe(403);
    expect((await post({ action: 'withdraw', requestId: own, expectedVersion: 1, note: '请由采购员发起' }, 'request-admin-withdraw')).status).toBe(200);
  });

  it('重复提交可安全重试，并发申报不能超出采购单额度', async () => {
    const first = create(1500);
    const repeated = await Promise.all([post(first, 'request-concurrent-same'), post(first, 'request-concurrent-same')]);
    expect(repeated.map((response) => response.status).sort()).toEqual([200, 201]);
    const sides = await Promise.all(repeated.map(async (response) => await response.json() as { requestId: string }));
    expect(sides[0].requestId).toBe(sides[1].requestId);
    expect((await post(first, 'request-new-key-duplicate')).status).toBe(409);
    const results = await Promise.all([
      post(create(4000, '测试批次 A'), 'request-concurrent-cap-a'),
      post(create(4000, '测试批次 B'), 'request-concurrent-cap-b'),
    ]);
    expect(results.map((response) => response.status).sort()).toEqual([201, 409]);
    expect(await capacity()).toMatchObject({ orderMinor: '6250', availableMinor: '750' });
    expect(await sqlite.db.prepare("SELECT COUNT(*) AS total FROM audit_logs WHERE action = 'PURCHASE_PAYMENT_REQUEST_CREATE'").first('total')).toBe(2);
  });

  it('财务岗位可审批和登记实付，但无权发起采购或查看采购工作台', async () => {
    const id = await request();
    const finance = { ...member(requester.tenantId, 'feishu-finance-tester', 'viewer'),
      ...resolveMemberAccess('viewer', 'finance'), accessProfile: 'finance' as const };
    await sqlite.db.prepare(`INSERT INTO members (id, tenant_id, auth_user_id, email, display_name, role, access_profile, created_at)
      VALUES (?, ?, ?, ?, ?, 'viewer', 'finance', ?)`).bind(finance.id, finance.tenantId, finance.id, finance.email, finance.displayName, now).run();
    signIn(finance);
    expect((await details(id)).request).toMatchObject({ canReview: true, canWithdraw: false });
    expect((await post(create(1000), 'finance-cannot-create-request')).status).toBe(403);
    await expect(getPurchaseWorkspace(sqlite.db, finance)).rejects.toMatchObject({ status: 403, code: 'PERMISSION_DENIED' });
    expect((await post({ action: 'approve', requestId: id, expectedVersion: 1 }, 'finance-approve-request')).status).toBe(200);
    const payment = await addPurchasePayment(sqlite.db, finance, {
      kind: 'payment', purchaseOrderId: orderId, amountMinor: 3200, currency: 'USD', paidAt, reference: 'FINANCE-PROFILE-TEST',
    }, 'finance-profile-record-payment');
    expect((await post({ action: 'link', requestId: id, expectedVersion: 2, paymentId: payment.id }, 'finance-link-request')).status).toBe(200);
    expect((await details(id)).request).toMatchObject({ status: 'approved', linkedMinor: '3200', outstandingMinor: '0' });
  });

  it('按采购单或供应商查找待结清请款，付款关联和冲正改变结清状态', async () => {
    const id = await request();
    const { orderNo } = (await details(id)).request;
    signIn(admin);
    async function queue(status: string, q = orderNo.toLowerCase()) {
      const response = await get({ view: 'requests', status, q });
      expect(response.status).toBe(200);
      return (await response.json() as PaymentRequestList).requests;
    }
    expect(await queue('pending')).toMatchObject([{ id, status: 'pending', paymentStatus: null }]);
    expect(await queue('outstanding')).toEqual([]);
    expect((await post({ action: 'approve', requestId: id, expectedVersion: 1 }, 'request-queue-approval')).status).toBe(200);
    expect(await queue('outstanding', '请款测试供应商')).toMatchObject([{ id, status: 'approved', paymentStatus: 'unpaid', outstandingMinor: '3200' }]);
    expect(await queue('outstanding', '其他供应商')).toEqual([]);
    signIn(secondOperator);
    expect(await queue('outstanding')).toEqual([]);
    signIn(outsider);
    expect(await queue('outstanding')).toEqual([]);
    signIn(admin);
    const fields = { purchaseOrderId: orderId, currency: 'USD', paidAt };
    const first = await addPurchasePayment(sqlite.db, admin, { ...fields, kind: 'payment', amountMinor: 1200, reference: 'QUEUE-FIRST' }, 'request-queue-pay-first');
    expect(await queue('outstanding')).toMatchObject([{ id, paymentStatus: 'unpaid', linkedMinor: '0' }]);
    expect((await post({ action: 'link', requestId: id, expectedVersion: 2, paymentId: first.id }, 'request-queue-link-first')).status).toBe(200);
    expect(await queue('outstanding')).toMatchObject([{ id, paymentStatus: 'partial', outstandingMinor: '2000' }]);
    const second = await addPurchasePayment(sqlite.db, admin, { ...fields, kind: 'payment', amountMinor: 2000, reference: 'QUEUE-SECOND' }, 'request-queue-pay-second');
    expect((await post({ action: 'link', requestId: id, expectedVersion: 2, paymentId: second.id }, 'request-queue-link-second')).status).toBe(200);
    expect(await queue('outstanding')).toEqual([]);
    expect(await queue('settled')).toMatchObject([{ id, status: 'approved', paymentStatus: 'settled', outstandingMinor: '0' }]);
    await addPurchasePayment(sqlite.db, admin, { ...fields, kind: 'reversal', originalPaymentId: second.id, amountMinor: 500,
      reference: 'QUEUE-SECOND-CORRECTION' }, 'request-queue-reversal');
    expect(await queue('settled')).toEqual([]);
    expect(await queue('outstanding')).toMatchObject([{ id, status: 'approved', paymentStatus: 'partial', linkedMinor: '2700', outstandingMinor: '500' }]);
  });

  it('审批与实付分离，既有付款可关联、冲正及解除关联且不会重复计入额度', async () => {
    const id = await request();
    signIn(admin);
    const approvals = await Promise.all([
      post({ action: 'approve', requestId: id, expectedVersion: 1 }, 'request-admin-approve'),
      post({ action: 'approve', requestId: id, expectedVersion: 1 }, 'request-admin-approve'),
    ]);
    expect(approvals.map((response) => response.status)).toEqual([200, 200]);
    expect((await details(id)).request).toMatchObject({ status: 'approved', version: 2, linkedMinor: '0', outstandingMinor: '3200' });
    expect(await sqlite.db.prepare('SELECT COUNT(*) AS total FROM purchase_payments').first('total')).toBe(0);
    const { id: paymentId } = await addPurchasePayment(sqlite.db, admin, { kind: 'payment', purchaseOrderId: orderId,
      amountMinor: 1200, currency: 'USD', paidAt, reference: 'REQ-BANK-TEST-01' }, 'request-linked-actual-record');
    expect(await capacity()).toMatchObject({ availableMinor: '1850', paidMinor: '1200', heldMinor: '3200' });
    expect((await details(id)).candidates).toMatchObject([{ id: paymentId, netMinor: '1200' }]);
    expect((await post({ action: 'link', requestId: id, expectedVersion: 2, paymentId }, 'request-link-actual')).status).toBe(200);
    expect((await post({ action: 'link', requestId: id, expectedVersion: 2, paymentId }, 'request-link-duplicate')).status).toBe(409);
    expect(await capacity()).toMatchObject({ availableMinor: '3050', paidMinor: '1200', heldMinor: '2000' });
    expect((await post({ action: 'cancel', requestId: id, expectedVersion: 2, note: '核对取消' }, 'request-cancel-while-linked')).status).toBe(409);
    const { linked } = await details(id);
    await addPurchasePayment(sqlite.db, admin, { kind: 'reversal', originalPaymentId: paymentId, purchaseOrderId: orderId,
      amountMinor: 200, currency: 'USD', paidAt, reference: 'REQ-BANK-TEST-CREDIT' }, 'request-linked-actual-reversal');
    expect((await details(id)).request).toMatchObject({ linkedMinor: '1000', outstandingMinor: '2200' });
    expect(await capacity()).toMatchObject({ availableMinor: '3050', paidMinor: '1000', heldMinor: '2200' });
    expect((await post({ action: 'unlink', requestId: id, expectedVersion: 2, linkId: linked[0].id, note: '关联对象更正' }, 'request-unlink-actual')).status).toBe(200);
    expect((await post({ action: 'cancel', requestId: id, expectedVersion: 2, note: '审批已替换' }, 'request-cancel-approved')).status).toBe(200);
    expect(await capacity()).toMatchObject({ availableMinor: '5250', paidMinor: '1000', heldMinor: '0' });
    expect(await sqlite.db.prepare('SELECT COUNT(*) AS total FROM purchase_payments').first('total')).toBe(2);
  });

  it('采购员能查看订单付款汇总，冲正后同步更新实付和待结清且不返回流水明细', async () => {
    const approved = await request(create(2400, '第一笔请款'), 'overview-first-request');
    await request(create(800, '第二笔请款'), 'overview-second-request');
    signIn(admin);
    expect((await post({ action: 'approve', requestId: approved, expectedVersion: 1 }, 'overview-first-approve')).status).toBe(200);
    const paymentData = { purchaseOrderId: orderId, currency: 'USD', paidAt };
    const linked = await addPurchasePayment(sqlite.db, admin, { ...paymentData, kind: 'payment', amountMinor: 1000,
      reference: 'OVERVIEW-LINKED-PRIVATE-REF' }, 'overview-linked-payment');
    await addPurchasePayment(sqlite.db, admin, { ...paymentData, kind: 'payment', amountMinor: 500,
      reference: 'OVERVIEW-UNLINKED-PRIVATE-REF' }, 'overview-unlinked-payment');
    expect((await post({ action: 'link', requestId: approved, expectedVersion: 2, paymentId: linked.id }, 'overview-link')).status).toBe(200);

    signIn(secondOperator);
    const before = await paymentOverview();
    expect(before.status).toBe(200);
    expect(before.headers.get('Cache-Control')).toBe('private, no-store');
    const data = await before.json();
    expect(data).toMatchObject({ ok: true, overview: {
      orderId, currency: 'USD', payableMinor: '6250', paidMinor: '1500', unpaidMinor: '4750',
      pendingApprovalMinor: '800', approvedOutstandingMinor: '1400', paymentTerms: null,
    } });
    expect(JSON.stringify(data)).not.toMatch(/OVERVIEW-|采购员|第一笔请款|第二笔请款|paymentId|requestId/u);
    expect((await get({ view: 'detail', requestId: approved })).status).toBe(404);

    await addPurchasePayment(sqlite.db, admin, { ...paymentData, kind: 'reversal', originalPaymentId: linked.id, amountMinor: 250,
      reference: 'OVERVIEW-REVERSAL-PRIVATE-REF' }, 'overview-linked-reversal');
    expect(await (await paymentOverview()).json()).toMatchObject({ overview: {
      payableMinor: '6250', paidMinor: '1250', unpaidMinor: '5000', pendingApprovalMinor: '800', approvedOutstandingMinor: '1650',
    } });
    signIn(admin);
    expect(await capacity()).toMatchObject({ availableMinor: '2550' });
  });

  it('限制为本工作区有采购制单权限的成员，保留只读角色和平台岗位的权限边界', async () => {
    signIn(outsider);
    expect((await paymentOverview()).status).toBe(404);
    const viewer = member(requester.tenantId, 'overview-viewer', 'viewer');
    await sqlite.db.prepare(`INSERT INTO members (id, tenant_id, auth_user_id, email, display_name, role, created_at)
      VALUES (?, ?, ?, ?, ?, 'viewer', ?)`).bind(viewer.id, viewer.tenantId, viewer.id, viewer.email, viewer.displayName, now).run();
    signIn(viewer);
    expect((await paymentOverview()).status).toBe(403);
    signIn({ ...viewer, permissions: ROLE_PERMISSIONS.operator });
    expect((await paymentOverview()).status).toBe(403);
    await sqlite.db.prepare("UPDATE members SET access_profile = 'amazon' WHERE id = ?").bind(viewer.id).run();
    signIn({ ...viewer, ...resolveMemberAccess('viewer', 'amazon'), accessProfile: 'amazon' });
    expect((await paymentOverview()).status).toBe(403);
    await sqlite.db.prepare("UPDATE members SET access_profile = 'purchase' WHERE id = ?").bind(viewer.id).run();
    signIn({ ...viewer, ...resolveMemberAccess('viewer', 'purchase'), accessProfile: 'purchase' });
    expect((await paymentOverview()).status).toBe(200);
  });

  it('币种和单价缺失时不输出零应付，精确返回超出安全整数的已下单金额', async () => {
    await sqlite.db.batch([
      sqlite.db.prepare("UPDATE purchase_orders SET currency = 'CNY', payment_terms = '签收后付款' WHERE id = ?").bind(orderId),
      sqlite.db.prepare("UPDATE purchase_order_lines SET currency = 'CNY', ordered_quantity = 100000000, unit_cost_minor = 123456789 WHERE purchase_order_id = ?").bind(orderId),
    ]);
    expect(await (await paymentOverview()).json()).toMatchObject({ overview: {
      currency: 'CNY', committed: true, payableMinor: '12345678900000000', paidMinor: '0', unpaidMinor: '12345678900000000',
      paymentTerms: '签收后付款',
    } });
    await sqlite.db.prepare('UPDATE purchase_order_lines SET unit_cost_minor = NULL WHERE purchase_order_id = ?').bind(orderId).run();
    expect(await (await paymentOverview()).json()).toMatchObject({ overview: {
      committed: true, payableMinor: null, paidMinor: '0', unpaidMinor: null,
    } });
    const { db } = sqlite;
    const { sku } = await createPurchaseSku(db, requester, { code: 'DRAFT-OVERVIEW', name: '待填采购单' }, 'overview-draft-sku');
    const { request: draftRequest } = await createManualPurchaseRequest(db, requester, {
      purchaserMemberId: requester.id, reviewerMemberId: admin.id, note: '待补供应商和单价', lines: [{ skuId: sku.id, quantity: 5 }],
    }, 'overview-draft-request');
    await executePurchaseRequestAction(db, requester, draftRequest.id, { action: 'submit' }, 'overview-draft-submit');
    await executePurchaseRequestAction(db, admin, draftRequest.id, { action: 'approve' }, 'overview-draft-approve', { createOrderDraftOnApproval: true });
    const draftId = await db.prepare("SELECT id FROM purchase_orders WHERE purchase_request_id = ? AND status = 'draft'")
      .bind(draftRequest.id).first<string>('id');
    expect(draftId).toBeTruthy();
    if (!draftId) throw new Error('采购复审后未生成草稿');
    expect(await (await paymentOverview(draftId)).json()).toMatchObject({ overview: {
      status: 'draft', committed: false, currency: null, payableMinor: null, paidMinor: null, unpaidMinor: null,
      pendingApprovalMinor: null, approvedOutstandingMinor: null, paymentTerms: null,
    } });
  });
});
