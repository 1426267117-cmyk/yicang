import { z } from 'zod';
import { sha256Hex, stableJson } from './connectors/stable';
import { HttpError, requirePermission, type UserContext } from './db';

const quantity = z.int().min(0).max(1_000_000);
const optionalText = z.string().trim().max(500).optional();
const inspectionLine = z.strictObject({
  purchaseOrderLineId: z.string().trim().min(1).max(160),
  passedQty: quantity,
  rejectedQty: quantity,
  defectReason: optionalText,
}).superRefine((line, context) => {
  if (line.passedQty + line.rejectedQty < 1 || line.passedQty + line.rejectedQty > 1_000_000) {
    context.addIssue({ code: 'custom', path: ['passedQty'], message: '单行本次质检件数应为 1 至 1,000,000' });
  }
  if (Boolean(line.defectReason) !== (line.rejectedQty > 0)) {
    context.addIssue({ code: 'custom', path: ['defectReason'], message: '有不合格件数时必须填写缺陷原因' });
  }
});

export const purchaseQualityMutationSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('require'), reason: z.string().trim().min(1).max(500) }),
  z.strictObject({
    action: z.literal('inspect'), batchReference: z.string().trim().min(1).max(100),
    note: optionalText, lines: z.array(inspectionLine).min(1).max(500),
  }).superRefine((input, context) => {
    if (new Set(input.lines.map((line) => line.purchaseOrderLineId)).size !== input.lines.length) {
      context.addIssue({ code: 'custom', path: ['lines'], message: '同一批次不应重复填写采购单明细' });
    }
  }),
]);
type Mutation = z.infer<typeof purchaseQualityMutationSchema>;

type QualityOrder = {
  id: string; orderNo: string; status: string; warehouseId: string | null;
  actorMemberId: string | null; purchaserMemberId: string;
  hasReceipt: number; requiredAt: string | null; requiredBy: string | null; requirementReason: string | null;
};

export type PurchaseQualityLine = {
  purchaseOrderLineId: string; skuCode: string; skuName: string;
  remainingQty: number; passedQty: number; rejectedQty: number;
  receivedGrossQty: number; availableQty: number; inspectableQty: number;
};

type InspectionLineView = {
  purchaseOrderLineId: string; skuCode: string; skuName: string;
  passedQty: number; rejectedQty: number; defectReason: string | null;
};

type InspectionView = {
  id: string; batchReference: string; inspectedBy: string;
  createdAt: string; note: string | null; lines: InspectionLineView[];
};

export type PurchaseQualityState = {
  orderId: string; orderNo: string; orderStatus: string;
  required: boolean; hasReceipt: boolean; canEnable: boolean; canInspect: boolean;
  requirement: { reason: string; createdAt: string; createdBy: string } | null;
  lines: PurchaseQualityLine[]; inspections: InspectionView[]; hasMoreInspections: boolean;
};

const enabledStatuses = new Set(['draft', 'issued']);
const receivableStatuses = new Set(['issued', 'partially_received']);
const warehouseQualityStatuses = new Set([...receivableStatuses, 'received', 'closed_short']);
const historyLimit = 50;

export async function readPurchaseQuality(
  db: D1Database, user: UserContext, orderId: string, includeHistory = true,
): Promise<PurchaseQualityState> {
  const canReadPurchase = user.permissions.includes('purchase:read');
  if (!canReadPurchase) requirePermission(user, 'warehouse:read');
  const order = await readQualityOrder(db, user, orderId);
  if (!canReadPurchase && !warehouseQualityStatuses.has(order.status)) {
    throw new HttpError(404, '可收货的采购单不存在或不在当前工作区', 'PURCHASE_ORDER_NOT_FOUND');
  }
  const isRequired = order.requiredAt !== null;
  const receivable = Boolean(order.warehouseId) && receivableStatuses.has(order.status);
  const [lines, history] = await Promise.all([
    readQualityLines(db, user.tenantId, orderId, isRequired, receivable),
    includeHistory && isRequired ? readQualityHistory(db, user.tenantId, orderId) : null,
  ]);
  return {
    orderId: order.id, orderNo: order.orderNo, orderStatus: order.status,
    required: isRequired, hasReceipt: order.hasReceipt === 1,
    canEnable: canEnableQuality(user, order),
    canInspect: isRequired && receivable
      && user.permissions.includes('inventory:receive') && lines.some((line) => line.inspectableQty > 0),
    requirement: order.requiredAt && order.requirementReason ? {
      reason: order.requirementReason, createdAt: order.requiredAt, createdBy: order.requiredBy ?? '—',
    } : null,
    lines, inspections: history?.inspections ?? [], hasMoreInspections: history?.hasMore ?? false,
  };
}

