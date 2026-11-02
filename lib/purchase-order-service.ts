import type {
  CreatePurchaseOrderInput,
  CreatePurchaseReceiptInput,
  CreateSupplierInput,
  CreateWarehouseInput,
  PurchaseOrderActionInput,
} from './contracts';
import { HttpError, requirePermission, type UserContext } from './db';
import { sha256Hex, stableJson } from './connectors/stable';

type PurchaseOrderStatus = 'draft' | 'issued' | 'partially_received' | 'received' | 'closed_short' | 'cancelled';

type SupplierRow = {
  id: string;
  code: string;
  name: string;
  note: string | null;
  active: number;
  version: number;
  request_hash?: string;
  created_at: string;
  updated_at: string;
};

type WarehouseRow = {
  id: string;
  code: string;
  name: string;
  created_at: string;
};

type PurchaseOrderRow = {
  id: string;
  order_no: string;
  purchase_request_id: string;
  purchase_request_no: string;
  purchaser_member_id: string;
  supplier_id: string;
  supplier_code: string;
  supplier_name: string;
  status: PurchaseOrderStatus;
  currency: string | null;
  note: string | null;
  action_note: string | null;
  version: number;
  request_hash?: string;
  issued_at: string | null;
  closed_at: string | null;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
  line_count: number;
  ordered_quantity: number;
  received_quantity: number;
};

type PurchaseOrderLineRow = {
  id: string;
  purchase_order_id: string;
  purchase_request_line_id: string;
  sku_id: string;
  sku_code: string;
  sku_name: string;
  ordered_quantity: number;
  received_quantity: number;
  unit_cost_minor: number | null;
  currency: string | null;
};

type PurchaseReceiptRow = {
  id: string;
  receipt_no: string;
  purchase_order_id: string;
  purchase_order_no: string;
  warehouse_id: string;
  warehouse_code: string;
  warehouse_name: string;
  status: 'posted';
  note: string | null;
  request_hash?: string;
  received_at: string;
  created_at: string;
  line_count: number;
  total_quantity: number;
  corrected_quantity: number;
  correction_count: number;
};

type PurchaseReceiptLineRow = {
  id: string;
  purchase_receipt_id: string;
  purchase_order_line_id: string;
  sku_id: string;
  sku_code: string;
  sku_name: string;
  warehouse_id: string;
  quantity: number;
};

type RequestLineRow = {
  id: string;
  sku_id: string;
  sku_code: string;
  sku_name: string;
  requested_quantity: number;
  active: number;
  demand_status: string | null;
  demand_mapped_sku_id: string | null;
  demand_required_quantity: number | null;
  demand_source_updated_at: string | null;
  source_updated_at: string;
};

type ReceiptTargetLineRow = {
  id: string;
  sku_id: string;
  ordered_quantity: number;
  received_quantity: number;
};

type ProcurementSummaryRow = {
  suppliers: number;
  draft_orders: number;
  issued_orders: number;
  partially_received_orders: number;
  received_orders: number;
  closed_short_orders: number;
  pending_receipt_quantity: number;
  receipt_count: number;
  correction_count: number;
  corrected_quantity: number;
  received_quantity: number;
};

