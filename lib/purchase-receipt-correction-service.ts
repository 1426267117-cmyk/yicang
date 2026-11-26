import { z } from 'zod';

import { sha256Hex, stableJson } from './connectors/stable';
import { HttpError, requirePermission, type UserContext } from './db';
import { getPurchaseOrder, getPurchaseReceipt } from './purchase-order-service';

const correctionLineSchema = z.object({
  purchaseReceiptLineId: z.string().trim().min(1),
  quantity: z.number().int().positive().max(1_000_000),
});

export const createPurchaseReceiptCorrectionSchema = z.object({
  reason: z.string().trim().min(2, '冲正原因至少填写 2 个字').max(500),
  lines: z.array(correctionLineSchema).min(1).max(500),
}).superRefine((value, context) => {
  const lineIds = value.lines.map((line) => line.purchaseReceiptLineId);
  if (new Set(lineIds).size !== lineIds.length) {
    context.addIssue({ code: 'custom', message: '同一次冲正不能重复填写收货明细', path: ['lines'] });
  }
});

export type CreatePurchaseReceiptCorrectionInput = z.infer<typeof createPurchaseReceiptCorrectionSchema>;

type CorrectionHeaderRow = {
  id: string;
  correction_no: string;
  purchase_receipt_id: string;
  purchase_receipt_no: string;
  purchase_order_id: string;
  purchase_order_no: string;
  warehouse_id: string;
  warehouse_code: string;
  warehouse_name: string;
  status: 'posted';
  reason: string;
  created_by_member_id: string;
  created_by_email: string;
  created_by_name: string;
  created_at: string;
  line_count: number;
  total_quantity: number;
};

type CorrectionLineRow = {
  id: string;
  correction_id: string;
  purchase_receipt_line_id: string;
  purchase_order_line_id: string;
  sku_id: string;
  sku_code: string;
  sku_name: string;
  warehouse_id: string;
  quantity: number;
};

type ReceiptCorrectionTargetRow = {
  id: string;
  purchase_order_line_id: string;
  sku_id: string;
  warehouse_id: string;
  original_quantity: number;
  corrected_quantity: number;
  on_hand_qty: number;
  reserved_qty: number;
};

/**
 * Appends a correction fact for a posted purchase receipt. The original receipt and
 * its lines are never updated or deleted. Database triggers atomically post the
 * compensating stock movement and recalculate the purchase-order receipt status.
 */