export async function writePurchaseQuality(
  db: D1Database, user: UserContext, orderId: string, input: Mutation, operationKey: string,
) {
  if (!user.permissions.includes('warehouse:read')) requirePermission(user, 'purchase:read');
  requirePermission(user, input.action === 'require' ? 'purchase:order:issue' : 'inventory:receive');
  if (!/^[a-zA-Z0-9._:-]{8,128}$/u.test(operationKey)) {
    throw new HttpError(400, '质检操作缺少有效的去重标识', 'INVALID_IDEMPOTENCY_KEY');
  }
  const normalized = input.action === 'require' ? input : {
    ...input, note: input.note || undefined,
    lines: [...input.lines].map((line) => ({ ...line, defectReason: line.defectReason || undefined }))
      .sort((left, right) => left.purchaseOrderLineId.localeCompare(right.purchaseOrderLineId)),
  };
  const hash = await sha256Hex(stableJson([orderId, normalized]));
  if (await isReplay(db, user.tenantId, orderId, normalized.action, operationKey, hash)) return { replayed: true };

  const order = await readQualityOrder(db, user, orderId);
  if (!order.actorMemberId) throw new HttpError(403, '当前账号不在采购工作区', 'PERMISSION_DENIED');
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [];
  let entityId = orderId;

  if (normalized.action === 'require') {
    if (order.requiredAt) {
      if (await isReplay(db, user.tenantId, orderId, normalized.action, operationKey, hash)) return { replayed: true };
      throw new HttpError(409, '该采购单已设置到货质检', 'PURCHASE_QUALITY_ALREADY_REQUIRED');
    }
    if (user.role !== 'admin' && order.actorMemberId !== order.purchaserMemberId) {
      throw new HttpError(403, '由本单采购员或管理员设置到货质检', 'PERMISSION_DENIED');
    }
    if (!canEnableQuality(user, order)) throw requirementClosed();
    statements.push(db.prepare(`
      INSERT INTO purchase_quality_requirements (
        purchase_order_id, tenant_id, reason, created_by_member_id, operation_key, request_hash, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(orderId, user.tenantId, normalized.reason, order.actorMemberId, operationKey, hash, now));
  } else {
    if (!order.requiredAt || !order.warehouseId || !receivableStatuses.has(order.status)) {
      if (await isReplay(db, user.tenantId, orderId, normalized.action, operationKey, hash)) return { replayed: true };
      throw inspectionClosed();
    }
    entityId = crypto.randomUUID();
    statements.push(db.prepare(`
      INSERT INTO purchase_quality_inspections (
        id, tenant_id, purchase_order_id, batch_reference, note, created_by_member_id, operation_key, request_hash, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(entityId, user.tenantId, orderId, normalized.batchReference, normalized.note ?? null,
      order.actorMemberId, operationKey, hash, now));
    for (const line of normalized.lines) {
      statements.push(db.prepare(`
        INSERT INTO purchase_quality_inspection_lines (
          id, tenant_id, inspection_id, purchase_order_line_id, passed_qty, rejected_qty, defect_reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(crypto.randomUUID(), user.tenantId, entityId, line.purchaseOrderLineId,
        line.passedQty, line.rejectedQty, line.defectReason ?? null));
    }
  }

  const auditAction = normalized.action === 'require' ? 'REQUIRE_PURCHASE_QUALITY' : 'POST_PURCHASE_INSPECTION';
  const entityType = normalized.action === 'require' ? 'purchase_quality_requirement' : 'purchase_quality_inspection';
  statements.push(db.prepare(`
    INSERT INTO audit_logs (
      id, tenant_id, actor_id, actor_email, action, entity_type, entity_id, before_json, after_json,
      request_id, idempotency_key, source, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 'ui', ?)
  `).bind(crypto.randomUUID(), user.tenantId, user.id, user.email, auditAction, entityType, entityId,
    JSON.stringify({ purchaseOrderId: orderId, ...normalized }), crypto.randomUUID(), `purchase-quality:${normalized.action}:${operationKey}`, now));

  try {
    await db.batch(statements);
  } catch (error) {
    if (await isReplay(db, user.tenantId, orderId, normalized.action, operationKey, hash)) return { replayed: true };
    const message = String(error);
    if (message.includes('PURCHASE_QUALITY_REQUIREMENT_CLOSED')) throw requirementClosed();
    if (message.includes('PURCHASE_QUALITY_NOT_INSPECTABLE')) throw inspectionClosed();
    if (message.includes('PURCHASE_QUALITY_LINE_INVALID')) {
      throw new HttpError(400, '质检明细包含不属于本采购单的商品行', 'PURCHASE_QUALITY_LINE_INVALID');
    }
    if (message.includes('PURCHASE_QUALITY_EXCEEDS_INSPECTABLE')) {
      throw new HttpError(409, '本次质检数量超过剩余可检数量，请刷新后核对批次', 'PURCHASE_QUALITY_EXCEEDS_INSPECTABLE');
    }
    if (normalized.action === 'inspect' && message.includes('uq_purchase_quality_inspections_batch')) {
      throw new HttpError(409, '该采购单已登记过此质检批次', 'PURCHASE_QUALITY_DUPLICATE_BATCH');
    }
    if (normalized.action === 'require' && message.includes('purchase_quality_requirements.purchase_order_id')) {
      throw new HttpError(409, '该采购单已设置到货质检', 'PURCHASE_QUALITY_ALREADY_REQUIRED');
    }
    throw error;
  }
  return { replayed: false };
}

async function readQualityOrder(db: D1Database, user: UserContext, orderId: string) {
  const order = await db.prepare(`
    SELECT po.id, po.order_no AS orderNo, po.status, po.delivery_warehouse_id AS warehouseId,
      member.id AS actorMemberId, request.purchaser_member_id AS purchaserMemberId, requirement.created_at AS requiredAt,
      setter.display_name AS requiredBy, requirement.reason AS requirementReason,
      EXISTS (SELECT 1 FROM purchase_receipts receipt WHERE receipt.tenant_id = po.tenant_id AND receipt.purchase_order_id = po.id) AS hasReceipt
    FROM purchase_orders po
    JOIN purchase_requests request ON request.id = po.purchase_request_id AND request.tenant_id = po.tenant_id
    LEFT JOIN members member ON member.auth_user_id = ? AND member.tenant_id = po.tenant_id
    LEFT JOIN purchase_quality_requirements requirement ON requirement.purchase_order_id = po.id AND requirement.tenant_id = po.tenant_id
    LEFT JOIN members setter ON setter.id = requirement.created_by_member_id AND setter.tenant_id = po.tenant_id
    WHERE po.tenant_id = ? AND po.id = ?
  `).bind(user.id, user.tenantId, orderId).first<QualityOrder>();
  if (!order) throw new HttpError(404, '采购单不存在或不在当前数据范围内', 'PURCHASE_ORDER_NOT_FOUND');
  return order;
}

function canEnableQuality(user: UserContext, order: QualityOrder) {
  return !order.requiredAt && !order.hasReceipt && Boolean(order.warehouseId && order.actorMemberId)
    && enabledStatuses.has(order.status) && user.permissions.includes('purchase:order:issue')
    && (user.role === 'admin' || order.purchaserMemberId === order.actorMemberId);
}

async function readQualityLines(db: D1Database, tenantId: string, orderId: string, required: boolean, receivable: boolean) {
  const { results } = await db.prepare(`
    SELECT line.id AS purchaseOrderLineId, line.sku_code_snapshot AS skuCode, line.sku_name_snapshot AS skuName,
      line.ordered_quantity - line.received_quantity AS remainingQty,
      COALESCE((SELECT SUM(checked.passed_qty) FROM purchase_quality_inspection_lines checked
        WHERE checked.tenant_id = line.tenant_id AND checked.purchase_order_line_id = line.id), 0) AS passedQty,
      COALESCE((SELECT SUM(checked.rejected_qty) FROM purchase_quality_inspection_lines checked
        WHERE checked.tenant_id = line.tenant_id AND checked.purchase_order_line_id = line.id), 0) AS rejectedQty,
      COALESCE((SELECT SUM(received.quantity) FROM purchase_receipt_lines received
        WHERE received.tenant_id = line.tenant_id AND received.purchase_order_line_id = line.id), 0) AS receivedGrossQty
    FROM purchase_order_lines line WHERE line.tenant_id = ? AND line.purchase_order_id = ?
    ORDER BY line.created_at, line.id
  `).bind(tenantId, orderId).all<Omit<PurchaseQualityLine, 'availableQty' | 'inspectableQty'>>();
  return results.map((line) => {
    const released = required ? Math.max(0, Math.min(line.remainingQty, line.passedQty - line.receivedGrossQty)) : line.remainingQty;
    return { ...line, availableQty: receivable ? released : 0,
      inspectableQty: required && receivable ? line.remainingQty - released : 0 };
  });
}

async function readQualityHistory(db: D1Database, tenantId: string, orderId: string) {
  const { results } = await db.prepare(`
    SELECT inspection.id, inspection.batch_reference AS batchReference, inspection.note,
      inspection.created_at AS createdAt, member.display_name AS inspectedBy,
      line.purchase_order_line_id AS purchaseOrderLineId, purchase_line.sku_code_snapshot AS skuCode,
      purchase_line.sku_name_snapshot AS skuName, line.passed_qty AS passedQty,
      line.rejected_qty AS rejectedQty, line.defect_reason AS defectReason
    FROM (
      SELECT * FROM purchase_quality_inspections WHERE tenant_id = ? AND purchase_order_id = ?
      ORDER BY created_at DESC, id DESC LIMIT ?
    ) AS inspection
    JOIN members member ON member.id = inspection.created_by_member_id AND member.tenant_id = inspection.tenant_id
    JOIN purchase_quality_inspection_lines line ON line.inspection_id = inspection.id AND line.tenant_id = inspection.tenant_id
    JOIN purchase_order_lines purchase_line ON purchase_line.id = line.purchase_order_line_id AND purchase_line.tenant_id = line.tenant_id
    ORDER BY inspection.created_at DESC, inspection.id DESC, purchase_line.sku_code_snapshot, line.id
  `).bind(tenantId, orderId, historyLimit + 1).all<Omit<InspectionView, 'lines'> & InspectionLineView>();
  const groups = new Map<string, InspectionView>();
  for (const row of results) {
    const { id, batchReference, note, createdAt, inspectedBy, ...line } = row;
    let current = groups.get(id);
    if (!current) {
      current = { id, batchReference, note, createdAt, inspectedBy, lines: [] };
      groups.set(id, current);
    }
    current.lines.push(line);
  }
  return { inspections: [...groups.values()].slice(0, historyLimit), hasMore: groups.size > historyLimit };
}

async function isReplay(db: D1Database, tenantId: string, orderId: string, action: Mutation['action'], key: string, hash: string) {
  const table = action === 'require' ? 'purchase_quality_requirements' : 'purchase_quality_inspections';
  const previous = await db.prepare(`
    SELECT purchase_order_id, request_hash FROM ${table} WHERE tenant_id = ? AND operation_key = ?
  `).bind(tenantId, key).first<{ purchase_order_id: string; request_hash: string }>();
  if (!previous) return false;
  if (previous.purchase_order_id !== orderId || previous.request_hash !== hash) {
    throw new HttpError(409, '同一个质检操作已用于不同内容', 'IDEMPOTENCY_CONFLICT');
  }
  return true;
}

function requirementClosed() {
  return new HttpError(409, '只能为已指定收货仓且从未入库的采购单启用质检', 'PURCHASE_QUALITY_REQUIREMENT_CLOSED');
}

function inspectionClosed() {
  return new HttpError(409, '请核对采购单已下单、启用质检且尚有待收数量', 'PURCHASE_QUALITY_NOT_INSPECTABLE');
}
