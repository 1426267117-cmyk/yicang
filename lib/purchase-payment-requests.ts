import { z } from 'zod';
import { sha256Hex, stableJson } from './connectors/stable';
import { HttpError, requirePermission, type UserContext } from './db';
import { resolveMemberAccess, type AccessProfile, type Permission, type Role } from './domain';

const key = z.string().trim().min(1).max(160);
const amount = z.number().int().positive().max(1_000_000_000_000);
const currency = z.string().regex(/^[A-Z]{3}$/u);
const version = z.number().int().positive().max(1_000_000);
const note = z.string().trim().min(1).max(500);
const optionalNote = z.string().trim().max(500).optional();
const caseStatuses = ['pending', 'approved', 'rejected', 'withdrawn', 'cancelled'] as const;
export type RequestStatus = (typeof caseStatuses)[number];
const requestFilters = ['all', ...caseStatuses, 'outstanding', 'settled'] as const;
export type PaymentRequestFilter = (typeof requestFilters)[number];
export const paymentRequestTypes = ['prepayment', 'balance'] as const;
export type PaymentRequestType = (typeof paymentRequestTypes)[number];
const sameRequest = { requestId: key, expectedVersion: version };

export const paymentRequestActionSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('create'), orderId: key, amountMinor: amount, currency,
    businessType: z.enum(paymentRequestTypes), dueOn: z.iso.date(), reason: note, reference: z.string().trim().max(120).optional() }),
  z.strictObject({ action: z.literal('approve'), ...sameRequest, note: optionalNote }),
  z.strictObject({ action: z.literal('reject'), ...sameRequest, note }),
  z.strictObject({ action: z.literal('withdraw'), ...sameRequest, note }),
  z.strictObject({ action: z.literal('cancel'), ...sameRequest, note }),
  z.strictObject({ action: z.literal('link'), ...sameRequest, paymentId: key }),
  z.strictObject({ action: z.literal('unlink'), ...sameRequest, linkId: key, note }),
]);
export type PaymentRequestAction = z.infer<typeof paymentRequestActionSchema>;

const page = z.coerce.number().int().min(1).max(20_000).default(1);
export const paymentRequestQuerySchema = z.discriminatedUnion('view', [
  z.strictObject({ view: z.literal('requests'), status: z.enum(requestFilters).default('pending'), q: z.string().trim().max(120).default(''), page }),
  z.strictObject({ view: z.literal('orders'), q: z.string().trim().max(120).default(''), page }),
  z.strictObject({ view: z.literal('detail'), requestId: key }),
  z.strictObject({ view: z.literal('capacity'), orderId: key }),
]);
type PaymentRequestQuery = z.infer<typeof paymentRequestQuerySchema>;

const activePurchaseStatuses = ['issued', 'partially_received', 'received', 'closed_short'];
const activeStatusSql = "('issued','partially_received','received','closed_short')";
const pageSize = 40;
const zero = BigInt(0);

type PurchaseOrder = { id: string; orderNo: string; supplier: string; status: string; currency: string | null; version: number };
type MoneyLine = { quantity: string; cost: string | null; currency: string | null };
type RequestRow = {
  id: string; orderId: string; orderNo: string; supplier: string; requestedByMemberId: string;
  requestedBy: string; businessType: PaymentRequestType; amountMinor: string; currency: string; dueOn: string;
  reason: string; reference: string | null; submissionHash: string; status: RequestStatus; version: number; createdAt: string;
  reviewedBy: string | null; reviewedAt: string | null; reviewNote: string | null;
  closedBy: string | null; closedAt: string | null; closeNote: string | null;
  linkedMinor: string; linkCount: number;
};
type Payment = { id: string; kind: 'payment' | 'reversal'; currency: string; amountMinor: string; original: string | null; reference: string; paidAt: string };
type Link = { id: string; requestId: string; paymentId: string; linkedAt: string; detachedAt: string | null };
type RevisionObservation = { orderVersion: number; requestCount: number; requestVersions: number; paymentCount: number; linkCount: number; detachedCount: number };
type Actor = {
  id: string;
  role: Role;
  profile: AccessProfile | null;
  canRequest: boolean;
  canReadLedger: boolean;
  canReview: boolean;
  canLink: boolean;
};

const orderColumns = `po.id, po.order_no AS orderNo, COALESCE(po.supplier_name_snapshot, supplier.name) AS supplier,
  po.status, po.currency, po.version`;