export async function getProcurementWorkspaceData(db: D1Database, user: UserContext) {
  requirePermission(user, 'purchase:read');
  const [
    supplierRows,
    warehouseRows,
    orderRows,
    orderLineRows,
    receiptRows,
    receiptLineRows,
    summaryRow,
  ] = await Promise.all([
    db.prepare(`
      SELECT id, code, name, note, active, version, created_at, updated_at
      FROM suppliers
      WHERE tenant_id = ?
      ORDER BY active DESC, name, code
      LIMIT 500
    `).bind(user.tenantId).all<SupplierRow>(),
    db.prepare(`
      SELECT id, code, name
      FROM warehouses
      WHERE tenant_id = ?
      ORDER BY code, name
      LIMIT 500
    `).bind(user.tenantId).all<{ id: string; code: string; name: string }>(),
    db.prepare(`${PURCHASE_ORDER_SELECT}
      WHERE po.tenant_id = ?
      GROUP BY po.id
      ORDER BY po.created_at DESC, po.id DESC
      LIMIT 500
    `).bind(user.tenantId).all<PurchaseOrderRow>(),
    db.prepare(`${PURCHASE_ORDER_LINE_SELECT}
      WHERE po.tenant_id = ?
        AND po.id IN (
          SELECT recent.id
          FROM purchase_orders recent
          WHERE recent.tenant_id = ?
          ORDER BY recent.created_at DESC, recent.id DESC
          LIMIT 500
        )
      ORDER BY po.created_at DESC, po.id DESC, line.created_at ASC, line.id ASC
    `).bind(user.tenantId, user.tenantId).all<PurchaseOrderLineRow>(),
    db.prepare(`${PURCHASE_RECEIPT_SELECT}
      WHERE receipt.tenant_id = ?
      GROUP BY receipt.id
      ORDER BY receipt.created_at DESC, receipt.id DESC
      LIMIT 500
    `).bind(user.tenantId).all<PurchaseReceiptRow>(),
    db.prepare(`${PURCHASE_RECEIPT_LINE_SELECT}
      WHERE receipt.tenant_id = ?
        AND receipt.id IN (
          SELECT recent.id
          FROM purchase_receipts recent
          WHERE recent.tenant_id = ?
          ORDER BY recent.created_at DESC, recent.id DESC
          LIMIT 500
        )
      ORDER BY receipt.created_at DESC, receipt.id DESC, line.created_at ASC, line.id ASC
    `).bind(user.tenantId, user.tenantId).all<PurchaseReceiptLineRow>(),
    db.prepare(`
      WITH tenant_scope AS (SELECT ? AS tenant_id)
      SELECT
        (SELECT COUNT(*) FROM suppliers supplier, tenant_scope scope
          WHERE supplier.tenant_id = scope.tenant_id AND supplier.active = 1) AS suppliers,
        (SELECT COUNT(*) FROM purchase_orders purchase_order, tenant_scope scope
          WHERE purchase_order.tenant_id = scope.tenant_id AND purchase_order.status = 'draft') AS draft_orders,
        (SELECT COUNT(*) FROM purchase_orders purchase_order, tenant_scope scope
          WHERE purchase_order.tenant_id = scope.tenant_id AND purchase_order.status = 'issued') AS issued_orders,
        (SELECT COUNT(*) FROM purchase_orders purchase_order, tenant_scope scope
          WHERE purchase_order.tenant_id = scope.tenant_id AND purchase_order.status = 'partially_received') AS partially_received_orders,
        (SELECT COUNT(*) FROM purchase_orders purchase_order, tenant_scope scope
          WHERE purchase_order.tenant_id = scope.tenant_id AND purchase_order.status = 'received') AS received_orders,
        (SELECT COUNT(*) FROM purchase_orders purchase_order, tenant_scope scope
          WHERE purchase_order.tenant_id = scope.tenant_id AND purchase_order.status = 'closed_short') AS closed_short_orders,
        (SELECT COALESCE(SUM(order_line.ordered_quantity - order_line.received_quantity), 0)
          FROM purchase_order_lines order_line
          JOIN purchase_orders purchase_order
            ON purchase_order.id = order_line.purchase_order_id
            AND purchase_order.tenant_id = order_line.tenant_id,
          tenant_scope scope
          WHERE order_line.tenant_id = scope.tenant_id
            AND purchase_order.status IN ('issued', 'partially_received')) AS pending_receipt_quantity,
        (SELECT COUNT(*) FROM purchase_receipts receipt, tenant_scope scope
          WHERE receipt.tenant_id = scope.tenant_id) AS receipt_count,
        (SELECT COUNT(*) FROM purchase_receipt_corrections correction, tenant_scope scope
          WHERE correction.tenant_id = scope.tenant_id AND correction.status = 'posted') AS correction_count,
        (SELECT COALESCE(SUM(correction_line.quantity), 0)
          FROM purchase_receipt_correction_lines correction_line
          JOIN purchase_receipt_corrections correction
            ON correction.id = correction_line.correction_id
            AND correction.tenant_id = correction_line.tenant_id,
          tenant_scope scope
          WHERE correction_line.tenant_id = scope.tenant_id
            AND correction.status = 'posted') AS corrected_quantity,
        (SELECT COALESCE(SUM(order_line.received_quantity), 0)
          FROM purchase_order_lines order_line, tenant_scope scope
          WHERE order_line.tenant_id = scope.tenant_id) AS received_quantity
    `).bind(user.tenantId).first<ProcurementSummaryRow>(),
  ]);

  const linesByOrder = new Map<string, ReturnType<typeof mapPurchaseOrderLine>[]>();
  for (const row of orderLineRows.results) {
    const lines = linesByOrder.get(row.purchase_order_id) ?? [];
    lines.push(mapPurchaseOrderLine(row));
    linesByOrder.set(row.purchase_order_id, lines);
  }
  const linesByReceipt = new Map<string, ReturnType<typeof mapPurchaseReceiptLine>[]>();
  for (const row of receiptLineRows.results) {
    const lines = linesByReceipt.get(row.purchase_receipt_id) ?? [];
    lines.push(mapPurchaseReceiptLine(row));
    linesByReceipt.set(row.purchase_receipt_id, lines);
  }

  const purchaseOrders = orderRows.results.map((row) => mapPurchaseOrder(row, linesByOrder.get(row.id) ?? []));
  const purchaseReceipts = receiptRows.results.map((row) => mapPurchaseReceipt(row, linesByReceipt.get(row.id) ?? []));
  return {
    suppliers: supplierRows.results.map(mapSupplier),
    warehouses: warehouseRows.results.map((row) => ({ id: row.id, code: row.code, name: row.name })),
    purchaseOrders,
    purchaseReceipts,
    procurementSummary: {
      suppliers: Number(summaryRow?.suppliers ?? 0),
      draftOrders: Number(summaryRow?.draft_orders ?? 0),
      issuedOrders: Number(summaryRow?.issued_orders ?? 0),
      partiallyReceivedOrders: Number(summaryRow?.partially_received_orders ?? 0),
      receivedOrders: Number(summaryRow?.received_orders ?? 0),
      closedShortOrders: Number(summaryRow?.closed_short_orders ?? 0),
      pendingReceiptQuantity: Number(summaryRow?.pending_receipt_quantity ?? 0),
      receiptCount: Number(summaryRow?.receipt_count ?? 0),
      correctionCount: Number(summaryRow?.correction_count ?? 0),
      correctedQuantity: Number(summaryRow?.corrected_quantity ?? 0),
      receivedQuantity: Number(summaryRow?.received_quantity ?? 0),
    },
  };
}