export async function createPurchaseReceiptCorrection(
  db: D1Database,
  user: UserContext,
  purchaseReceiptId: string,
  input: CreatePurchaseReceiptCorrectionInput,
  idempotencyKey: string,
) {
  requirePermission(user, 'inventory:receive');
  validateIdempotencyKey(idempotencyKey);
  const normalized = {
    purchaseReceiptId: purchaseReceiptId.trim(),
    reason: input.reason.trim(),
    lines: [...input.lines]
      .map((line) => ({
        purchaseReceiptLineId: line.purchaseReceiptLineId.trim(),
        quantity: line.quantity,
      }))
      .sort((left, right) => left.purchaseReceiptLineId.localeCompare(right.purchaseReceiptLineId)),
  };
  if (!normalized.purchaseReceiptId) {
    throw new HttpError(400, '收货单标识不能为空', 'INVALID_PURCHASE_RECEIPT_ID');
  }
  const requestHash = await sha256Hex(stableJson(normalized));
  const replay = await findReplay(db, user.tenantId, idempotencyKey);
  if (replay) {
    assertReplay(replay, normalized.purchaseReceiptId, requestHash);
    return correctionResult(db, user.tenantId, replay.id, true);
  }

  const [receipt, targetLines, actor] = await Promise.all([
    db.prepare(`
      SELECT id, purchase_order_id, warehouse_id, status
      FROM purchase_receipts
      WHERE tenant_id = ? AND id = ?
      LIMIT 1
    `).bind(user.tenantId, normalized.purchaseReceiptId).first<{
      id: string;
      purchase_order_id: string;
      warehouse_id: string;
      status: string;
    }>(),
    loadCorrectionTargets(
      db,
      user.tenantId,
      normalized.purchaseReceiptId,
      normalized.lines.map((line) => line.purchaseReceiptLineId),
    ),
    db.prepare(`
      SELECT id FROM members
      WHERE tenant_id = ? AND auth_user_id = ?
      LIMIT 1
    `).bind(user.tenantId, user.id).first<{ id: string }>(),
  ]);
  if (!receipt || receipt.status !== 'posted') {
    throw new HttpError(404, '收货单不存在或不在当前数据范围内', 'PURCHASE_RECEIPT_NOT_FOUND');
  }
  if (!actor) {
    throw new HttpError(409, '当前操作人尚未加入采购工作区', 'PURCHASE_MEMBER_NOT_FOUND');
  }
  if (targetLines.length !== normalized.lines.length) {
    throw new HttpError(400, '冲正明细包含不属于该收货单的行', 'PURCHASE_RECEIPT_CORRECTION_LINE_INVALID');
  }
  const targetById = new Map(targetLines.map((line) => [line.id, line]));
  for (const line of normalized.lines) {
    const target = targetById.get(line.purchaseReceiptLineId)!;
    if (line.quantity > target.original_quantity - target.corrected_quantity) {
      throw new HttpError(409, '冲正数量超过该收货行尚可冲正数量', 'PURCHASE_RECEIPT_CORRECTION_EXCEEDS_RECEIPT');
    }
    if (target.on_hand_qty - line.quantity < target.reserved_qty) {
      throw new HttpError(
        409,
        '该批库存已经被占用或消耗，不能直接冲正；请先解除库存占用后重试',
        'PURCHASE_RECEIPT_CORRECTION_INVENTORY_UNAVAILABLE',
      );
    }
  }

  const correctionId = crypto.randomUUID();
  const correctionNo = createDocumentNumber('SHCZ');
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [
    db.prepare(`
      INSERT INTO purchase_receipt_corrections (
        id, tenant_id, correction_no, purchase_receipt_id, purchase_order_id,
        warehouse_id, status, reason, idempotency_key, request_hash,
        created_by_member_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'posted', ?, ?, ?, ?, ?)
    `).bind(
      correctionId,
      user.tenantId,
      correctionNo,
      receipt.id,
      receipt.purchase_order_id,
      receipt.warehouse_id,
      normalized.reason,
      idempotencyKey,
      requestHash,
      actor.id,
      now,
    ),
  ];
  for (const line of normalized.lines) {
    const target = targetById.get(line.purchaseReceiptLineId)!;
    statements.push(db.prepare(`
      INSERT INTO purchase_receipt_correction_lines (
        id, tenant_id, correction_id, purchase_receipt_line_id,
        purchase_order_line_id, sku_id, warehouse_id, quantity, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      crypto.randomUUID(),
      user.tenantId,
      correctionId,
      line.purchaseReceiptLineId,
      target.purchase_order_line_id,
      target.sku_id,
      target.warehouse_id,
      line.quantity,
      now,
    ));
  }
  statements.push(db.prepare(`
    INSERT INTO audit_logs (
      id, tenant_id, actor_id, actor_email, action, entity_type, entity_id,
      before_json, after_json, request_id, idempotency_key, source, created_at
    ) VALUES (?, ?, ?, ?, 'CORRECT_PURCHASE_RECEIPT', 'purchase_receipt_correction', ?, ?, ?, ?, ?, 'human', ?)
  `).bind(
    crypto.randomUUID(),
    user.tenantId,
    user.id,
    user.email,
    correctionId,
    stableJson({ purchaseReceiptId: receipt.id, purchaseOrderId: receipt.purchase_order_id }),
    stableJson({
      requestHash,
      correctionNo,
      purchaseReceiptId: receipt.id,
      purchaseOrderId: receipt.purchase_order_id,
      reason: normalized.reason,
      totalQuantity: normalized.lines.reduce((sum, line) => sum + line.quantity, 0),
    }),
    crypto.randomUUID(),
    idempotencyKey,
    now,
  ));

  try {
    await db.batch(statements);
  } catch (error) {
    const concurrentReplay = await findReplay(db, user.tenantId, idempotencyKey);
    if (concurrentReplay) {
      assertReplay(concurrentReplay, normalized.purchaseReceiptId, requestHash);
      return correctionResult(db, user.tenantId, concurrentReplay.id, true);
    }
    throw translateCorrectionError(error);
  }
  return correctionResult(db, user.tenantId, correctionId, false);
}

export async function listPurchaseReceiptCorrections(
  db: D1Database,
  user: UserContext,
  purchaseReceiptId: string,
) {
  if (!user.permissions.includes('warehouse:read')) requirePermission(user, 'purchase:read');
  const normalizedId = purchaseReceiptId.trim();
  const receipt = await db.prepare(`
    SELECT id FROM purchase_receipts WHERE tenant_id = ? AND id = ? LIMIT 1
  `).bind(user.tenantId, normalizedId).first<{ id: string }>();
  if (!receipt) {
    throw new HttpError(404, '收货单不存在或不在当前数据范围内', 'PURCHASE_RECEIPT_NOT_FOUND');
  }
  const rows = await db.prepare(`${CORRECTION_HEADER_SELECT}
    WHERE correction.tenant_id = ? AND correction.purchase_receipt_id = ?
    GROUP BY correction.id
    ORDER BY correction.created_at DESC
  `).bind(user.tenantId, normalizedId).all<CorrectionHeaderRow>();
  const corrections = [];
  for (const row of rows.results) {
    corrections.push(await mapCorrectionWithLines(db, user.tenantId, row));
  }
  return corrections;
}

export async function getPurchaseReceiptCorrection(
  db: D1Database,
  tenantId: string,
  correctionId: string,
) {
  const row = await db.prepare(`${CORRECTION_HEADER_SELECT}
    WHERE correction.tenant_id = ? AND correction.id = ?
    GROUP BY correction.id
    LIMIT 1
  `).bind(tenantId, correctionId).first<CorrectionHeaderRow>();
  if (!row) {
    throw new HttpError(404, '收货冲正单不存在或不在当前数据范围内', 'PURCHASE_RECEIPT_CORRECTION_NOT_FOUND');
  }
  return mapCorrectionWithLines(db, tenantId, row);
}

async function correctionResult(db: D1Database, tenantId: string, correctionId: string, replayed: boolean) {
  const correction = await getPurchaseReceiptCorrection(db, tenantId, correctionId);
  return {
    correction,
    purchaseReceipt: await getPurchaseReceipt(db, tenantId, correction.purchaseReceiptId),
    purchaseOrder: await getPurchaseOrder(db, tenantId, correction.purchaseOrderId),
    replayed,
  };
}

async function loadCorrectionTargets(
  db: D1Database,
  tenantId: string,
  purchaseReceiptId: string,
  lineIds: string[],
) {
  if (lineIds.length === 0) return [];
  const placeholders = lineIds.map(() => '?').join(', ');
  const rows = await db.prepare(`
    SELECT
      line.id,
      line.purchase_order_line_id,
      line.sku_id,
      line.warehouse_id,
      line.quantity AS original_quantity,
      COALESCE(SUM(correction_line.quantity), 0) AS corrected_quantity,
      balance.on_hand_qty,
      balance.reserved_qty
    FROM purchase_receipt_lines line
    JOIN purchase_receipts receipt
      ON receipt.id = line.purchase_receipt_id AND receipt.tenant_id = line.tenant_id
    JOIN inventory_balances balance
      ON balance.tenant_id = line.tenant_id
      AND balance.sku_id = line.sku_id
      AND balance.warehouse_id = line.warehouse_id
    LEFT JOIN purchase_receipt_correction_lines correction_line
      ON correction_line.tenant_id = line.tenant_id
      AND correction_line.purchase_receipt_line_id = line.id
    WHERE line.tenant_id = ? AND line.purchase_receipt_id = ?
      AND line.id IN (${placeholders})
    GROUP BY line.id
  `).bind(tenantId, purchaseReceiptId, ...lineIds).all<ReceiptCorrectionTargetRow>();
  return rows.results;
}

async function mapCorrectionWithLines(db: D1Database, tenantId: string, row: CorrectionHeaderRow) {
  const lineRows = await db.prepare(`${CORRECTION_LINE_SELECT}
    WHERE correction.tenant_id = ? AND correction.id = ?
    ORDER BY line.created_at, line.id
  `).bind(tenantId, row.id).all<CorrectionLineRow>();
  return {
    id: row.id,
    correctionNo: row.correction_no,
    purchaseReceiptId: row.purchase_receipt_id,
    purchaseReceiptNo: row.purchase_receipt_no,
    purchaseOrderId: row.purchase_order_id,
    purchaseOrderNo: row.purchase_order_no,
    warehouse: {
      id: row.warehouse_id,
      code: row.warehouse_code,
      name: row.warehouse_name,
    },
    status: row.status,
    reason: row.reason,
    createdBy: {
      memberId: row.created_by_member_id,
      email: row.created_by_email,
      displayName: row.created_by_name,
    },
    createdAt: row.created_at,
    lineCount: Number(row.line_count),
    totalQuantity: Number(row.total_quantity),
    lines: lineRows.results.map((line) => ({
      id: line.id,
      purchaseReceiptLineId: line.purchase_receipt_line_id,
      purchaseOrderLineId: line.purchase_order_line_id,
      skuId: line.sku_id,
      skuCode: line.sku_code,
      skuName: line.sku_name,
      warehouseId: line.warehouse_id,
      quantity: Number(line.quantity),
    })),
  };
}

async function findReplay(db: D1Database, tenantId: string, idempotencyKey: string) {
  return db.prepare(`
    SELECT id, purchase_receipt_id, request_hash
    FROM purchase_receipt_corrections
    WHERE tenant_id = ? AND idempotency_key = ?
    LIMIT 1
  `).bind(tenantId, idempotencyKey).first<{
    id: string;
    purchase_receipt_id: string;
    request_hash: string;
  }>();
}

function assertReplay(
  replay: { purchase_receipt_id: string; request_hash: string },
  purchaseReceiptId: string,
  requestHash: string,
) {
  if (replay.purchase_receipt_id !== purchaseReceiptId || replay.request_hash !== requestHash) {
    throw new HttpError(409, '同一幂等键不能用于不同的收货冲正参数', 'IDEMPOTENCY_CONFLICT');
  }
}

function validateIdempotencyKey(key: string) {
  if (!key || key.length < 8 || key.length > 128) {
    throw new HttpError(400, '缺少有效的 Idempotency-Key', 'INVALID_IDEMPOTENCY_KEY');
  }
}

function createDocumentNumber(prefix: string) {
  const date = new Date().toISOString().slice(2, 10).replaceAll('-', '');
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 6).toUpperCase();
  return `${prefix}${date}-${suffix}`;
}

function translateCorrectionError(error: unknown): unknown {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('CORRECTION_EXCEEDS_RECEIPT')) {
    return new HttpError(409, '冲正数量超过该收货行尚可冲正数量', 'PURCHASE_RECEIPT_CORRECTION_EXCEEDS_RECEIPT');
  }
  if (message.includes('CORRECTION_INVENTORY_UNAVAILABLE')
    || message.includes('ck_inventory_non_negative')
    || message.includes('ck_inventory_reserved_lte_on_hand')) {
    return new HttpError(
      409,
      '该批库存已经被占用或消耗，不能直接冲正；请先解除库存占用后重试',
      'PURCHASE_RECEIPT_CORRECTION_INVENTORY_UNAVAILABLE',
    );
  }
  if (message.includes('INVALID_RECEIPT_CORRECTION')
    || message.includes('INVALID_RECEIPT_CORRECTION_LINE')) {
    return new HttpError(409, '收货冲正数据已经变化，请刷新后重试', 'PURCHASE_RECEIPT_CORRECTION_CONFLICT');
  }
  return error;
}

const CORRECTION_HEADER_SELECT = `
  SELECT
    correction.id,
    correction.correction_no,
    correction.purchase_receipt_id,
    receipt.receipt_no AS purchase_receipt_no,
    correction.purchase_order_id,
    purchase_order.order_no AS purchase_order_no,
    correction.warehouse_id,
    warehouse.code AS warehouse_code,
    warehouse.name AS warehouse_name,
    correction.status,
    correction.reason,
    correction.created_by_member_id,
    member.email AS created_by_email,
    member.display_name AS created_by_name,
    correction.created_at,
    COUNT(line.id) AS line_count,
    COALESCE(SUM(line.quantity), 0) AS total_quantity
  FROM purchase_receipt_corrections correction
  JOIN purchase_receipts receipt
    ON receipt.id = correction.purchase_receipt_id AND receipt.tenant_id = correction.tenant_id
  JOIN purchase_orders purchase_order
    ON purchase_order.id = correction.purchase_order_id AND purchase_order.tenant_id = correction.tenant_id
  JOIN warehouses warehouse
    ON warehouse.id = correction.warehouse_id AND warehouse.tenant_id = correction.tenant_id
  JOIN members member
    ON member.id = correction.created_by_member_id AND member.tenant_id = correction.tenant_id
  LEFT JOIN purchase_receipt_correction_lines line
    ON line.correction_id = correction.id AND line.tenant_id = correction.tenant_id
`;

const CORRECTION_LINE_SELECT = `
  SELECT
    line.id,
    line.correction_id,
    line.purchase_receipt_line_id,
    line.purchase_order_line_id,
    line.sku_id,
    sku.code AS sku_code,
    sku.name AS sku_name,
    line.warehouse_id,
    line.quantity
  FROM purchase_receipt_correction_lines line
  JOIN purchase_receipt_corrections correction
    ON correction.id = line.correction_id AND correction.tenant_id = line.tenant_id
  JOIN skus sku ON sku.id = line.sku_id AND sku.tenant_id = line.tenant_id
`;