const orderSupplierJoin = `JOIN suppliers supplier ON supplier.tenant_id = po.tenant_id AND supplier.id = po.supplier_id`;
const orderSources = `FROM purchase_orders po ${orderSupplierJoin}`;
const requestColumns = `r.id, r.purchase_order_id AS orderId, po.order_no AS orderNo,
  COALESCE(po.supplier_name_snapshot, supplier.name) AS supplier, r.requested_by_member_id AS requestedByMemberId,
  requester.display_name AS requestedBy, r.business_type AS businessType, CAST(r.amount_minor AS TEXT) AS amountMinor,
  r.currency, r.due_on AS dueOn, r.reason, r.reference, r.submission_hash AS submissionHash, r.status, r.version, r.created_at AS createdAt,
  reviewer.display_name AS reviewedBy, r.reviewed_at AS reviewedAt, r.review_note AS reviewNote,
  closer.display_name AS closedBy, r.closed_at AS closedAt, r.close_note AS closeNote,
  CAST(COALESCE((SELECT SUM(payment.amount_minor - COALESCE((
    SELECT SUM(reversal.amount_minor) FROM purchase_payments reversal WHERE reversal.tenant_id = payment.tenant_id
      AND reversal.purchase_order_id = payment.purchase_order_id AND reversal.currency = payment.currency
      AND reversal.kind = 'reversal' AND reversal.original_payment_id = payment.id
  ), 0)) FROM purchase_payment_request_links active
    JOIN purchase_payments payment ON payment.tenant_id = active.tenant_id AND payment.id = active.payment_id
      AND payment.purchase_order_id = r.purchase_order_id AND payment.currency = r.currency AND payment.kind = 'payment'
    WHERE active.tenant_id = r.tenant_id AND active.request_id = r.id AND active.detached_at IS NULL), 0) AS TEXT) AS linkedMinor,
  (SELECT COUNT(*) FROM purchase_payment_request_links active
    WHERE active.tenant_id = r.tenant_id AND active.request_id = r.id AND active.detached_at IS NULL) AS linkCount`;
const requestSources = `FROM purchase_payment_requests r
  JOIN purchase_orders po ON po.tenant_id = r.tenant_id AND po.id = r.purchase_order_id
  JOIN suppliers supplier ON supplier.tenant_id = po.tenant_id AND supplier.id = po.supplier_id
  JOIN members requester ON requester.tenant_id = r.tenant_id AND requester.id = r.requested_by_member_id
  LEFT JOIN members reviewer ON reviewer.tenant_id = r.tenant_id AND reviewer.id = r.reviewed_by_member_id
  LEFT JOIN members closer ON closer.tenant_id = r.tenant_id AND closer.id = r.closed_by_member_id`;

export type PaymentRequest = ReturnType<typeof requestView>;
export type PaymentRequestList = Awaited<ReturnType<typeof listPaymentRequests>>;
export type PaymentRequestOrderList = Awaited<ReturnType<typeof listPaymentRequestOrders>>;
export type PaymentRequestCapacity = Awaited<ReturnType<typeof getPaymentRequestCapacity>>;
export type PaymentRequestDetails = Awaited<ReturnType<typeof getPaymentRequestDetails>>;
export type PurchaseOrderPaymentOverview = Awaited<ReturnType<typeof getPurchaseOrderPaymentOverview>>;

async function getActor(db: D1Database, user: UserContext): Promise<Actor> {
  if (!user.permissions.includes('purchase:order:create') && !user.permissions.includes('finance:read')) {
    throw new HttpError(403, '当前账号没有查看采购请款的权限', 'PERMISSION_DENIED');
  }
  const member = await db.prepare(`SELECT id, role, access_profile FROM members
    WHERE tenant_id = ? AND auth_user_id = ?`)
    .bind(user.tenantId, user.id).first<{ id: string; role: Role; access_profile: AccessProfile | null }>();
  if (!member) throw new HttpError(403, '当前工作区没有可操作的成员身份', 'PAYMENT_REQUEST_MEMBER_UNAVAILABLE');
  const { permissions } = resolveMemberAccess(member.role, member.access_profile);
  const can = (permission: Permission) => user.permissions.includes(permission) && permissions.includes(permission);
  const canRequest = can('purchase:order:create');
  const canReadLedger = can('finance:read');
  if (!canRequest && !canReadLedger) throw new HttpError(403, '当前账号没有查看采购请款的权限', 'PERMISSION_DENIED');
  return {
    id: member.id, role: member.role, profile: member.access_profile,
    canRequest, canReadLedger, canReview: can('finance:review'), canLink: can('finance:write'),
  };
}