export async function createWarehouse(
  db: D1Database,
  user: UserContext,
  input: CreateWarehouseInput,
  idempotencyKey: string,
) {
  requirePermission(user, 'warehouse:manage');
  validateIdempotencyKey(idempotencyKey);
  const normalized = {
    code: input.code.trim().toUpperCase(),
    name: input.name.trim(),
  };
  const requestHash = await hashPayload(normalized);
  const replay = await readWarehouseReplay(db, user.tenantId, requestHash, idempotencyKey);
  if (replay) {
    return { warehouse: await getWarehouse(db, user.tenantId, replay.warehouseId), replayed: true };
  }

  const warehouseId = crypto.randomUUID();
  const now = new Date().toISOString();
  try {
    await db.batch([
      db.prepare(`
        INSERT INTO warehouses (id, tenant_id, code, name, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).bind(warehouseId, user.tenantId, normalized.code, normalized.name, now),
      auditStatement(db, user, {
        action: 'CREATE_WAREHOUSE',
        entityType: 'warehouse',
        entityId: warehouseId,
        beforeJson: null,
        afterJson: stableJson({
          requestHash,
          warehouseId,
          code: normalized.code,
          name: normalized.name,
        }),
        idempotencyKey,
        now,
      }),
    ]);
  } catch (error) {
    const concurrent = await readWarehouseReplay(db, user.tenantId, requestHash, idempotencyKey);
    if (concurrent) {
      return { warehouse: await getWarehouse(db, user.tenantId, concurrent.warehouseId), replayed: true };
    }
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('uq_warehouses_tenant_code')
      || message.includes('warehouses.tenant_id, warehouses.code')) {
      throw new HttpError(409, '仓库编码已存在', 'WAREHOUSE_CODE_EXISTS');
    }
    throw error;
  }
  return { warehouse: await getWarehouse(db, user.tenantId, warehouseId), replayed: false };
}

export async function createSupplier(
  db: D1Database,
  user: UserContext,
  input: CreateSupplierInput,
  idempotencyKey: string,
) {
  requirePermission(user, 'purchase:supplier:create');
  validateIdempotencyKey(idempotencyKey);
  const normalized = {
    code: input.code.trim().toUpperCase(),
    name: input.name.trim(),
    note: input.note?.trim() || null,
  };
  const requestHash = await hashPayload(normalized);
  const replay = await db.prepare(`
    SELECT id, request_hash FROM suppliers
    WHERE tenant_id = ? AND idempotency_key = ?
    LIMIT 1
  `).bind(user.tenantId, idempotencyKey).first<{ id: string; request_hash: string }>();
  if (replay) {
    assertReplayHash(replay.request_hash, requestHash, '同一幂等键不能用于不同的供应商参数');
    return { supplier: await getSupplier(db, user.tenantId, replay.id), replayed: true };
  }

  const actorMemberId = await resolveActorMemberId(db, user);
  const now = new Date().toISOString();
  const supplierId = crypto.randomUUID();
  const afterJson = stableJson({ requestHash, code: normalized.code, name: normalized.name });
  try {
    await db.batch([
      db.prepare(`
        INSERT INTO suppliers (
          id, tenant_id, code, name, note, active, version, idempotency_key,
          request_hash, created_by_member_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?, ?)
      `).bind(
        supplierId,
        user.tenantId,
        normalized.code,
        normalized.name,
        normalized.note,
        idempotencyKey,
        requestHash,
        actorMemberId,
        now,
        now,
      ),
      auditStatement(db, user, {
        action: 'CREATE_SUPPLIER', entityType: 'supplier', entityId: supplierId,
        beforeJson: null, afterJson, idempotencyKey, now,
      }),
    ]);
  } catch (error) {
    const concurrent = await db.prepare(`
      SELECT id, request_hash FROM suppliers
      WHERE tenant_id = ? AND idempotency_key = ?
      LIMIT 1
    `).bind(user.tenantId, idempotencyKey).first<{ id: string; request_hash: string }>();
    if (concurrent) {
      assertReplayHash(concurrent.request_hash, requestHash, '同一幂等键不能用于不同的供应商参数');
      return { supplier: await getSupplier(db, user.tenantId, concurrent.id), replayed: true };
    }
    throw translateProcurementError(error);
  }
  return { supplier: await getSupplier(db, user.tenantId, supplierId), replayed: false };
}

export async function createPurchaseOrder(
  db: D1Database,
  user: UserContext,
  input: CreatePurchaseOrderInput,
  idempotencyKey: string,
) {
  requirePermission(user, 'purchase:order:create');
  validateIdempotencyKey(idempotencyKey);
  const normalized = {
    purchaseRequestId: input.purchaseRequestId.trim(),
    supplierId: input.supplierId.trim(),
    currency: input.currency?.trim().toUpperCase() || null,
    note: input.note?.trim() || null,
    lineCosts: [...(input.lineCosts ?? [])]
      .map((line) => ({ purchaseRequestLineId: line.purchaseRequestLineId.trim(), unitCostMinor: line.unitCostMinor }))
      .sort((left, right) => left.purchaseRequestLineId.localeCompare(right.purchaseRequestLineId)),
  };
  const requestHash = await hashPayload(normalized);
  const actorMemberId = await assertPurchaseRequestPurchaser(db, user, normalized.purchaseRequestId);
  const replay = await db.prepare(`
    SELECT id, request_hash FROM purchase_orders
    WHERE tenant_id = ? AND idempotency_key = ?
    LIMIT 1
  `).bind(user.tenantId, idempotencyKey).first<{ id: string; request_hash: string }>();
  if (replay) {
    assertReplayHash(replay.request_hash, requestHash, '同一幂等键不能用于不同的采购单参数');
    return { purchaseOrder: await getPurchaseOrder(db, user.tenantId, replay.id), replayed: true };
  }

  const [supplier, request, requestLines] = await Promise.all([
    db.prepare(`
      SELECT id FROM suppliers
      WHERE tenant_id = ? AND id = ? AND active = 1
      LIMIT 1
    `).bind(user.tenantId, normalized.supplierId).first<{ id: string }>(),
    db.prepare(`
      SELECT id, request_no, status FROM purchase_requests
      WHERE tenant_id = ? AND id = ?
      LIMIT 1
    `).bind(user.tenantId, normalized.purchaseRequestId).first<{
      id: string; request_no: string; status: string;
    }>(),
    loadRequestLines(db, user.tenantId, normalized.purchaseRequestId),
  ]);
  if (!supplier) throw new HttpError(404, '供应商不存在或已停用', 'PURCHASE_SUPPLIER_NOT_FOUND');
  if (!request) throw new HttpError(404, '采购申请不存在或不在当前数据范围内', 'PURCHASE_REQUEST_NOT_FOUND');
  if (request.status !== 'approved') {
    throw new HttpError(409, '只有已批准的采购申请才能生成正式采购单', 'PURCHASE_REQUEST_NOT_APPROVED');
  }
  if (requestLines.length === 0) {
    throw new HttpError(409, '采购申请没有可下单明细', 'PURCHASE_REQUEST_EMPTY');
  }
  assertRequestLinesCurrent(requestLines);

  const lineCostMap = new Map(normalized.lineCosts.map((line) => [line.purchaseRequestLineId, line.unitCostMinor]));
  const requestLineIds = new Set(requestLines.map((line) => line.id));
  if (normalized.lineCosts.some((line) => !requestLineIds.has(line.purchaseRequestLineId))) {
    throw new HttpError(400, '采购单价格包含不属于该申请的明细', 'PURCHASE_ORDER_LINE_INVALID');
  }

  const now = new Date().toISOString();
  const purchaseOrderId = crypto.randomUUID();
  const orderNo = createDocumentNumber('CGD');
  const statements: D1PreparedStatement[] = [
    db.prepare(`
      INSERT INTO purchase_orders (
        id, tenant_id, order_no, purchase_request_id, supplier_id, status,
        currency, note, action_note, version, idempotency_key, request_hash,
        last_action_key, created_by_member_id, issued_at, cancelled_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, NULL, 1, ?, ?, ?, ?, NULL, NULL, ?, ?)
    `).bind(
      purchaseOrderId,
      user.tenantId,
      orderNo,
      normalized.purchaseRequestId,
      normalized.supplierId,
      normalized.currency,
      normalized.note,
      idempotencyKey,
      requestHash,
      idempotencyKey,
      actorMemberId,
      now,
      now,
    ),
  ];
  for (const line of requestLines) {
    const unitCostMinor = lineCostMap.get(line.id) ?? null;
    statements.push(db.prepare(`
      INSERT INTO purchase_order_lines (
        id, tenant_id, purchase_order_id, purchase_request_line_id, sku_id,
        sku_code_snapshot, sku_name_snapshot, ordered_quantity, received_quantity,
        unit_cost_minor, currency, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
    `).bind(
      crypto.randomUUID(),
      user.tenantId,
      purchaseOrderId,
      line.id,
      line.sku_id,
      line.sku_code,
      line.sku_name,
      line.requested_quantity,
      unitCostMinor,
      normalized.currency,
      now,
      now,
    ));
  }
  statements.push(auditStatement(db, user, {
    action: 'CREATE_PURCHASE_ORDER',
    entityType: 'purchase_order',
    entityId: purchaseOrderId,
    beforeJson: null,
    afterJson: stableJson({
      requestHash,
      orderNo,
      purchaseRequestId: normalized.purchaseRequestId,
      supplierId: normalized.supplierId,
      lineCount: requestLines.length,
    }),
    idempotencyKey,
    now,
  }));

  try {
    await db.batch(statements);
  } catch (error) {
    const concurrent = await db.prepare(`
      SELECT id, request_hash FROM purchase_orders
      WHERE tenant_id = ? AND idempotency_key = ?
      LIMIT 1
    `).bind(user.tenantId, idempotencyKey).first<{ id: string; request_hash: string }>();
    if (concurrent) {
      assertReplayHash(concurrent.request_hash, requestHash, '同一幂等键不能用于不同的采购单参数');
      return { purchaseOrder: await getPurchaseOrder(db, user.tenantId, concurrent.id), replayed: true };
    }
    throw translateProcurementError(error);
  }
  return { purchaseOrder: await getPurchaseOrder(db, user.tenantId, purchaseOrderId), replayed: false };
}

export async function executePurchaseOrderAction(
  db: D1Database,
  user: UserContext,
  purchaseOrderId: string,
  input: PurchaseOrderActionInput,
  idempotencyKey: string,
) {
  requirePermission(user, 'purchase:order:issue');
  validateIdempotencyKey(idempotencyKey);
  const normalized = { action: input.action, note: input.note?.trim() || null };
  if (normalized.action === 'close' && !normalized.note) {
    throw new HttpError(400, '关闭采购单剩余量时必须填写原因', 'PURCHASE_ORDER_CLOSE_REASON_REQUIRED');
  }
  const requestHash = await hashPayload(normalized);
  const auditAction = input.action === 'issue'
    ? 'ISSUE_PURCHASE_ORDER'
    : input.action === 'close'
      ? 'CLOSE_PURCHASE_ORDER_REMAINDER'
      : 'CANCEL_PURCHASE_ORDER';
  await assertPurchaseOrderPurchaser(db, user, purchaseOrderId);
  const replay = await readActionReplay(db, user.tenantId, purchaseOrderId, auditAction, requestHash, idempotencyKey);
  if (replay) return { purchaseOrder: await getPurchaseOrder(db, user.tenantId, purchaseOrderId), replayed: true };

  const current = await db.prepare(`
    SELECT po.id, po.status, po.version, po.purchase_request_id, s.active AS supplier_active
    FROM purchase_orders po
    JOIN suppliers s ON s.id = po.supplier_id AND s.tenant_id = po.tenant_id
    WHERE po.tenant_id = ? AND po.id = ?
    LIMIT 1
  `).bind(user.tenantId, purchaseOrderId).first<{
    id: string;
    status: PurchaseOrderStatus;
    version: number;
    purchase_request_id: string;
    supplier_active: number;
  }>();
  if (!current) throw new HttpError(404, '采购单不存在或不在当前数据范围内', 'PURCHASE_ORDER_NOT_FOUND');
  const validCurrentStatus = input.action === 'close'
    ? current.status === 'issued' || current.status === 'partially_received'
    : current.status === 'draft';
  if (!validCurrentStatus) {
    throw new HttpError(409, '当前采购单状态不允许执行该操作', 'INVALID_PURCHASE_ORDER_TRANSITION');
  }
  if (input.action === 'issue') {
    if (current.supplier_active !== 1) {
      throw new HttpError(409, '供应商已停用，不能确认下单', 'PURCHASE_SUPPLIER_INACTIVE');
    }
    const request = await db.prepare(`
      SELECT status FROM purchase_requests WHERE tenant_id = ? AND id = ? LIMIT 1
    `).bind(user.tenantId, current.purchase_request_id).first<{ status: string }>();
    const lines = await loadRequestLines(db, user.tenantId, current.purchase_request_id);
    if (request?.status !== 'approved' || lines.length === 0) {
      throw new HttpError(409, '来源采购申请已变化，不能确认下单', 'PURCHASE_REQUEST_CHANGED');
    }
    assertRequestLinesCurrent(lines);
  }

  const nextStatus: PurchaseOrderStatus = input.action === 'issue'
    ? 'issued'
    : input.action === 'close'
      ? 'closed_short'
      : 'cancelled';
  const now = new Date().toISOString();
  const beforeJson = stableJson({ status: current.status, version: current.version });
  const afterJson = stableJson({
    requestHash,
    status: nextStatus,
    version: current.version + 1,
    note: normalized.note,
  });
  try {
    await db.batch([
      db.prepare(`
        UPDATE purchase_orders
        SET status = ?, action_note = ?, version = version + 1,
            last_action_key = ?,
            issued_at = CASE WHEN ? = 'issued' THEN ? ELSE issued_at END,
            closed_at = CASE WHEN ? = 'closed_short' THEN ? ELSE closed_at END,
            cancelled_at = CASE WHEN ? = 'cancelled' THEN ? ELSE cancelled_at END,
            updated_at = ?
        WHERE id = ? AND tenant_id = ? AND version = ?
          AND (
            (? = 'close' AND status IN ('issued', 'partially_received'))
            OR (? <> 'close' AND status = 'draft')
          )
      `).bind(
        nextStatus,
        normalized.note,
        idempotencyKey,
        nextStatus,
        now,
        nextStatus,
        now,
        nextStatus,
        now,
        now,
        purchaseOrderId,
        user.tenantId,
        current.version,
        input.action,
        input.action,
      ),
      auditStatement(db, user, {
        action: auditAction,
        entityType: 'purchase_order',
        entityId: purchaseOrderId,
        beforeJson,
        afterJson,
        idempotencyKey,
        now,
        onlyWhenSql: `EXISTS (
          SELECT 1 FROM purchase_orders
          WHERE id = ? AND tenant_id = ? AND last_action_key = ? AND status = ?
        )`,
        onlyWhenBindings: [purchaseOrderId, user.tenantId, idempotencyKey, nextStatus],
      }),
    ]);
  } catch (error) {
    const concurrentReplay = await readActionReplay(
      db, user.tenantId, purchaseOrderId, auditAction, requestHash, idempotencyKey,
    );
    if (concurrentReplay) {
      return { purchaseOrder: await getPurchaseOrder(db, user.tenantId, purchaseOrderId), replayed: true };
    }
    throw translateProcurementError(error);
  }
  const applied = await readActionReplay(
    db,
    user.tenantId,
    purchaseOrderId,
    auditAction,
    requestHash,
    idempotencyKey,
  );
  if (!applied) {
    throw new HttpError(409, '采购单已被其他操作更新，请刷新后重试', 'CONCURRENT_UPDATE');
  }
  return { purchaseOrder: await getPurchaseOrder(db, user.tenantId, purchaseOrderId), replayed: false };
}

export async function createPurchaseReceipt(
  db: D1Database,
  user: UserContext,
  purchaseOrderId: string,
  input: CreatePurchaseReceiptInput,
  idempotencyKey: string,
) {
  requirePermission(user, 'inventory:receive');
  validateIdempotencyKey(idempotencyKey);
  const normalized = {
    purchaseOrderId,
    warehouseId: input.warehouseId.trim(),
    receivedAt: input.receivedAt ? new Date(input.receivedAt).toISOString() : null,
    note: input.note?.trim() || null,
    lines: [...input.lines]
      .map((line) => ({ purchaseOrderLineId: line.purchaseOrderLineId.trim(), quantity: line.quantity }))
      .sort((left, right) => left.purchaseOrderLineId.localeCompare(right.purchaseOrderLineId)),
  };
  const requestHash = await hashPayload(normalized);
  const replay = await db.prepare(`
    SELECT id, purchase_order_id, request_hash
    FROM purchase_receipts
    WHERE tenant_id = ? AND idempotency_key = ?
    LIMIT 1
  `).bind(user.tenantId, idempotencyKey).first<{
    id: string; purchase_order_id: string; request_hash: string;
  }>();
  if (replay) {
    if (replay.purchase_order_id !== purchaseOrderId) {
      throw new HttpError(409, '该幂等键已用于另一张采购单', 'IDEMPOTENCY_CONFLICT');
    }
    assertReplayHash(replay.request_hash, requestHash, '同一幂等键不能用于不同的收货参数');
    return {
      receipt: await getPurchaseReceipt(db, user.tenantId, replay.id),
      purchaseOrder: await getPurchaseOrder(db, user.tenantId, purchaseOrderId),
      replayed: true,
    };
  }

  const [purchaseOrder, warehouse, targetLines, actorMemberId] = await Promise.all([
    db.prepare(`
      SELECT id, status, version FROM purchase_orders
      WHERE tenant_id = ? AND id = ?
      LIMIT 1
    `).bind(user.tenantId, purchaseOrderId).first<{
      id: string; status: PurchaseOrderStatus; version: number;
    }>(),
    db.prepare(`
      SELECT id FROM warehouses WHERE tenant_id = ? AND id = ? LIMIT 1
    `).bind(user.tenantId, normalized.warehouseId).first<{ id: string }>(),
    loadReceiptTargetLines(db, user.tenantId, purchaseOrderId, normalized.lines.map((line) => line.purchaseOrderLineId)),
    resolveActorMemberId(db, user),
  ]);
  if (!purchaseOrder) throw new HttpError(404, '采购单不存在或不在当前数据范围内', 'PURCHASE_ORDER_NOT_FOUND');
  if (purchaseOrder.status !== 'issued' && purchaseOrder.status !== 'partially_received') {
    throw new HttpError(409, '采购单尚未下单或已经收货完成', 'PURCHASE_ORDER_NOT_RECEIVABLE');
  }
  if (!warehouse) throw new HttpError(404, '入库仓库不存在或不在当前数据范围内', 'RECEIPT_WAREHOUSE_NOT_FOUND');
  if (targetLines.length !== normalized.lines.length) {
    throw new HttpError(400, '收货明细包含不属于该采购单的行', 'PURCHASE_RECEIPT_LINE_INVALID');
  }
  const targetById = new Map(targetLines.map((line) => [line.id, line]));
  for (const line of normalized.lines) {
    const target = targetById.get(line.purchaseOrderLineId)!;
    if (line.quantity > target.ordered_quantity - target.received_quantity) {
      throw new HttpError(409, '本次收货数量超过采购单未到货数量', 'PURCHASE_RECEIPT_EXCEEDS_REMAINING');
    }
  }

  const now = new Date().toISOString();
  const receivedAt = normalized.receivedAt ?? now;
  const receiptId = crypto.randomUUID();
  const receiptNo = createDocumentNumber('SH');
  const statements: D1PreparedStatement[] = [
    db.prepare(`
      INSERT INTO purchase_receipts (
        id, tenant_id, receipt_no, purchase_order_id, warehouse_id, status,
        note, idempotency_key, request_hash, created_by_member_id, received_at, created_at
      ) VALUES (?, ?, ?, ?, ?, 'posted', ?, ?, ?, ?, ?, ?)
    `).bind(
      receiptId,
      user.tenantId,
      receiptNo,
      purchaseOrderId,
      normalized.warehouseId,
      normalized.note,
      idempotencyKey,
      requestHash,
      actorMemberId,
      receivedAt,
      now,
    ),
  ];
  for (const line of normalized.lines) {
    const target = targetById.get(line.purchaseOrderLineId)!;
    statements.push(db.prepare(`
      INSERT INTO purchase_receipt_lines (
        id, tenant_id, purchase_receipt_id, purchase_order_line_id,
        sku_id, warehouse_id, quantity, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      crypto.randomUUID(),
      user.tenantId,
      receiptId,
      line.purchaseOrderLineId,
      target.sku_id,
      normalized.warehouseId,
      line.quantity,
      now,
    ));
  }
  statements.push(auditStatement(db, user, {
    action: 'POST_PURCHASE_RECEIPT',
    entityType: 'purchase_receipt',
    entityId: receiptId,
    beforeJson: null,
    afterJson: stableJson({
      requestHash,
      receiptNo,
      purchaseOrderId,
      warehouseId: normalized.warehouseId,
      totalQuantity: normalized.lines.reduce((sum, line) => sum + line.quantity, 0),
    }),
    idempotencyKey,
    now,
  }));

  try {
    await db.batch(statements);
  } catch (error) {
    const concurrent = await db.prepare(`
      SELECT id, purchase_order_id, request_hash
      FROM purchase_receipts
      WHERE tenant_id = ? AND idempotency_key = ?
      LIMIT 1
    `).bind(user.tenantId, idempotencyKey).first<{
      id: string; purchase_order_id: string; request_hash: string;
    }>();
    if (concurrent) {
      if (concurrent.purchase_order_id !== purchaseOrderId) {
        throw new HttpError(409, '该幂等键已用于另一张采购单', 'IDEMPOTENCY_CONFLICT');
      }
      assertReplayHash(concurrent.request_hash, requestHash, '同一幂等键不能用于不同的收货参数');
      return {
        receipt: await getPurchaseReceipt(db, user.tenantId, concurrent.id),
        purchaseOrder: await getPurchaseOrder(db, user.tenantId, purchaseOrderId),
        replayed: true,
      };
    }
    throw translateProcurementError(error);
  }
  return {
    receipt: await getPurchaseReceipt(db, user.tenantId, receiptId),
    purchaseOrder: await getPurchaseOrder(db, user.tenantId, purchaseOrderId),
    replayed: false,
  };
}

export async function getSupplier(db: D1Database, tenantId: string, supplierId: string) {
  const row = await db.prepare(`
    SELECT id, code, name, note, active, version, created_at, updated_at
    FROM suppliers
    WHERE tenant_id = ? AND id = ?
    LIMIT 1
  `).bind(tenantId, supplierId).first<SupplierRow>();
  if (!row) throw new HttpError(404, '供应商不存在或不在当前数据范围内', 'PURCHASE_SUPPLIER_NOT_FOUND');
  return mapSupplier(row);
}

export async function getWarehouse(db: D1Database, tenantId: string, warehouseId: string) {
  const row = await db.prepare(`
    SELECT id, code, name, created_at
    FROM warehouses
    WHERE tenant_id = ? AND id = ?
    LIMIT 1
  `).bind(tenantId, warehouseId).first<WarehouseRow>();
  if (!row) throw new HttpError(404, '仓库不存在或不在当前数据范围内', 'WAREHOUSE_NOT_FOUND');
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    createdAt: row.created_at,
  };
}

export async function getPurchaseOrder(db: D1Database, tenantId: string, purchaseOrderId: string) {
  const row = await db.prepare(`${PURCHASE_ORDER_SELECT}
    WHERE po.tenant_id = ? AND po.id = ?
    GROUP BY po.id
    LIMIT 1
  `).bind(tenantId, purchaseOrderId).first<PurchaseOrderRow>();
  if (!row) throw new HttpError(404, '采购单不存在或不在当前数据范围内', 'PURCHASE_ORDER_NOT_FOUND');
  const lines = await db.prepare(`${PURCHASE_ORDER_LINE_SELECT}
    WHERE po.tenant_id = ? AND po.id = ?
    ORDER BY line.created_at ASC
  `).bind(tenantId, purchaseOrderId).all<PurchaseOrderLineRow>();
  return mapPurchaseOrder(row, lines.results.map(mapPurchaseOrderLine));
}

export async function getPurchaseReceipt(db: D1Database, tenantId: string, purchaseReceiptId: string) {
  const row = await db.prepare(`${PURCHASE_RECEIPT_SELECT}
    WHERE receipt.tenant_id = ? AND receipt.id = ?
    GROUP BY receipt.id
    LIMIT 1
  `).bind(tenantId, purchaseReceiptId).first<PurchaseReceiptRow>();
  if (!row) throw new HttpError(404, '收货单不存在或不在当前数据范围内', 'PURCHASE_RECEIPT_NOT_FOUND');
  const lines = await db.prepare(`${PURCHASE_RECEIPT_LINE_SELECT}
    WHERE receipt.tenant_id = ? AND receipt.id = ?
    ORDER BY line.created_at ASC
  `).bind(tenantId, purchaseReceiptId).all<PurchaseReceiptLineRow>();
  return mapPurchaseReceipt(row, lines.results.map(mapPurchaseReceiptLine));
}

const PURCHASE_ORDER_SELECT = `
  SELECT
    po.id,
    po.order_no,
    po.purchase_request_id,
    pr.request_no AS purchase_request_no,
    pr.purchaser_member_id,
    po.supplier_id,
    supplier.code AS supplier_code,
    supplier.name AS supplier_name,
    po.status,
    po.currency,
    po.note,
    po.action_note,
    po.version,
    po.issued_at,
    po.closed_at,
    po.cancelled_at,
    po.created_at,
    po.updated_at,
    COUNT(line.id) AS line_count,
    COALESCE(SUM(line.ordered_quantity), 0) AS ordered_quantity,
    COALESCE(SUM(line.received_quantity), 0) AS received_quantity
  FROM purchase_orders po
  JOIN purchase_requests pr ON pr.id = po.purchase_request_id AND pr.tenant_id = po.tenant_id
  JOIN suppliers supplier ON supplier.id = po.supplier_id AND supplier.tenant_id = po.tenant_id
  LEFT JOIN purchase_order_lines line ON line.purchase_order_id = po.id AND line.tenant_id = po.tenant_id
`;

const PURCHASE_ORDER_LINE_SELECT = `
  SELECT
    line.id,
    line.purchase_order_id,
    line.purchase_request_line_id,
    line.sku_id,
    line.sku_code_snapshot AS sku_code,
    line.sku_name_snapshot AS sku_name,
    line.ordered_quantity,
    line.received_quantity,
    line.unit_cost_minor,
    line.currency
  FROM purchase_order_lines line
  JOIN purchase_orders po ON po.id = line.purchase_order_id AND po.tenant_id = line.tenant_id
`;

const PURCHASE_RECEIPT_SELECT = `
  SELECT
    receipt.id,
    receipt.receipt_no,
    receipt.purchase_order_id,
    po.order_no AS purchase_order_no,
    receipt.warehouse_id,
    warehouse.code AS warehouse_code,
    warehouse.name AS warehouse_name,
    receipt.status,
    receipt.note,
    receipt.received_at,
    receipt.created_at,
    COUNT(line.id) AS line_count,
    COALESCE(SUM(line.quantity), 0) AS total_quantity,
    COALESCE((
      SELECT SUM(correction_line.quantity)
      FROM purchase_receipt_correction_lines correction_line
      JOIN purchase_receipt_corrections correction
        ON correction.id = correction_line.correction_id
        AND correction.tenant_id = correction_line.tenant_id
      WHERE correction.tenant_id = receipt.tenant_id
        AND correction.purchase_receipt_id = receipt.id
        AND correction.status = 'posted'
    ), 0) AS corrected_quantity,
    COALESCE((
      SELECT COUNT(*)
      FROM purchase_receipt_corrections correction
      WHERE correction.tenant_id = receipt.tenant_id
        AND correction.purchase_receipt_id = receipt.id
        AND correction.status = 'posted'
    ), 0) AS correction_count
  FROM purchase_receipts receipt
  JOIN purchase_orders po ON po.id = receipt.purchase_order_id AND po.tenant_id = receipt.tenant_id
  JOIN warehouses warehouse ON warehouse.id = receipt.warehouse_id AND warehouse.tenant_id = receipt.tenant_id
  LEFT JOIN purchase_receipt_lines line ON line.purchase_receipt_id = receipt.id AND line.tenant_id = receipt.tenant_id
`;

const PURCHASE_RECEIPT_LINE_SELECT = `
  SELECT
    line.id,
    line.purchase_receipt_id,
    line.purchase_order_line_id,
    line.sku_id,
    sku.code AS sku_code,
    sku.name AS sku_name,
    line.warehouse_id,
    line.quantity
  FROM purchase_receipt_lines line
  JOIN purchase_receipts receipt ON receipt.id = line.purchase_receipt_id AND receipt.tenant_id = line.tenant_id
  JOIN skus sku ON sku.id = line.sku_id AND sku.tenant_id = line.tenant_id
`;

function mapSupplier(row: SupplierRow) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    note: row.note,
    active: row.active === 1,
    version: Number(row.version),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapPurchaseOrder(row: PurchaseOrderRow, lines: ReturnType<typeof mapPurchaseOrderLine>[]) {
  return {
    id: row.id,
    orderNo: row.order_no,
    purchaseRequestId: row.purchase_request_id,
    purchaseRequestNo: row.purchase_request_no,
    purchaserMemberId: row.purchaser_member_id,
    supplier: { id: row.supplier_id, code: row.supplier_code, name: row.supplier_name },
    status: row.status,
    currency: row.currency,
    note: row.note,
    actionNote: row.action_note,
    version: Number(row.version),
    lineCount: Number(row.line_count),
    orderedQuantity: Number(row.ordered_quantity),
    receivedQuantity: Number(row.received_quantity),
    issuedAt: row.issued_at,
    closedAt: row.closed_at,
    cancelledAt: row.cancelled_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lines,
  };
}

function mapPurchaseOrderLine(row: PurchaseOrderLineRow) {
  return {
    id: row.id,
    purchaseRequestLineId: row.purchase_request_line_id,
    skuId: row.sku_id,
    skuCode: row.sku_code,
    skuName: row.sku_name,
    orderedQuantity: Number(row.ordered_quantity),
    receivedQuantity: Number(row.received_quantity),
    remainingQuantity: Math.max(0, Number(row.ordered_quantity) - Number(row.received_quantity)),
    unitCostMinor: row.unit_cost_minor === null ? null : Number(row.unit_cost_minor),
    currency: row.currency,
  };
}

function mapPurchaseReceipt(row: PurchaseReceiptRow, lines: ReturnType<typeof mapPurchaseReceiptLine>[]) {
  const originalQuantity = Number(row.total_quantity);
  const correctedQuantity = Number(row.corrected_quantity);
  return {
    id: row.id,
    receiptNo: row.receipt_no,
    purchaseOrderId: row.purchase_order_id,
    purchaseOrderNo: row.purchase_order_no,
    warehouse: { id: row.warehouse_id, code: row.warehouse_code, name: row.warehouse_name },
    status: row.status,
    note: row.note,
    receivedAt: row.received_at,
    createdAt: row.created_at,
    lineCount: Number(row.line_count),
    // totalQuantity stays as the immutable posted receipt quantity for compatibility.
    totalQuantity: originalQuantity,
    originalQuantity,
    correctedQuantity,
    netQuantity: Math.max(0, originalQuantity - correctedQuantity),
    correctionCount: Number(row.correction_count),
    lines,
  };
}

function mapPurchaseReceiptLine(row: PurchaseReceiptLineRow) {
  return {
    id: row.id,
    purchaseOrderLineId: row.purchase_order_line_id,
    skuId: row.sku_id,
    skuCode: row.sku_code,
    skuName: row.sku_name,
    warehouseId: row.warehouse_id,
    quantity: Number(row.quantity),
  };
}

async function loadRequestLines(db: D1Database, tenantId: string, purchaseRequestId: string) {
  const rows = await db.prepare(`
    SELECT
      line.id,
      line.sku_id,
      sku.code AS sku_code,
      sku.name AS sku_name,
      line.requested_quantity,
      line.active,
      pd.status AS demand_status,
      pd.mapped_sku_id AS demand_mapped_sku_id,
      pd.required_quantity AS demand_required_quantity,
      pd.source_updated_at AS demand_source_updated_at,
      line.source_updated_at
    FROM purchase_request_lines line
    JOIN purchase_requests pr ON pr.id = line.request_id AND pr.tenant_id = line.tenant_id
    JOIN skus sku ON sku.id = line.sku_id AND sku.tenant_id = line.tenant_id
    LEFT JOIN purchase_demands pd ON pd.id = line.purchase_demand_id AND pd.tenant_id = line.tenant_id
    WHERE line.tenant_id = ? AND line.request_id = ? AND line.active = 1
    ORDER BY line.created_at ASC
  `).bind(tenantId, purchaseRequestId).all<RequestLineRow>();
  return rows.results;
}

function assertRequestLinesCurrent(lines: RequestLineRow[]) {
  if (lines.some((line) => (
    line.active !== 1
    || line.demand_status !== 'open'
    || line.demand_mapped_sku_id !== line.sku_id
    || Number(line.demand_required_quantity ?? -1) < Number(line.requested_quantity)
    || line.demand_source_updated_at !== line.source_updated_at
  ))) {
    throw new HttpError(409, '来源订单需求已经变化，请重新复核后再下单', 'PURCHASE_REQUEST_NEEDS_ATTENTION');
  }
}

async function loadReceiptTargetLines(
  db: D1Database,
  tenantId: string,
  purchaseOrderId: string,
  lineIds: string[],
) {
  if (lineIds.length === 0) return [];
  const placeholders = lineIds.map(() => '?').join(', ');
  const rows = await db.prepare(`
    SELECT id, sku_id, ordered_quantity, received_quantity
    FROM purchase_order_lines
    WHERE tenant_id = ? AND purchase_order_id = ? AND id IN (${placeholders})
  `).bind(tenantId, purchaseOrderId, ...lineIds).all<ReceiptTargetLineRow>();
  return rows.results;
}

async function assertPurchaseRequestPurchaser(
  db: D1Database,
  user: UserContext,
  purchaseRequestId: string,
) {
  const request = await db.prepare(`
    SELECT purchaser_member_id
    FROM purchase_requests
    WHERE tenant_id = ? AND id = ?
    LIMIT 1
  `).bind(user.tenantId, purchaseRequestId).first<{ purchaser_member_id: string }>();
  if (!request) {
    throw new HttpError(404, '采购申请不存在或不在当前数据范围内', 'PURCHASE_REQUEST_NOT_FOUND');
  }
  const actorMemberId = await resolveActorMemberId(db, user);
  if (request.purchaser_member_id !== actorMemberId) {
    throw new HttpError(
      403,
      '只有该申请指定的采购负责人可以生成正式采购单',
      'PURCHASE_ORDER_PURCHASER_REQUIRED',
    );
  }
  return actorMemberId;
}

async function assertPurchaseOrderPurchaser(
  db: D1Database,
  user: UserContext,
  purchaseOrderId: string,
) {
  const order = await db.prepare(`
    SELECT request.purchaser_member_id
    FROM purchase_orders purchase_order
    JOIN purchase_requests request
      ON request.id = purchase_order.purchase_request_id
      AND request.tenant_id = purchase_order.tenant_id
    WHERE purchase_order.tenant_id = ? AND purchase_order.id = ?
    LIMIT 1
  `).bind(user.tenantId, purchaseOrderId).first<{ purchaser_member_id: string }>();
  if (!order) {
    throw new HttpError(404, '采购单不存在或不在当前数据范围内', 'PURCHASE_ORDER_NOT_FOUND');
  }
  const actorMemberId = await resolveActorMemberId(db, user);
  if (order.purchaser_member_id !== actorMemberId) {
    throw new HttpError(
      403,
      '只有来源申请指定的采购负责人可以确认、取消或关闭采购单剩余量',
      'PURCHASE_ORDER_PURCHASER_REQUIRED',
    );
  }
}

async function resolveActorMemberId(db: D1Database, user: UserContext) {
  const member = await db.prepare(`
    SELECT id FROM members WHERE tenant_id = ? AND auth_user_id = ? LIMIT 1
  `).bind(user.tenantId, user.id).first<{ id: string }>();
  if (!member) throw new HttpError(409, '当前操作人尚未加入采购工作区', 'PURCHASE_MEMBER_NOT_FOUND');
  return member.id;
}

async function readActionReplay(
  db: D1Database,
  tenantId: string,
  entityId: string,
  action: string,
  requestHash: string,
  idempotencyKey: string,
) {
  const row = await db.prepare(`
    SELECT action, entity_id, after_json
    FROM audit_logs
    WHERE tenant_id = ? AND idempotency_key = ?
    LIMIT 1
  `).bind(tenantId, idempotencyKey).first<{
    action: string; entity_id: string; after_json: string | null;
  }>();
  if (!row) return false;
  if (row.action !== action || row.entity_id !== entityId) {
    throw new HttpError(409, '该幂等键已用于另一项业务操作', 'IDEMPOTENCY_CONFLICT');
  }
  const parsed = parseJson(row.after_json);
  if (parsed.requestHash !== requestHash) {
    throw new HttpError(409, '同一幂等键不能用于不同的采购单操作', 'IDEMPOTENCY_CONFLICT');
  }
  return true;
}

async function readWarehouseReplay(
  db: D1Database,
  tenantId: string,
  requestHash: string,
  idempotencyKey: string,
) {
  const row = await db.prepare(`
    SELECT action, entity_type, entity_id, after_json
    FROM audit_logs
    WHERE tenant_id = ? AND idempotency_key = ?
    LIMIT 1
  `).bind(tenantId, idempotencyKey).first<{
    action: string;
    entity_type: string;
    entity_id: string;
    after_json: string | null;
  }>();
  if (!row) return null;
  if (row.action !== 'CREATE_WAREHOUSE' || row.entity_type !== 'warehouse') {
    throw new HttpError(409, '该幂等键已用于另一项业务操作', 'IDEMPOTENCY_CONFLICT');
  }
  const payload = parseJson(row.after_json);
  if (payload.requestHash !== requestHash || payload.warehouseId !== row.entity_id) {
    throw new HttpError(409, '同一幂等键不能用于不同的仓库参数', 'IDEMPOTENCY_CONFLICT');
  }
  return { warehouseId: row.entity_id };
}

function auditStatement(
  db: D1Database,
  user: UserContext,
  input: {
    action: string;
    entityType: string;
    entityId: string;
    beforeJson: string | null;
    afterJson: string | null;
    idempotencyKey: string;
    now: string;
    onlyWhenSql?: string;
    onlyWhenBindings?: unknown[];
  },
) {
  const condition = input.onlyWhenSql ? `WHERE ${input.onlyWhenSql}` : '';
  return db.prepare(`
    INSERT INTO audit_logs (
      id, tenant_id, actor_id, actor_email, action, entity_type, entity_id,
      before_json, after_json, request_id, idempotency_key, source, created_at
    )
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'human', ?
    ${condition}
  `).bind(
    crypto.randomUUID(),
    user.tenantId,
    user.id,
    user.email,
    input.action,
    input.entityType,
    input.entityId,
    input.beforeJson,
    input.afterJson,
    crypto.randomUUID(),
    input.idempotencyKey,
    input.now,
    ...(input.onlyWhenBindings ?? []),
  );
}

function validateIdempotencyKey(key: string) {
  if (!key || key.length < 8 || key.length > 128) {
    throw new HttpError(400, '缺少有效的 Idempotency-Key', 'INVALID_IDEMPOTENCY_KEY');
  }
}

async function hashPayload(input: unknown) {
  return sha256Hex(stableJson(input));
}

function assertReplayHash(stored: string, expected: string, message: string) {
  if (stored !== expected) throw new HttpError(409, message, 'IDEMPOTENCY_CONFLICT');
}

function createDocumentNumber(prefix: string) {
  const date = new Date().toISOString().slice(2, 10).replaceAll('-', '');
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 6).toUpperCase();
  return `${prefix}${date}-${suffix}`;
}

function parseJson(value: string | null) {
  if (!value) return {} as Record<string, unknown>;
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return {} as Record<string, unknown>;
  }
}