function requestView(row: RequestRow, actor: Actor) {
  const mine = actor.id === row.requestedByMemberId;
  const linked = BigInt(row.linkedMinor);
  const outstanding = row.status === 'approved' ? BigInt(row.amountMinor) - linked : null;
  const paymentStatus: 'unpaid' | 'partial' | 'settled' | null = outstanding === null ? null
    : outstanding <= zero ? 'settled' : linked > zero ? 'partial' : 'unpaid';
  return {
    id: row.id, orderId: row.orderId, orderNo: row.orderNo, supplier: row.supplier, requestedBy: row.requestedBy,
    businessType: row.businessType, amountMinor: row.amountMinor, currency: row.currency, dueOn: row.dueOn, reason: row.reason,
    reference: row.reference, status: row.status, version: row.version, createdAt: row.createdAt, reviewedBy: row.reviewedBy,
    reviewedAt: row.reviewedAt, reviewNote: row.reviewNote, closedBy: row.closedBy, closedAt: row.closedAt, closeNote: row.closeNote,
    linkedMinor: row.linkedMinor,
    isMine: mine,
    canReview: actor.canReview && !mine && row.status === 'pending',
    canWithdraw: actor.canRequest && mine && row.status === 'pending',
    canCancel: actor.canReview && row.status === 'approved' && row.linkCount === 0,
    canLink: actor.canLink && row.status === 'approved',
    outstandingMinor: outstanding?.toString() ?? null,
    paymentStatus,
  };
}

export async function listPaymentRequests(db: D1Database, user: UserContext, query: Extract<PaymentRequestQuery, { view: 'requests' }>) {
  const actor = await getActor(db, user);
  const paymentFilter = query.status === 'outstanding' || query.status === 'settled';
  const status = paymentFilter ? 'approved' : query.status;
  const settlement = query.status === 'outstanding' ? 'WHERE CAST(linkedMinor AS INTEGER) < CAST(amountMinor AS INTEGER)'
    : query.status === 'settled' ? 'WHERE CAST(linkedMinor AS INTEGER) >= CAST(amountMinor AS INTEGER)' : '';
  const search = query.q ? `AND (instr(lower(po.order_no), lower(?)) > 0
    OR instr(lower(COALESCE(po.supplier_name_snapshot, supplier.name)), lower(?)) > 0)` : '';
  const { results } = await db.prepare(`WITH scoped_requests AS (
    SELECT ${requestColumns} ${requestSources}
    WHERE r.tenant_id = ? AND (? = 1 OR r.requested_by_member_id = ?) AND (? = 'all' OR r.status = ?) ${search}
  ) SELECT * FROM scoped_requests ${settlement}
    ORDER BY CASE WHEN status = 'pending' THEN 0 ELSE 1 END, dueOn, createdAt DESC, id LIMIT ? OFFSET ?
  `).bind(user.tenantId, actor.canReadLedger ? 1 : 0, actor.id, status, status,
    ...(query.q ? [query.q, query.q] : []), pageSize + 1, (query.page - 1) * pageSize).all<RequestRow>();
  return { requests: results.slice(0, pageSize).map((row) => requestView(row, actor)), hasNext: results.length > pageSize };
}

export async function listPaymentRequestOrders(db: D1Database, user: UserContext, query: Extract<PaymentRequestQuery, { view: 'orders' }>) {
  requirePermission(user, 'purchase:order:create');
  await getActor(db, user);
  const { results } = await db.prepare(`SELECT ${orderColumns} ${orderSources}
    WHERE po.tenant_id = ? AND po.status IN ${activeStatusSql} AND po.currency GLOB '[A-Z][A-Z][A-Z]'
      AND (instr(lower(po.order_no), lower(?)) > 0 OR instr(lower(COALESCE(po.supplier_name_snapshot, supplier.name)), lower(?)) > 0)
    ORDER BY po.issued_at DESC, po.id LIMIT ? OFFSET ?
  `).bind(user.tenantId, query.q, query.q, pageSize + 1, (query.page - 1) * pageSize).all<PurchaseOrder>();
  return { orders: results.slice(0, pageSize), hasNext: results.length > pageSize };
}

async function readPurchaseBudget(db: D1Database, tenantId: string, orderId: string) {
  const [orderRows, lines, requests, payments, links] = await db.batch<PurchaseOrder | MoneyLine | RequestRow | Payment | Link>([
    db.prepare(`SELECT ${orderColumns}, po.payment_terms AS paymentTerms
      FROM purchase_orders po LEFT ${orderSupplierJoin} WHERE po.tenant_id = ? AND po.id = ?`).bind(tenantId, orderId),
    db.prepare(`SELECT CAST(ordered_quantity AS TEXT) AS quantity, CAST(unit_cost_minor AS TEXT) AS cost, currency
      FROM purchase_order_lines WHERE tenant_id = ? AND purchase_order_id = ?`).bind(tenantId, orderId),
    db.prepare(`SELECT ${requestColumns} ${requestSources} WHERE r.tenant_id = ? AND r.purchase_order_id = ?`).bind(tenantId, orderId),
    db.prepare(`SELECT id, kind, currency, CAST(amount_minor AS TEXT) AS amountMinor, original_payment_id AS original,
      reference, paid_at AS paidAt FROM purchase_payments WHERE tenant_id = ? AND purchase_order_id = ?
      ORDER BY paid_at DESC, id`).bind(tenantId, orderId),
    db.prepare(`SELECT link.id, link.request_id AS requestId, link.payment_id AS paymentId, link.linked_at AS linkedAt, link.detached_at AS detachedAt
      FROM purchase_payment_request_links link JOIN purchase_payment_requests r ON r.tenant_id = link.tenant_id AND r.id = link.request_id
      WHERE link.tenant_id = ? AND r.purchase_order_id = ?`).bind(tenantId, orderId),
  ]);
  const orderRow = orderRows.results[0] as (Omit<PurchaseOrder, 'supplier'> & { supplier: string | null; paymentTerms: string | null }) | undefined;
  if (!orderRow) throw new HttpError(404, '当前工作区找不到此采购单', 'PAYMENT_REQUEST_ORDER_NOT_FOUND');
  const { paymentTerms, ...order } = orderRow;
  const purchaseLines = lines.results as MoneyLine[];
  const paymentRows = payments.results as Payment[];
  const requestRows = requests.results as RequestRow[];
  const linkRows = links.results as Link[];
  const quantitiesValid = purchaseLines.length > 0 && order.currency !== null && currency.safeParse(order.currency).success
    && purchaseLines.every((line) => line.cost !== null && /^\d+$/u.test(line.cost) && /^\d+$/u.test(line.quantity) && line.currency === order.currency);
  const orderMinor = quantitiesValid ? purchaseLines.reduce((sum, line) => sum + BigInt(line.cost ?? '') * BigInt(line.quantity), zero) : null;
  const paidMinor = paymentRows.filter((payment) => payment.currency === order.currency).reduce((sum, payment) => {
    const signedAmount = payment.kind === 'payment' ? BigInt(payment.amountMinor) : -BigInt(payment.amountMinor);
    return sum + signedAmount;
  }, zero);
  let pendingApprovalMinor = zero;
  let approvedOutstandingMinor = zero;
  for (const request of requestRows) {
    if (request.currency !== order.currency) continue;
    if (request.status === 'pending') pendingApprovalMinor += BigInt(request.amountMinor);
    if (request.status === 'approved') approvedOutstandingMinor += BigInt(request.amountMinor) - BigInt(request.linkedMinor);
  }
  const heldMinor = pendingApprovalMinor + approvedOutstandingMinor;
  const observation = {
    orderVersion: order.version, requestCount: requestRows.length, requestVersions: requestRows.reduce((sum, row) => sum + row.version, 0),
    paymentCount: paymentRows.length, linkCount: linkRows.length, detachedCount: linkRows.filter((row) => row.detachedAt !== null).length,
  };
  return { order, paymentTerms, orderMinor, paidMinor, heldMinor, pendingApprovalMinor, approvedOutstandingMinor, observation,
    requests: requestRows, payments: paymentRows, links: linkRows };
}