function translateProcurementError(error: unknown): unknown {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('INVALID_PURCHASE_SUPPLIER')) {
    return new HttpError(409, '供应商不存在或已停用', 'PURCHASE_SUPPLIER_NOT_FOUND');
  }
  if (message.includes('PURCHASE_REQUEST_NOT_APPROVED')) {
    return new HttpError(409, '只有已批准的采购申请才能生成正式采购单', 'PURCHASE_REQUEST_NOT_APPROVED');
  }
  if (message.includes('PURCHASE_REQUEST_NEEDS_ATTENTION') || message.includes('INVALID_PURCHASE_ORDER_LINE')) {
    return new HttpError(409, '来源订单需求已经变化，请重新复核后再下单', 'PURCHASE_REQUEST_NEEDS_ATTENTION');
  }
  if (message.includes('uq_purchase_orders_active_request')
    || message.includes('purchase_orders.tenant_id, purchase_orders.purchase_request_id')) {
    return new HttpError(409, '该采购申请已经生成有效采购单，不能重复下单', 'PURCHASE_ORDER_ALREADY_EXISTS');
  }
  if (message.includes('uq_suppliers_tenant_code')
    || message.includes('suppliers.tenant_id, suppliers.code')) {
    return new HttpError(409, '供应商编码已存在', 'PURCHASE_SUPPLIER_CODE_EXISTS');
  }
  if (message.includes('INVALID_PURCHASE_ORDER_TRANSITION')) {
    return new HttpError(409, '当前采购单状态不允许执行该操作', 'INVALID_PURCHASE_ORDER_TRANSITION');
  }
  if (message.includes('PURCHASE_ORDER_CLOSE_REASON_REQUIRED')) {
    return new HttpError(400, '关闭采购单剩余量时必须填写原因', 'PURCHASE_ORDER_CLOSE_REASON_REQUIRED');
  }
  if (message.includes('PURCHASE_ORDER_HAS_RECEIPTS')) {
    return new HttpError(409, '采购单已有收货记录，不能取消', 'PURCHASE_ORDER_HAS_RECEIPTS');
  }
  if (message.includes('PURCHASE_ORDER_NOT_RECEIVABLE')) {
    return new HttpError(409, '采购单尚未下单或已经收货完成', 'PURCHASE_ORDER_NOT_RECEIVABLE');
  }
  if (message.includes('INVALID_RECEIPT_WAREHOUSE')) {
    return new HttpError(409, '入库仓库不存在或不在当前数据范围内', 'RECEIPT_WAREHOUSE_NOT_FOUND');
  }
  if (message.includes('INVALID_PURCHASE_RECEIPT_LINE')
    || message.includes('ck_purchase_order_lines_received_range')) {
    return new HttpError(409, '收货数量超过采购单未到货数量，请刷新后重试', 'PURCHASE_RECEIPT_EXCEEDS_REMAINING');
  }
  return error;
}