export async function getPurchaseOrderPaymentOverview(db: D1Database, user: UserContext, orderId: string) {
  requirePermission(user, 'purchase:read');
  requirePermission(user, 'purchase:order:create');
  if (!(await getActor(db, user)).canRequest) throw new HttpError(403, '当前账号没有查看采购单付款进度的权限', 'PERMISSION_DENIED');
  const budget = await readPurchaseBudget(db, user.tenantId, orderId);
  const { order, paymentTerms, orderMinor, paidMinor, pendingApprovalMinor, approvedOutstandingMinor } = budget;
  const orderCurrency = currency.safeParse(order.currency).data ?? null;
  const committed = activePurchaseStatuses.includes(order.status);
  const payableMinor = committed ? orderMinor : null;
  const balance = payableMinor === null ? null : payableMinor - paidMinor;
  return {
    orderId: order.id, orderNo: order.orderNo, status: order.status, committed, currency: orderCurrency,
    paymentTerms,
    orderMinor: orderMinor?.toString() ?? null,
    payableMinor: payableMinor?.toString() ?? null,
    paidMinor: orderCurrency ? paidMinor.toString() : null,
    unpaidMinor: balance === null ? null : (balance > zero ? balance : zero).toString(),
    overpaidMinor: balance !== null && balance < zero ? (-balance).toString() : null,
    pendingApprovalMinor: orderCurrency ? pendingApprovalMinor.toString() : null,
    approvedOutstandingMinor: orderCurrency ? (approvedOutstandingMinor > zero ? approvedOutstandingMinor : zero).toString() : null,
  };
}

export async function getPaymentRequestCapacity(db: D1Database, user: UserContext, orderId: string) {
  const actor = await getActor(db, user);
  const budget = await readPurchaseBudget(db, user.tenantId, orderId);
  const capacity = budget.orderMinor === null ? null : budget.orderMinor - budget.paidMinor - budget.heldMinor;
  const balance = capacity !== null && capacity < zero ? zero : capacity;
  return { order: budget.order, orderMinor: budget.orderMinor?.toString() ?? null, availableMinor: balance?.toString() ?? null,
    canRequest: activePurchaseStatuses.includes(budget.order.status) && balance !== null && balance > zero,
    ...(actor.canReadLedger ? { paidMinor: budget.paidMinor.toString(), heldMinor: budget.heldMinor.toString() } : {}) };
}

async function readRequest(db: D1Database, tenantId: string, requestId: string, actor: Actor) {
  const request = await db.prepare(`SELECT ${requestColumns} ${requestSources}
    WHERE r.tenant_id = ? AND r.id = ? AND (? = 1 OR r.requested_by_member_id = ?)`)
    .bind(tenantId, requestId, actor.canReadLedger ? 1 : 0, actor.id).first<RequestRow>();
  if (!request) throw new HttpError(404, '当前账号找不到此请款单', 'PAYMENT_REQUEST_NOT_FOUND');
  return request;
}

function netPayment(payment: Payment, payments: Payment[]) {
  return payments.filter((row) => row.kind === 'reversal' && row.original === payment.id && row.currency === payment.currency)
    .reduce((net, row) => net - BigInt(row.amountMinor), BigInt(payment.amountMinor));
}

export async function getPaymentRequestDetails(db: D1Database, user: UserContext, requestId: string) {
  const actor = await getActor(db, user);
  const visible = await readRequest(db, user.tenantId, requestId, actor);
  if (!actor.canReadLedger) return { request: requestView(visible, actor), linked: [], candidates: [] };
  const data = await readPurchaseBudget(db, user.tenantId, visible.orderId);
  const request = data.requests.find((row) => row.id === visible.id) ?? visible;
  const activeLinks = data.links.filter((link) => link.detachedAt === null);
  const linked = data.links.filter((link) => link.requestId === requestId).map((link) => {
    const payment = data.payments.find((row) => row.id === link.paymentId);
    return { ...link, reference: payment?.reference ?? null, paidAt: payment?.paidAt ?? null,
      netMinor: payment ? netPayment(payment, data.payments).toString() : null };
  });
  const remaining = BigInt(request.amountMinor) - BigInt(request.linkedMinor);
  const candidates = request.status === 'approved' ? data.payments
    .filter((payment) => payment.kind === 'payment' && payment.currency === request.currency && !activeLinks.some((link) => link.paymentId === payment.id))
    .map((payment) => ({ id: payment.id, reference: payment.reference, paidAt: payment.paidAt, netMinor: netPayment(payment, data.payments) }))
    .filter((payment) => payment.netMinor > zero && payment.netMinor <= remaining)
    .map((payment) => ({ ...payment, netMinor: payment.netMinor.toString() })) : [];
  return { request: requestView(request, actor), linked, candidates };
}

function budgetGuard(tenantId: string, orderId: string, state: RevisionObservation) {
  // These values are monotonic through the app: PO optimistic version, request versions,
  // and counts of immutable actual-payment entries and auditable link/unlink mutations.
  return {
    sql: `EXISTS (SELECT 1 FROM purchase_orders WHERE tenant_id = ? AND id = ? AND version = ?)
      AND (SELECT COUNT(*) FROM purchase_payment_requests WHERE tenant_id = ? AND purchase_order_id = ?) = ?
      AND (SELECT COALESCE(SUM(version), 0) FROM purchase_payment_requests WHERE tenant_id = ? AND purchase_order_id = ?) = ?
      AND (SELECT COUNT(*) FROM purchase_payments WHERE tenant_id = ? AND purchase_order_id = ?) = ?
      AND (SELECT COUNT(*) FROM purchase_payment_request_links link JOIN purchase_payment_requests r
        ON r.tenant_id = link.tenant_id AND r.id = link.request_id WHERE link.tenant_id = ? AND r.purchase_order_id = ?) = ?
      AND (SELECT COUNT(*) FROM purchase_payment_request_links link JOIN purchase_payment_requests r
        ON r.tenant_id = link.tenant_id AND r.id = link.request_id WHERE link.tenant_id = ? AND r.purchase_order_id = ? AND link.detached_at IS NOT NULL) = ?`,
    bindings: [tenantId, orderId, state.orderVersion, tenantId, orderId, state.requestCount, tenantId, orderId, state.requestVersions,
      tenantId, orderId, state.paymentCount, tenantId, orderId, state.linkCount, tenantId, orderId, state.detachedCount],
  };
}

function requestConflict() {
  return new HttpError(409, '采购单、请款或付款状态已变化，请刷新后核对额度再重试', 'PAYMENT_REQUEST_CONFLICT');
}

async function replayOperation(db: D1Database, tenantId: string, auditKey: string, requestHash: string) {
  const prior = await db.prepare(`SELECT entity_id AS requestId, entity_type AS entityType,
    json_extract(after_json, '$.requestHash') AS requestHash FROM audit_logs WHERE tenant_id = ? AND idempotency_key = ?`)
    .bind(tenantId, auditKey).first<{ requestId: string; entityType: string; requestHash: string }>();
  if (!prior) return null;
  if (prior.requestHash !== requestHash || prior.entityType !== 'purchase_payment_request') {
    throw new HttpError(409, '此操作编号已用于另一条请款操作', 'IDEMPOTENCY_CONFLICT');
  }
  return { requestId: prior.requestId, replayed: true };
}

type Mutation = { statement: D1PreparedStatement; affected: string; bindings: (string | number | null)[]; status: RequestStatus; relatedId?: string };

export async function changePaymentRequest(db: D1Database, user: UserContext, input: PaymentRequestAction, operationKey: string) {
  const actor = await getActor(db, user);
  const { action } = input;
  const allowed = action === 'create' || action === 'withdraw' ? actor.canRequest
    : action === 'link' || action === 'unlink' ? actor.canLink : actor.canReview;
  if (!allowed) throw new HttpError(403, '当前账号没有该项请款或付款权限', 'PAYMENT_REQUEST_REVIEW_REQUIRED');
  if (!/^[a-zA-Z0-9._:-]{12,128}$/u.test(operationKey)) throw new HttpError(400, '缺少有效的请款操作编号', 'INVALID_IDEMPOTENCY_KEY');
  const auditKey = `purchase-payment-request:${operationKey}`;
  const hash = await sha256Hex(stableJson([user.id, input]));
  const replay = await replayOperation(db, user.tenantId, auditKey, hash);
  if (replay) return replay;
  try {
    return await persistPaymentRequest(db, user, actor, input, auditKey, hash);
  } catch (error) {
    const concurrentReplay = await replayOperation(db, user.tenantId, auditKey, hash);
    if (concurrentReplay) return concurrentReplay;
    throw error;
  }
}

async function persistPaymentRequest(db: D1Database, user: UserContext, actor: Actor, input: PaymentRequestAction, auditKey: string, hash: string) {
  const { action } = input;
  const known = action === 'create' ? null : await readRequest(db, user.tenantId, input.requestId, actor);
  if (known && action !== 'create' && known.version !== input.expectedVersion) throw requestConflict();
  const orderId = action === 'create' ? input.orderId : known?.orderId;
  if (!orderId) throw requestConflict();
  const requestId = known?.id ?? crypto.randomUUID();
  const state = await readPurchaseBudget(db, user.tenantId, orderId);
  const request = known ? state.requests.find((row) => row.id === known.id) : null;
  if (known && (!request || known.version !== request.version)) throw requestConflict();
  const now = new Date().toISOString();
  const guard = budgetGuard(user.tenantId, orderId, state.observation);
  const account = `EXISTS (SELECT 1 FROM members WHERE tenant_id = ? AND id = ? AND auth_user_id = ? AND role = ? AND access_profile IS ?)`;
  const uniqueOperation = 'NOT EXISTS (SELECT 1 FROM audit_logs WHERE tenant_id = ? AND idempotency_key = ?)';
  const conditions = `${guard.sql} AND ${account} AND ${uniqueOperation}`;
  const bindings = [...guard.bindings, user.tenantId, actor.id, user.id, actor.role, actor.profile, user.tenantId, auditKey];

  function assertBudget(add = zero) {
    if (!activePurchaseStatuses.includes(state.order.status) || state.orderMinor === null) {
      throw new HttpError(409, '采购单须已下单且有完整原币金额', 'PAYMENT_REQUEST_ORDER_NOT_ELIGIBLE');
    }
    if (state.paidMinor + state.heldMinor + add > state.orderMinor) {
      throw new HttpError(409, '实际付款与尚未结清的请款将超过采购单金额，请先核对额度和付款关联', 'PAYMENT_REQUEST_CAP_EXCEEDED');
    }
  }

  let mutation: Mutation;
  if (action === 'create') {
    if (state.order.currency !== input.currency) throw new HttpError(409, '请款币种与采购单不一致', 'PAYMENT_REQUEST_WRONG_CURRENCY');
    const submissionHash = await sha256Hex(stableJson({ businessType: input.businessType, amountMinor: input.amountMinor,
      dueOn: input.dueOn, reason: input.reason, reference: input.reference || null }));
    if (state.requests.some((row) => row.requestedByMemberId === actor.id && ['pending', 'approved'].includes(row.status)
      && row.submissionHash === submissionHash)) {
      throw new HttpError(409, '这张采购单已有内容相同、尚未关闭的请款', 'DUPLICATE_PAYMENT_REQUEST');
    }
    assertBudget(BigInt(input.amountMinor));
    mutation = {
      statement: db.prepare(`INSERT INTO purchase_payment_requests (id, tenant_id, purchase_order_id, requested_by_member_id,
        business_type, amount_minor, currency, due_on, reason, reference, submission_hash, status, version, last_operation_key, created_at, updated_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 1, ?, ?, ? WHERE ${conditions}
      `).bind(requestId, user.tenantId, orderId, actor.id, input.businessType, input.amountMinor, input.currency, input.dueOn,
        input.reason, input.reference || null, submissionHash, auditKey, now, now, ...bindings),
      affected: 'purchase_payment_requests WHERE tenant_id = ? AND id = ? AND last_operation_key = ?',
      bindings: [user.tenantId, requestId, auditKey], status: 'pending',
    };
  } else if (action === 'link' || action === 'unlink') {
    if (!request || request.status !== 'approved') throw requestConflict();
    if (action === 'link') {
      const payment = state.payments.find((row) => row.id === input.paymentId && row.kind === 'payment' && row.currency === request.currency);
      if (!payment) throw new HttpError(404, '找不到同一采购单、同一币种的实际付款记录', 'PAYMENT_REQUEST_ACTUAL_PAYMENT_NOT_FOUND');
      const paymentNet = netPayment(payment, state.payments);
      if (paymentNet <= zero || paymentNet + BigInt(request.linkedMinor) > BigInt(request.amountMinor)
        || state.links.some((row) => row.paymentId === payment.id && row.detachedAt === null)) {
        throw new HttpError(409, '付款已关联、已冲正或超过本次请款未结金额', 'PAYMENT_REQUEST_LINK_CONFLICT');
      }
      const linkId = crypto.randomUUID();
      mutation = {
        statement: db.prepare(`INSERT INTO purchase_payment_request_links (id, tenant_id, request_id, payment_id, linked_by_member_id, linked_at, last_operation_key)
          SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${conditions}`).bind(linkId, user.tenantId, requestId, payment.id, actor.id, now, auditKey, ...bindings),
        affected: 'purchase_payment_request_links WHERE tenant_id = ? AND id = ? AND last_operation_key = ?',
        bindings: [user.tenantId, linkId, auditKey], status: 'approved', relatedId: linkId,
      };
    } else {
      if (!state.links.some((row) => row.id === input.linkId && row.requestId === requestId && row.detachedAt === null)) throw requestConflict();
      mutation = {
        statement: db.prepare(`UPDATE purchase_payment_request_links SET detached_by_member_id = ?, detached_at = ?, last_operation_key = ?
          WHERE tenant_id = ? AND id = ? AND request_id = ? AND detached_at IS NULL AND ${conditions}`)
          .bind(actor.id, now, auditKey, user.tenantId, input.linkId, requestId, ...bindings),
        affected: 'purchase_payment_request_links WHERE tenant_id = ? AND id = ? AND last_operation_key = ?',
        bindings: [user.tenantId, input.linkId, auditKey], status: 'approved', relatedId: input.linkId,
      };
    }
  } else {
    if (!request) throw requestConflict();
    const reviewerAction = action === 'approve' || action === 'reject';
    if (reviewerAction && request.requestedByMemberId === actor.id) {
      throw new HttpError(403, '请由另一位有权限的人员审批，提交人不能审批自己的请款', 'PAYMENT_REQUEST_SELF_REVIEW');
    }
    if (action === 'withdraw' && request.requestedByMemberId !== actor.id) throw new HttpError(403, '只有提交人可以撤回请款', 'PAYMENT_REQUEST_WITHDRAW_DENIED');
    const previous = action === 'cancel' ? 'approved' : 'pending';
    if (request.status !== previous || (action === 'cancel' && request.linkCount > 0)) throw requestConflict();
    if (action === 'approve') assertBudget();
    const status = { approve: 'approved', reject: 'rejected', withdraw: 'withdrawn', cancel: 'cancelled' } as const;
    const fields = reviewerAction ? 'reviewed_by_member_id = ?, reviewed_at = ?, review_note = ?' : 'closed_by_member_id = ?, closed_at = ?, close_note = ?';
    mutation = {
      statement: db.prepare(`UPDATE purchase_payment_requests SET status = ?, version = version + 1, ${fields}, last_operation_key = ?, updated_at = ?
        WHERE tenant_id = ? AND id = ? AND version = ? AND status = ? AND ${conditions}`)
        .bind(status[action], actor.id, now, input.note || null, auditKey, now, user.tenantId, requestId, request.version, previous, ...bindings),
      affected: 'purchase_payment_requests WHERE tenant_id = ? AND id = ? AND last_operation_key = ?',
      bindings: [user.tenantId, requestId, auditKey], status: status[action],
    };
  }

  const after = stableJson({ requestHash: hash, status: mutation.status, action, relatedId: mutation.relatedId ?? null,
    note: 'note' in input ? input.note || null : null });
  const [write] = await db.batch([
    mutation.statement,
    db.prepare(`INSERT INTO audit_logs (id, tenant_id, actor_id, actor_email, action, entity_type, entity_id, before_json,
      after_json, request_id, idempotency_key, source, created_at)
      SELECT ?, ?, ?, ?, ?, 'purchase_payment_request', ?, ?, ?, ?, ?, 'human', ?
      WHERE EXISTS (SELECT 1 FROM ${mutation.affected}) AND ${uniqueOperation}`)
      .bind(crypto.randomUUID(), user.tenantId, user.id, user.email, `PURCHASE_PAYMENT_REQUEST_${action.toUpperCase()}`, requestId,
        known ? stableJson({ status: known.status, version: known.version }) : null, after, crypto.randomUUID(), auditKey, now,
        ...mutation.bindings, user.tenantId, auditKey),
  ]);
  if (write.meta.changes === 1) return { requestId, replayed: false };
  throw requestConflict();
}
