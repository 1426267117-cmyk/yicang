import type {
  CreatePurchaseOrderInput,
  CreatePurchaseReceiptInput,
  CreateSupplierInput,
  CreateWarehouseInput,
  PurchaseOrderActionInput,
  UpdatePurchaseOrderDraftInput,
} from './contracts';
import type { PurchasePlanningEvidence } from './purchase-planning-service';
import type { PurchaseRequestSource } from './purchase-workflow-service';
import { HttpError, requirePermission, type UserContext } from './db';
import { sha256Hex, stableJson } from './connectors/stable';
import { parsePurchaseProductDetails, resolvePurchaseProductDetails } from './purchase-product-details';

type PurchaseOrderStatus = 'draft' | 'issued' | 'partially_received' | 'received' | 'closed_short' | 'cancelled';

const PURCHASE_RECEIPT_FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

type SupplierRow = {
  id: string;
  code: string;
  name: string;
  contact_name: string | null;
  contact_phone: string | null;
  contact_email: string | null;
  address: string | null;
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
  contact_name: string | null;
  contact_phone: string | null;
  address: string | null;
  created_at: string;
};

type PurchaseOrderRow = {
  id: string;
  order_no: string;
  purchase_request_id: string;
  purchase_request_no: string;
  purchaser_member_id: string;
  supplier_id: string | null;
  supplier_code: string;
  supplier_name: string;
  supplier_contact_name: string | null;
  supplier_contact_phone: string | null;
  supplier_contact_email: string | null;
  supplier_address: string | null;
  delivery_warehouse_id: string | null;
  delivery_warehouse_code: string | null;
  delivery_warehouse_name: string | null;
  delivery_contact_name: string | null;
  delivery_contact_phone: string | null;
  delivery_address: string | null;
  expected_delivery_at: string | null;
  payment_terms: string | null;
  trade_terms: string | null;
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

type PurchaseOrderIssueReadinessRow = {
  id: string;
  status: PurchaseOrderStatus;
  version: number;
  purchase_request_id: string;
  request_source: PurchaseRequestSource;
  supplier_id: string | null;
  supplier_active: number | null;
  delivery_warehouse_id: string | null;
  expected_delivery_at: string | null;
  currency: string | null;
  delivery_warehouse_valid: number;
  line_count: number;
  missing_unit_cost_count: number;
  line_currency_mismatch_count: number;
  planning_audit_json: string | null;
  source_ready: number;
};

type PurchaseOrderPlanningSource = Pick<PurchaseOrderIssueReadinessRow, 'request_source' | 'planning_audit_json'>;
type PurchaseOrderWriteOptions = {
  developmentOpenAccess?: boolean;
  planningNow?: Date;
  validatePlanningEvidence?: (
    db: D1Database,
    user: UserContext,
    purchaseRequestId: string,
    evidence: PurchasePlanningEvidence,
  ) => Promise<void>;
};
type PurchaseOrderActor = {
  memberId: string;
  developmentOpenAccess: boolean;
  canActAsAdministrator: boolean;
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
  product_details_json: string | null;
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
  sku_active: number;
  requested_quantity: number;
  active: number;
  product_details_json: string | null;
  purchase_demand_id: string | null;
  demand_status: string | null;
  demand_mapped_sku_id: string | null;
  demand_required_quantity: number | null;
  demand_source_updated_at: string | null;
  source_required_quantity: number | null;
  source_updated_at: string | null;
};

type ReceiptTargetLineRow = {
  id: string;
  sku_id: string;
  ordered_quantity: number;
  received_quantity: number;
};

type PurchaseReceiptOrderReadinessRow = {
  id: string;
  status: PurchaseOrderStatus;
  version: number;
  delivery_warehouse_id: string | null;
  delivery_warehouse_valid: number;
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
      SELECT id, code, name, contact_name, contact_phone, contact_email, address,
        note, active, version, created_at, updated_at
      FROM suppliers
      WHERE tenant_id = ?
      ORDER BY active DESC, name, code
      LIMIT 500
    `).bind(user.tenantId).all<SupplierRow>(),
    db.prepare(`
      SELECT id, code, name, contact_name, contact_phone, address, created_at
      FROM warehouses
      WHERE tenant_id = ?
      ORDER BY code, name
      LIMIT 500
    `).bind(user.tenantId).all<WarehouseRow>(),
    db.prepare(`${PURCHASE_ORDER_SELECT}
      WHERE po.tenant_id = ?
        AND (
          po.status IN ('draft', 'issued', 'partially_received')
          OR po.id IN (
            SELECT recent.id
            FROM purchase_orders recent
            WHERE recent.tenant_id = ?
              AND recent.status NOT IN ('draft', 'issued', 'partially_received')
            ORDER BY recent.created_at DESC, recent.id DESC
            LIMIT 500
          )
        )
      GROUP BY po.id
      ORDER BY
        CASE WHEN po.status IN ('draft', 'issued', 'partially_received') THEN 0 ELSE 1 END,
        CASE WHEN po.status IN ('draft', 'issued', 'partially_received') THEN po.created_at END ASC,
        CASE WHEN po.status NOT IN ('draft', 'issued', 'partially_received') THEN po.created_at END DESC,
        po.id DESC
    `).bind(user.tenantId, user.tenantId).all<PurchaseOrderRow>(),
    db.prepare(`${PURCHASE_ORDER_LINE_SELECT}
      WHERE po.tenant_id = ?
        AND (
          po.status IN ('draft', 'issued', 'partially_received')
          OR po.id IN (
            SELECT recent.id
            FROM purchase_orders recent
            WHERE recent.tenant_id = ?
              AND recent.status NOT IN ('draft', 'issued', 'partially_received')
            ORDER BY recent.created_at DESC, recent.id DESC
            LIMIT 500
          )
        )
      ORDER BY
        CASE WHEN po.status IN ('draft', 'issued', 'partially_received') THEN 0 ELSE 1 END,
        CASE WHEN po.status IN ('draft', 'issued', 'partially_received') THEN po.created_at END ASC,
        CASE WHEN po.status NOT IN ('draft', 'issued', 'partially_received') THEN po.created_at END DESC,
        po.id DESC,
        line.created_at ASC,
        line.id ASC
    `).bind(user.tenantId, user.tenantId).all<PurchaseOrderLineRow>(),
    db.prepare(`${PURCHASE_RECEIPT_SELECT}
      WHERE receipt.tenant_id = ?
        AND (
          po.status IN ('draft', 'issued', 'partially_received')
          OR receipt.id IN (
            SELECT recent.id
            FROM purchase_receipts recent
            WHERE recent.tenant_id = ?
            ORDER BY recent.created_at DESC, recent.id DESC
            LIMIT 500
          )
        )
      GROUP BY receipt.id
      ORDER BY
        CASE WHEN po.status IN ('draft', 'issued', 'partially_received') THEN 0 ELSE 1 END,
        receipt.created_at DESC,
        receipt.id DESC
    `).bind(user.tenantId, user.tenantId).all<PurchaseReceiptRow>(),
    db.prepare(`${PURCHASE_RECEIPT_LINE_SELECT}
      WHERE receipt.tenant_id = ?
        AND (
          receipt.purchase_order_id IN (
            SELECT active_order.id
            FROM purchase_orders active_order
            WHERE active_order.tenant_id = ?
              AND active_order.status IN ('draft', 'issued', 'partially_received')
          )
          OR receipt.id IN (
            SELECT recent.id
            FROM purchase_receipts recent
            WHERE recent.tenant_id = ?
            ORDER BY recent.created_at DESC, recent.id DESC
            LIMIT 500
          )
        )
      ORDER BY receipt.created_at DESC, receipt.id DESC, line.created_at ASC, line.id ASC
    `).bind(user.tenantId, user.tenantId, user.tenantId).all<PurchaseReceiptLineRow>(),
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

  const { purchaseOrders, purchaseReceipts } = mapProcurementRecords(
    orderRows.results, orderLineRows.results, receiptRows.results, receiptLineRows.results,
  );
  return {
    suppliers: supplierRows.results.map(mapSupplier),
    warehouses: warehouseRows.results.map(mapWarehouse),
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

export function toWarehousePurchaseOrder(order: NonNullable<Awaited<ReturnType<typeof getPurchaseOrder>>>) {
  const { id, orderNo, status, deliveryWarehouse, expectedDeliveryAt, orderedQuantity, receivedQuantity, lines } = order;
  return { id, orderNo, status, deliveryWarehouse, expectedDeliveryAt, orderedQuantity, receivedQuantity,
    supplier: order.supplier ? { name: order.supplier.name } : null,
    lines: lines.map(({ id, skuCode, skuName, remainingQuantity }) => ({ id, skuCode, skuName, remainingQuantity })),
  };
}

export async function getWarehouseWorkspaceData(db: D1Database, user: UserContext) {
  requirePermission(user, 'warehouse:read');
  const tenantId = user.tenantId;
  const pending = "po.tenant_id = ? AND po.status IN ('issued', 'partially_received')";
  const recentReceipt = `receipt.tenant_id = ? AND receipt.id IN (
    SELECT id FROM purchase_receipts WHERE tenant_id = ? ORDER BY created_at DESC, id DESC LIMIT 500
  )`;
  const [warehouses, orders, orderLines, receipts, receiptLines, receiptCount] = await Promise.all([
    db.prepare(`SELECT id, code, name, contact_name, contact_phone, address, created_at FROM warehouses
      WHERE tenant_id = ? ORDER BY code, name LIMIT 500`).bind(tenantId).all<WarehouseRow>(),
    db.prepare(`${PURCHASE_ORDER_SELECT} WHERE ${pending} GROUP BY po.id ORDER BY po.created_at, po.id`)
      .bind(tenantId).all<PurchaseOrderRow>(),
    db.prepare(`${PURCHASE_ORDER_LINE_SELECT} WHERE ${pending} ORDER BY line.created_at, line.id`)
      .bind(tenantId).all<PurchaseOrderLineRow>(),
    db.prepare(`${PURCHASE_RECEIPT_SELECT} WHERE ${recentReceipt} GROUP BY receipt.id ORDER BY receipt.created_at DESC, receipt.id DESC`)
      .bind(tenantId, tenantId).all<PurchaseReceiptRow>(),
    db.prepare(`${PURCHASE_RECEIPT_LINE_SELECT} WHERE ${recentReceipt} ORDER BY line.created_at, line.id`)
      .bind(tenantId, tenantId).all<PurchaseReceiptLineRow>(),
    db.prepare('SELECT COUNT(*) AS count FROM purchase_receipts WHERE tenant_id = ?').bind(tenantId).first<{ count: number }>(),
  ]);
  const { purchaseOrders, purchaseReceipts } = mapProcurementRecords(orders.results, orderLines.results, receipts.results, receiptLines.results);
  return {
    warehouses: warehouses.results.map(mapWarehouse),
    purchaseOrders: purchaseOrders.map(toWarehousePurchaseOrder),
    purchaseReceipts,
    procurementSummary: { receiptCount: Number(receiptCount?.count ?? 0) },
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
    contactName: input.contactName?.trim() || null,
    contactPhone: input.contactPhone?.trim() || null,
    address: input.address?.trim() || null,
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
        INSERT INTO warehouses (
          id, tenant_id, code, name, contact_name, contact_phone, address, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        warehouseId,
        user.tenantId,
        normalized.code,
        normalized.name,
        normalized.contactName,
        normalized.contactPhone,
        normalized.address,
        now,
      ),
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
          contactName: normalized.contactName,
          contactPhone: normalized.contactPhone,
          address: normalized.address,
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
    contactName: input.contactName?.trim() || null,
    contactPhone: input.contactPhone?.trim() || null,
    contactEmail: input.contactEmail?.trim() || null,
    address: input.address?.trim() || null,
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
  const afterJson = stableJson({
    requestHash,
    code: normalized.code,
    name: normalized.name,
    contactName: normalized.contactName,
    contactPhone: normalized.contactPhone,
    contactEmail: normalized.contactEmail,
    address: normalized.address,
  });
  try {
    await db.batch([
      db.prepare(`
        INSERT INTO suppliers (
          id, tenant_id, code, name, contact_name, contact_phone, contact_email, address,
          note, active, version, idempotency_key,
          request_hash, created_by_member_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?, ?)
      `).bind(
        supplierId,
        user.tenantId,
        normalized.code,
        normalized.name,
        normalized.contactName,
        normalized.contactPhone,
        normalized.contactEmail,
        normalized.address,
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

const ORDER_LINE_PRODUCT_DETAILS_SQL = `COALESCE(line.product_details_json, CASE
  WHEN sku.specification IS NOT NULL OR sku.dimensions IS NOT NULL OR sku.image_url IS NOT NULL OR sku.description IS NOT NULL
  THEN json_object('name', sku.name, 'specification', sku.specification, 'dimensions', sku.dimensions,
    'imageUrl', sku.image_url, 'description', sku.description)
  ELSE NULL END)`;

export async function prepareApprovedPurchaseOrderDraft(
  db: D1Database,
  user: UserContext,
  args: { purchaseRequestId: string; approvedVersion: number; approvalIdempotencyKey: string; actorMemberId: string; now: string },
): Promise<D1PreparedStatement[]> {
  const orderId = crypto.randomUUID();
  const orderNo = createDocumentNumber('CGD');
  const idempotencyKey = await approvedDraftKey(args.purchaseRequestId, args.approvalIdempotencyKey);
  const { purchaseRequestId, approvedVersion, approvalIdempotencyKey, actorMemberId, now } = args;
  const draftExistsSql = 'EXISTS (SELECT 1 FROM purchase_orders WHERE id = ? AND tenant_id = ?)';
  return [
    db.prepare(`
      INSERT INTO purchase_orders (
        id, tenant_id, order_no, purchase_request_id, status, version,
        idempotency_key, request_hash, last_action_key, created_by_member_id, created_at, updated_at
      )
      SELECT ?, request.tenant_id, ?, request.id, 'draft', 1, ?, ?, ?, ?, ?, ?
      FROM purchase_requests request
      WHERE request.tenant_id = ? AND request.id = ? AND request.status = 'approved'
        AND request.version = ? AND request.last_action_key = ?
        AND NOT EXISTS (
          SELECT 1 FROM purchase_orders existing
          WHERE existing.tenant_id = request.tenant_id AND existing.purchase_request_id = request.id
            AND (existing.status <> 'cancelled' OR existing.idempotency_key = ?)
        )
    `).bind(orderId, orderNo, idempotencyKey, await hashPayload({ purchaseRequestId, approvalIdempotencyKey }),
      idempotencyKey, actorMemberId, now, now, user.tenantId, purchaseRequestId, approvedVersion,
      approvalIdempotencyKey, idempotencyKey),
    db.prepare(`
      INSERT INTO purchase_order_lines (
        id, tenant_id, purchase_order_id, purchase_request_line_id, sku_id, sku_code_snapshot,
        sku_name_snapshot, ordered_quantity, received_quantity, product_details_json, created_at, updated_at
      )
      SELECT lower(hex(randomblob(16))), line.tenant_id, ?, line.id, line.sku_id, sku.code,
        sku.name, line.requested_quantity, 0, ${ORDER_LINE_PRODUCT_DETAILS_SQL}, ?, ?
      FROM purchase_request_lines line
      JOIN skus sku ON sku.tenant_id = line.tenant_id AND sku.id = line.sku_id
      WHERE line.tenant_id = ? AND line.request_id = ? AND line.active = 1 AND ${draftExistsSql}
    `).bind(orderId, now, now, user.tenantId, purchaseRequestId, orderId, user.tenantId),
    auditStatement(db, user, {
      action: 'CREATE_PURCHASE_ORDER', entityType: 'purchase_order', entityId: orderId, beforeJson: null,
      afterJson: stableJson({ orderNo, purchaseRequestId, supplierId: null, autoFromApproval: true }),
      idempotencyKey, now, onlyWhenSql: draftExistsSql, onlyWhenBindings: [orderId, user.tenantId],
    }),
  ];
}

export async function getPurchaseOrderForApproval(
  db: D1Database, tenantId: string, purchaseRequestId: string, approvalIdempotencyKey: string,
) {
  const idempotencyKey = await approvedDraftKey(purchaseRequestId, approvalIdempotencyKey);
  const row = await db.prepare(`
    SELECT id FROM purchase_orders WHERE tenant_id = ? AND purchase_request_id = ? AND idempotency_key = ?
  `).bind(tenantId, purchaseRequestId, idempotencyKey).first<{ id: string }>();
  return row ? getPurchaseOrder(db, tenantId, row.id) : null;
}

async function approvedDraftKey(purchaseRequestId: string, approvalIdempotencyKey: string) {
  return `approval-draft:${await hashPayload([purchaseRequestId, approvalIdempotencyKey])}`;
}

export async function createPurchaseOrder(
  db: D1Database,
  user: UserContext,
  input: CreatePurchaseOrderInput,
  idempotencyKey: string,
  options: PurchaseOrderWriteOptions = {},
) {
  requirePermission(user, 'purchase:order:create');
  if (input.issue) requirePermission(user, 'purchase:order:issue');
  validateIdempotencyKey(idempotencyKey);
  const developmentOpenAccess = options.developmentOpenAccess === true;
  const normalized = {
    purchaseRequestId: input.purchaseRequestId.trim(),
    supplierId: input.supplierId?.trim() || null,
    deliveryWarehouseId: input.deliveryWarehouseId?.trim() || null,
    expectedDeliveryAt: input.expectedDeliveryAt ?? null,
    paymentTerms: input.paymentTerms?.trim() || null,
    tradeTerms: input.tradeTerms?.trim() || null,
    currency: input.currency?.trim().toUpperCase() || null,
    note: input.note?.trim() || null,
    lineCosts: [...(input.lineCosts ?? [])]
      .map(({ purchaseRequestLineId, unitCostMinor, productDetails }) => ({
        purchaseRequestLineId: purchaseRequestLineId.trim(), unitCostMinor, productDetails,
      }))
      .sort((left, right) => left.purchaseRequestLineId.localeCompare(right.purchaseRequestLineId)),
    ...(input.issue ? { issue: true } : {}),
  };
  const requestHash = await hashPayload(normalized);
  const actor = await authorizePurchaseOrderCreation(
    db,
    user,
    normalized.purchaseRequestId,
    developmentOpenAccess,
  );
  const replay = await db.prepare(`
    SELECT id, request_hash FROM purchase_orders
    WHERE tenant_id = ? AND idempotency_key = ?
    LIMIT 1
  `).bind(user.tenantId, idempotencyKey).first<{ id: string; request_hash: string }>();
  if (replay) {
    assertReplayHash(replay.request_hash, requestHash, '同一幂等键不能用于不同的采购单参数');
    return { purchaseOrder: await getPurchaseOrder(db, user.tenantId, replay.id), replayed: true };
  }

  const [supplier, deliveryWarehouse, request, requestLines] = await Promise.all([
    normalized.supplierId ? db.prepare(`
      SELECT id, code, name, contact_name, contact_phone, contact_email, address
      FROM suppliers
      WHERE tenant_id = ? AND id = ? AND active = 1
      LIMIT 1
    `).bind(user.tenantId, normalized.supplierId).first<{
      id: string;
      code: string;
      name: string;
      contact_name: string | null;
      contact_phone: string | null;
      contact_email: string | null;
      address: string | null;
    }>() : null,
    normalized.deliveryWarehouseId
      ? db.prepare(`
          SELECT id, code, name, contact_name, contact_phone, address, created_at
          FROM warehouses
          WHERE tenant_id = ? AND id = ?
          LIMIT 1
        `).bind(user.tenantId, normalized.deliveryWarehouseId).first<WarehouseRow>()
      : Promise.resolve(null),
    db.prepare(`
      SELECT request.id, request.status, request.source, request.note,
        ${PURCHASE_REQUEST_PLANNING_AUDIT_SQL} AS planning_audit_json
      FROM purchase_requests request
      WHERE request.tenant_id = ? AND request.id = ?
      LIMIT 1
    `).bind(user.tenantId, normalized.purchaseRequestId).first<{
      id: string; status: string; source: PurchaseRequestSource; note: string | null; planning_audit_json: string | null;
    }>(),
    loadRequestLines(db, user.tenantId, normalized.purchaseRequestId),
  ]);
  if (normalized.supplierId && !supplier) throw new HttpError(404, '供应商不存在或已停用', 'PURCHASE_SUPPLIER_NOT_FOUND');
  if (normalized.deliveryWarehouseId && !deliveryWarehouse) {
    throw new HttpError(404, '收货仓库不存在或不在当前数据范围内', 'PURCHASE_DELIVERY_WAREHOUSE_NOT_FOUND');
  }
  if (!request) throw new HttpError(404, '采购申请不存在或不在当前数据范围内', 'PURCHASE_REQUEST_NOT_FOUND');
  if (request.status !== 'approved') {
    throw new HttpError(409, '只有已批准的采购申请才能生成正式采购单', 'PURCHASE_REQUEST_NOT_APPROVED');
  }
  if (requestLines.length === 0) {
    throw new HttpError(409, '采购申请没有可下单明细', 'PURCHASE_REQUEST_EMPTY');
  }
  assertRequestLinesCurrent(requestLines, request.source);

  const lineCostMap = new Map(normalized.lineCosts.map((line) => [line.purchaseRequestLineId, line.unitCostMinor]));
  const lineDetails = new Map(normalized.lineCosts.map((line) => [line.purchaseRequestLineId, line.productDetails]));
  const requestLineIds = new Set(requestLines.map((line) => line.id));
  if (normalized.lineCosts.some((line) => !requestLineIds.has(line.purchaseRequestLineId))) {
    throw new HttpError(400, '采购单价格包含不属于该申请的明细', 'PURCHASE_ORDER_LINE_INVALID');
  }

  if (input.issue) {
    assertPurchaseOrderIssuable({
      supplier_id: supplier?.id ?? null,
      supplier_active: Number(Boolean(supplier)),
      delivery_warehouse_id: normalized.deliveryWarehouseId,
      delivery_warehouse_valid: Number(Boolean(deliveryWarehouse)),
      expected_delivery_at: normalized.expectedDeliveryAt,
      currency: normalized.currency,
      line_count: requestLines.length,
      missing_unit_cost_count: requestLines.filter((line) => (lineCostMap.get(line.id) ?? -1) < 0).length,
      line_currency_mismatch_count: 0,
    });
    if (request.source === 'manual' && !request.note?.trim()) {
      throw new HttpError(409, '采购申请缺少采购原因，请复核后再提交', 'PURCHASE_REQUEST_CHANGED');
    }
    await validateIssuePlanningBasis(db, user, request.id, {
      request_source: request.source, planning_audit_json: request.planning_audit_json,
    }, options);
  }

  const now = new Date().toISOString();
  const purchaseOrderId = crypto.randomUUID();
  const orderNo = createDocumentNumber('CGD');
  const statements: D1PreparedStatement[] = [
    db.prepare(`
      INSERT INTO purchase_orders (
        id, tenant_id, order_no, purchase_request_id, supplier_id,
        delivery_warehouse_id, expected_delivery_at, payment_terms, trade_terms,
        supplier_code_snapshot, supplier_name_snapshot,
        supplier_contact_name_snapshot, supplier_contact_phone_snapshot,
        supplier_contact_email_snapshot, supplier_address_snapshot,
        delivery_warehouse_code_snapshot, delivery_warehouse_name_snapshot,
        delivery_contact_name_snapshot, delivery_contact_phone_snapshot,
        delivery_address_snapshot, status,
        currency, note, action_note, version, idempotency_key, request_hash,
        last_action_key, created_by_member_id, issued_at, closed_at, cancelled_at, created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
        CASE WHEN ${purchaseOrderActorGuardSql('?', '?')} THEN 'draft' ELSE NULL END,
        ?, ?, NULL, 1, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?
      )
    `).bind(
      purchaseOrderId,
      user.tenantId,
      orderNo,
      normalized.purchaseRequestId,
      normalized.supplierId,
      normalized.deliveryWarehouseId,
      normalized.expectedDeliveryAt,
      normalized.paymentTerms,
      normalized.tradeTerms,
      supplier?.code ?? null,
      supplier?.name ?? null,
      supplier?.contact_name ?? null,
      supplier?.contact_phone ?? null,
      supplier?.contact_email ?? null,
      supplier?.address ?? null,
      deliveryWarehouse?.code ?? null,
      deliveryWarehouse?.name ?? null,
      deliveryWarehouse?.contact_name ?? null,
      deliveryWarehouse?.contact_phone ?? null,
      deliveryWarehouse?.address ?? null,
      ...purchaseOrderActorBindings(actor),
      user.tenantId,
      normalized.purchaseRequestId,
      normalized.currency,
      normalized.note,
      idempotencyKey,
      requestHash,
      idempotencyKey,
      actor.memberId,
      now,
      now,
    ),
  ];
  for (const line of requestLines) {
    const unitCostMinor = lineCostMap.get(line.id) ?? null;
    const details = lineDetails.get(line.id);
    statements.push(db.prepare(`
      INSERT INTO purchase_order_lines (
        id, tenant_id, purchase_order_id, purchase_request_line_id, sku_id,
        sku_code_snapshot, sku_name_snapshot, ordered_quantity, received_quantity,
        unit_cost_minor, currency, product_details_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)
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
      details ? stableJson(resolvePurchaseProductDetails(parsePurchaseProductDetails(line.product_details_json), details)) : line.product_details_json,
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
      deliveryWarehouseId: normalized.deliveryWarehouseId,
      expectedDeliveryAt: normalized.expectedDeliveryAt,
      paymentTerms: normalized.paymentTerms,
      tradeTerms: normalized.tradeTerms,
      lineCount: requestLines.length,
    }),
    idempotencyKey,
    now,
  }));
  if (input.issue) {
    statements.push(...await combinedIssueStatements(db, user, {
      id: purchaseOrderId, version: 1, idempotencyKey, now, actor,
    }));
  }

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

export async function updatePurchaseOrderDraft(
  db: D1Database,
  user: UserContext,
  purchaseOrderId: string,
  input: UpdatePurchaseOrderDraftInput,
  idempotencyKey: string,
  options: PurchaseOrderWriteOptions = {},
) {
  requirePermission(user, 'purchase:order:issue');
  validateIdempotencyKey(idempotencyKey);
  const legacyPatch = typeof input.expectedDeliveryAt === 'string' && typeof input.currency === 'string'
    && input.supplierId === undefined && input.deliveryWarehouseId === undefined
    && input.lineCosts?.every((line) => typeof line.unitCostMinor === 'number' && line.productDetails === undefined);
  const normalized = {
    expectedVersion: input.expectedVersion,
    expectedDeliveryAt: input.expectedDeliveryAt,
    supplierId: input.supplierId,
    deliveryWarehouseId: input.deliveryWarehouseId,
    paymentTerms: input.paymentTerms === undefined && !legacyPatch ? undefined : input.paymentTerms?.trim() || null,
    tradeTerms: input.tradeTerms === undefined && !legacyPatch ? undefined : input.tradeTerms?.trim() || null,
    currency: input.currency === undefined ? undefined : input.currency?.trim().toUpperCase() || null,
    note: input.note === undefined && !legacyPatch ? undefined : input.note?.trim() || null,
    lineCosts: input.lineCosts
      ?.map(({ purchaseRequestLineId, unitCostMinor, productDetails }) => ({
        purchaseRequestLineId: purchaseRequestLineId.trim(), unitCostMinor, productDetails,
      }))
      .sort((left, right) => left.purchaseRequestLineId.localeCompare(right.purchaseRequestLineId)),
    ...(input.issue ? { issue: true } : {}),
  };
  const developmentOpenAccess = options.developmentOpenAccess === true;
  const actor = await authorizePurchaseOrderAction(db, user, purchaseOrderId, developmentOpenAccess, true);
  const action = 'UPDATE_PURCHASE_ORDER_DRAFT';
  const requestHash = await hashPayload(normalized);
  const isReplay = () => readActionReplay(db, user.tenantId, purchaseOrderId, action, requestHash, idempotencyKey);
  if (await isReplay()) {
    return { purchaseOrder: await getPurchaseOrder(db, user.tenantId, purchaseOrderId), replayed: true };
  }

  const current = await getPurchaseOrder(db, user.tenantId, purchaseOrderId);
  if (input.issue && (current.status !== 'draft' || current.version !== normalized.expectedVersion)
    && await isReplay()) {
    return { purchaseOrder: current, replayed: true };
  }
  if (current.status !== 'draft') {
    throw new HttpError(409, '只有采购单草稿可以编辑', 'PURCHASE_ORDER_NOT_EDITABLE');
  }
  if (current.version !== normalized.expectedVersion) {
    throw new HttpError(409, '采购单草稿已更新，请刷新后重新编辑', 'CONCURRENT_UPDATE');
  }
  const submittedLines = new Map(normalized.lineCosts?.map((line) => [line.purchaseRequestLineId, line]));
  const currentLineIds = new Set(current.lines.map((line) => line.purchaseRequestLineId));
  if (submittedLines.size !== (normalized.lineCosts?.length ?? 0) || (legacyPatch && submittedLines.size !== current.lines.length)
    || [...submittedLines.keys()].some((id) => !currentLineIds.has(id))) {
    throw new HttpError(400, '只能编辑该采购单中已批准的采购明细', 'PURCHASE_ORDER_LINE_INVALID');
  }

  const previousSupplierId = current.supplier?.id ?? null;
  const previousWarehouseId = current.deliveryWarehouse?.id ?? null;
  const supplierId = normalized.supplierId === undefined ? previousSupplierId : normalized.supplierId;
  const warehouseId = normalized.deliveryWarehouseId === undefined ? previousWarehouseId : normalized.deliveryWarehouseId;
  const supplierChanged = supplierId !== previousSupplierId;
  const warehouseChanged = warehouseId !== previousWarehouseId;
  const [supplier, warehouse] = await Promise.all([
    supplierChanged && supplierId ? db.prepare(`
      SELECT code, name, contact_name, contact_phone, contact_email, address FROM suppliers
      WHERE tenant_id = ? AND id = ? AND active = 1
    `).bind(user.tenantId, supplierId).first<Pick<SupplierRow, 'code' | 'name' | 'contact_name' | 'contact_phone' | 'contact_email' | 'address'>>() : null,
    warehouseChanged && warehouseId ? db.prepare(`
      SELECT code, name, contact_name, contact_phone, address FROM warehouses WHERE tenant_id = ? AND id = ?
    `).bind(user.tenantId, warehouseId).first<Pick<WarehouseRow, 'code' | 'name' | 'contact_name' | 'contact_phone' | 'address'>>() : null,
  ]);
  if (supplierChanged && supplierId && !supplier) throw new HttpError(404, '供应商不存在或已停用', 'PURCHASE_SUPPLIER_NOT_FOUND');
  if (warehouseChanged && warehouseId && !warehouse) throw new HttpError(404, '收货仓库不存在或不在当前数据范围内', 'PURCHASE_DELIVERY_WAREHOUSE_NOT_FOUND');
  const expectedDeliveryAt = normalized.expectedDeliveryAt === undefined ? current.expectedDeliveryAt : normalized.expectedDeliveryAt;
  const currency = normalized.currency === undefined ? current.currency : normalized.currency;
  const paymentTerms = normalized.paymentTerms === undefined ? current.paymentTerms : normalized.paymentTerms;
  const tradeTerms = normalized.tradeTerms === undefined ? current.tradeTerms : normalized.tradeTerms;
  const note = normalized.note === undefined ? current.note : normalized.note;
  const updatedLines = current.lines.map((line) => {
    const patch = submittedLines.get(line.purchaseRequestLineId);
    return {
      purchaseRequestLineId: line.purchaseRequestLineId,
      unitCostMinor: patch?.unitCostMinor === undefined ? line.unitCostMinor : patch.unitCostMinor,
      productDetails: patch?.productDetails === undefined ? undefined : resolvePurchaseProductDetails(line.productDetails ?? null, patch.productDetails),
    };
  });

  if (input.issue) {
    const readiness = await loadPurchaseOrderIssueReadiness(db, user.tenantId, purchaseOrderId);
    if (!readiness || readiness.status !== 'draft' || readiness.version !== current.version) {
      if (await isReplay()) {
        return { purchaseOrder: await getPurchaseOrder(db, user.tenantId, purchaseOrderId), replayed: true };
      }
      throw new HttpError(409, '采购单草稿已更新，请刷新并核对后再确认下单', 'CONCURRENT_UPDATE');
    }
    assertPurchaseOrderIssuable({ ...readiness, expected_delivery_at: expectedDeliveryAt,
      supplier_id: supplierId, supplier_active: supplierChanged ? Number(Boolean(supplier)) : readiness.supplier_active,
      delivery_warehouse_id: warehouseId, delivery_warehouse_valid: warehouseChanged ? Number(Boolean(warehouse)) : readiness.delivery_warehouse_valid,
      currency, missing_unit_cost_count: updatedLines.filter((line) => line.unitCostMinor === null || line.unitCostMinor < 0).length,
      line_currency_mismatch_count: 0 });
    assertPurchaseOrderSourceCurrent(readiness);
    await validateIssuePlanningBasis(db, user, readiness.purchase_request_id, readiness, options);
  }

  const now = new Date().toISOString();
  const nextVersion = current.version + 1;
  const updatedOrderSql = `EXISTS (
    SELECT 1 FROM purchase_orders
    WHERE id = ? AND tenant_id = ? AND version = ? AND status = 'draft' AND last_action_key = ?
  )`;
  const updatedOrderBindings = [purchaseOrderId, user.tenantId, nextVersion, idempotencyKey];
  const beforeJson = stableJson({
    version: current.version,
    supplierId: previousSupplierId,
    deliveryWarehouseId: previousWarehouseId,
    expectedDeliveryAt: current.expectedDeliveryAt,
    paymentTerms: current.paymentTerms,
    tradeTerms: current.tradeTerms,
    currency: current.currency,
    note: current.note,
    lineCosts: current.lines.map(({ purchaseRequestLineId, unitCostMinor, currency, productDetails }) => ({
      purchaseRequestLineId, unitCostMinor, currency, productDetails,
    })),
  });
  const issueStatements = input.issue ? await combinedIssueStatements(db, user, {
    id: purchaseOrderId, version: nextVersion, idempotencyKey, now, actor,
  }) : [];
  let changed = false;
  try {
    const [orderUpdate] = await db.batch([
      db.prepare(`
        UPDATE purchase_orders
        SET expected_delivery_at = ?, payment_terms = ?, trade_terms = ?, currency = ?, note = ?,
            ${supplierChanged ? `supplier_id = ?, supplier_code_snapshot = ?, supplier_name_snapshot = ?,
              supplier_contact_name_snapshot = ?, supplier_contact_phone_snapshot = ?, supplier_contact_email_snapshot = ?, supplier_address_snapshot = ?,` : ''}
            ${warehouseChanged ? `delivery_warehouse_id = ?, delivery_warehouse_code_snapshot = ?, delivery_warehouse_name_snapshot = ?,
              delivery_contact_name_snapshot = ?, delivery_contact_phone_snapshot = ?, delivery_address_snapshot = ?,` : ''}
            version = version + 1, last_action_key = ?, updated_at = ?
        WHERE id = ? AND tenant_id = ? AND status = 'draft' AND version = ?
          AND ${PURCHASE_ORDER_ACTOR_GUARD_SQL}
      `).bind(
        expectedDeliveryAt,
        paymentTerms,
        tradeTerms,
        currency,
        note,
        ...(supplierChanged ? [supplierId, supplier?.code ?? null, supplier?.name ?? null, supplier?.contact_name ?? null,
          supplier?.contact_phone ?? null, supplier?.contact_email ?? null, supplier?.address ?? null] : []),
        ...(warehouseChanged ? [warehouseId, warehouse?.code ?? null, warehouse?.name ?? null, warehouse?.contact_name ?? null,
          warehouse?.contact_phone ?? null, warehouse?.address ?? null] : []),
        idempotencyKey,
        now,
        purchaseOrderId,
        user.tenantId,
        current.version,
        ...purchaseOrderActorBindings(actor),
      ),
      db.prepare(`
        UPDATE purchase_order_lines AS line
        SET unit_cost_minor = json_extract(cost.value, '$.unitCostMinor'), currency = ?, updated_at = ?,
          product_details_json = CASE WHEN json_type(cost.value, '$.productDetails') IS NULL THEN line.product_details_json
            ELSE json_extract(cost.value, '$.productDetails') END
        FROM json_each(?) AS cost
        WHERE line.tenant_id = ? AND line.purchase_order_id = ?
          AND line.purchase_request_line_id = json_extract(cost.value, '$.purchaseRequestLineId')
          AND ${updatedOrderSql}
      `).bind(
        currency,
        now,
        stableJson(updatedLines),
        user.tenantId,
        purchaseOrderId,
        ...updatedOrderBindings,
      ),
      auditStatement(db, user, {
        action,
        entityType: 'purchase_order',
        entityId: purchaseOrderId,
        beforeJson,
        afterJson: stableJson({ ...normalized, requestHash, version: nextVersion }),
        idempotencyKey,
        now,
        onlyWhenSql: updatedOrderSql,
        onlyWhenBindings: updatedOrderBindings,
      }),
      ...issueStatements,
    ]);
    changed = orderUpdate.meta.changes === 1;
  } catch (error) {
    if (await isReplay()) {
      return { purchaseOrder: await getPurchaseOrder(db, user.tenantId, purchaseOrderId), replayed: true };
    }
    throw translateProcurementError(error);
  }
  if (!changed) {
    if (await isReplay()) {
      return { purchaseOrder: await getPurchaseOrder(db, user.tenantId, purchaseOrderId), replayed: true };
    }
    await authorizePurchaseOrderAction(db, user, purchaseOrderId, developmentOpenAccess, true);
    throw new HttpError(409, '采购单草稿已更新，请刷新后重新编辑', 'CONCURRENT_UPDATE');
  }
  return { purchaseOrder: await getPurchaseOrder(db, user.tenantId, purchaseOrderId), replayed: false };
}

export async function executePurchaseOrderAction(
  db: D1Database,
  user: UserContext,
  purchaseOrderId: string,
  input: PurchaseOrderActionInput,
  idempotencyKey: string,
  options: PurchaseOrderWriteOptions = {},
) {
  requirePermission(user, 'purchase:order:issue');
  validateIdempotencyKey(idempotencyKey);
  const expectedVersion = input.action === 'issue' ? input.expectedVersion : undefined;
  const normalized = {
    action: input.action,
    note: input.note?.trim() || null,
    ...(expectedVersion === undefined ? {} : { expectedVersion }),
  };
  if (normalized.action === 'close' && !normalized.note) {
    throw new HttpError(400, '关闭采购单剩余量时必须填写原因', 'PURCHASE_ORDER_CLOSE_REASON_REQUIRED');
  }
  const requestHash = await hashPayload(normalized);
  const auditAction = input.action === 'issue'
    ? 'ISSUE_PURCHASE_ORDER'
    : input.action === 'close'
      ? 'CLOSE_PURCHASE_ORDER_REMAINDER'
      : 'CANCEL_PURCHASE_ORDER';
  const developmentOpenAccess = options.developmentOpenAccess === true;
  const actor = await authorizePurchaseOrderAction(
    db,
    user,
    purchaseOrderId,
    developmentOpenAccess,
    input.action === 'issue',
  );
  const replay = await readActionReplay(db, user.tenantId, purchaseOrderId, auditAction, requestHash, idempotencyKey);
  if (replay) return { purchaseOrder: await getPurchaseOrder(db, user.tenantId, purchaseOrderId), replayed: true };

  const current = await loadPurchaseOrderIssueReadiness(db, user.tenantId, purchaseOrderId);
  if (!current) throw new HttpError(404, '采购单不存在或不在当前数据范围内', 'PURCHASE_ORDER_NOT_FOUND');
  if (expectedVersion !== undefined && current.version !== expectedVersion) {
    throw new HttpError(409, '采购单草稿已更新，请刷新并核对后再确认下单', 'CONCURRENT_UPDATE');
  }
  const validCurrentStatus = input.action === 'close'
    ? current.status === 'issued' || current.status === 'partially_received'
    : current.status === 'draft';
  if (!validCurrentStatus) {
    throw new HttpError(409, '当前采购单状态不允许执行该操作', 'INVALID_PURCHASE_ORDER_TRANSITION');
  }
  if (input.action === 'issue') {
    assertPurchaseOrderIssuable(current);
    await validateIssuePlanningBasis(db, user, current.purchase_request_id, current, options);
    assertPurchaseOrderSourceCurrent(current);
    const request = await db.prepare(`
      SELECT status FROM purchase_requests WHERE tenant_id = ? AND id = ? LIMIT 1
    `).bind(user.tenantId, current.purchase_request_id).first<{ status: string }>();
    const lines = await loadRequestLines(db, user.tenantId, current.purchase_request_id);
    if (request?.status !== 'approved' || lines.length === 0) {
      throw new HttpError(409, '来源采购申请已变化，不能确认下单', 'PURCHASE_REQUEST_CHANGED');
    }
    assertRequestLinesCurrent(lines, current.request_source);
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
          AND ${PURCHASE_ORDER_ACTOR_GUARD_SQL}
          AND (
            (? = 'close' AND status IN ('issued', 'partially_received'))
            OR (? <> 'close' AND status = 'draft')
          )
          AND (
            ? <> 'issue'
            OR (
              ${PURCHASE_ORDER_ISSUE_GUARD_SQL}
              AND ${purchaseOrderIssueBasisGuardSql('purchase_orders')}
              AND ${purchaseOrderSourceGuardSql('purchase_orders')}
            )
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
        ...purchaseOrderActorBindings(actor),
        input.action,
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
    await authorizePurchaseOrderAction(db, user, purchaseOrderId, developmentOpenAccess, input.action === 'issue');
    if (input.action === 'issue') {
      const latest = await loadPurchaseOrderIssueReadiness(db, user.tenantId, purchaseOrderId);
      if (latest?.status === 'draft' && latest.version === current.version) {
        assertPurchaseOrderIssuable(latest);
        readPurchaseOrderPlanningEvidence(latest);
        assertPurchaseOrderSourceCurrent(latest);
      }
    }
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
  options: { now?: Date } = {},
) {
  requirePermission(user, 'inventory:receive');
  validateIdempotencyKey(idempotencyKey);
  const clock = options.now ?? new Date();
  if (Number.isNaN(clock.getTime())) {
    throw new HttpError(500, '系统时间无效，暂不能登记到货', 'PURCHASE_RECEIPT_CLOCK_INVALID');
  }
  const normalized = {
    purchaseOrderId,
    warehouseId: input.warehouseId.trim(),
    receivedAt: normalizePurchaseReceiptTime(input.receivedAt, clock),
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
    loadPurchaseReceiptOrderReadiness(db, user.tenantId, purchaseOrderId),
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
  assertPurchaseReceiptWarehouse(purchaseOrder, normalized.warehouseId);
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

  const now = clock.toISOString();
  const receivedAt = normalized.receivedAt ?? now;
  const receiptId = crypto.randomUUID();
  const receiptNo = createDocumentNumber('SH');
  const statements: D1PreparedStatement[] = [
    db.prepare(`
      INSERT INTO purchase_receipts (
        id, tenant_id, receipt_no, purchase_order_id, warehouse_id, status,
        note, idempotency_key, request_hash, created_by_member_id, received_at, created_at
      )
      SELECT ?, ?, ?, purchase_order.id, delivery_warehouse.id, 'posted', ?, ?, ?, ?, ?, ?
      FROM purchase_orders purchase_order
      JOIN warehouses delivery_warehouse
        ON delivery_warehouse.id = purchase_order.delivery_warehouse_id
        AND delivery_warehouse.tenant_id = purchase_order.tenant_id
      WHERE purchase_order.id = ?
        AND purchase_order.tenant_id = ?
        AND purchase_order.status IN ('issued', 'partially_received')
        AND delivery_warehouse.id = ?
    `).bind(
      receiptId,
      user.tenantId,
      receiptNo,
      normalized.note,
      idempotencyKey,
      requestHash,
      actorMemberId,
      receivedAt,
      now,
      purchaseOrderId,
      user.tenantId,
      normalized.warehouseId,
    ),
  ];
  for (const line of normalized.lines) {
    const target = targetById.get(line.purchaseOrderLineId)!;
    statements.push(db.prepare(`
      INSERT INTO purchase_receipt_lines (
        id, tenant_id, purchase_receipt_id, purchase_order_line_id,
        sku_id, warehouse_id, quantity, created_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?
      FROM purchase_receipts receipt
      WHERE receipt.id = ? AND receipt.tenant_id = ?
    `).bind(
      crypto.randomUUID(),
      user.tenantId,
      receiptId,
      line.purchaseOrderLineId,
      target.sku_id,
      normalized.warehouseId,
      line.quantity,
      now,
      receiptId,
      user.tenantId,
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
    onlyWhenSql: `EXISTS (
      SELECT 1 FROM purchase_receipts
      WHERE id = ? AND tenant_id = ?
    )`,
    onlyWhenBindings: [receiptId, user.tenantId],
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
  const created = await db.prepare(`
    SELECT id FROM purchase_receipts WHERE tenant_id = ? AND id = ? LIMIT 1
  `).bind(user.tenantId, receiptId).first<{ id: string }>();
  if (!created) {
    const latest = await loadPurchaseReceiptOrderReadiness(db, user.tenantId, purchaseOrderId);
    if (!latest) {
      throw new HttpError(404, '采购单不存在或不在当前数据范围内', 'PURCHASE_ORDER_NOT_FOUND');
    }
    if (latest.status !== 'issued' && latest.status !== 'partially_received') {
      throw new HttpError(409, '采购单尚未下单或已经收货完成', 'PURCHASE_ORDER_NOT_RECEIVABLE');
    }
    assertPurchaseReceiptWarehouse(latest, normalized.warehouseId);
    throw new HttpError(409, '采购单已被其他操作更新，请刷新后重试', 'CONCURRENT_UPDATE');
  }
  return {
    receipt: await getPurchaseReceipt(db, user.tenantId, receiptId),
    purchaseOrder: await getPurchaseOrder(db, user.tenantId, purchaseOrderId),
    replayed: false,
  };
}

export async function getSupplier(db: D1Database, tenantId: string, supplierId: string) {
  const row = await db.prepare(`
    SELECT id, code, name, contact_name, contact_phone, contact_email, address,
      note, active, version, created_at, updated_at
    FROM suppliers
    WHERE tenant_id = ? AND id = ?
    LIMIT 1
  `).bind(tenantId, supplierId).first<SupplierRow>();
  if (!row) throw new HttpError(404, '供应商不存在或不在当前数据范围内', 'PURCHASE_SUPPLIER_NOT_FOUND');
  return mapSupplier(row);
}

export async function getWarehouse(db: D1Database, tenantId: string, warehouseId: string) {
  const row = await db.prepare(`
    SELECT id, code, name, contact_name, contact_phone, address, created_at
    FROM warehouses
    WHERE tenant_id = ? AND id = ?
    LIMIT 1
  `).bind(tenantId, warehouseId).first<WarehouseRow>();
  if (!row) throw new HttpError(404, '仓库不存在或不在当前数据范围内', 'WAREHOUSE_NOT_FOUND');
  return mapWarehouse(row);
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

const PURCHASE_ORDER_ISSUE_GUARD_SQL = `
  EXISTS (
    SELECT 1
    FROM suppliers issue_supplier
    WHERE issue_supplier.id = purchase_orders.supplier_id
      AND issue_supplier.tenant_id = purchase_orders.tenant_id
      AND issue_supplier.active = 1
  )
  AND purchase_orders.delivery_warehouse_id IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM warehouses issue_warehouse
    WHERE issue_warehouse.id = purchase_orders.delivery_warehouse_id
      AND issue_warehouse.tenant_id = purchase_orders.tenant_id
  )
  AND purchase_orders.expected_delivery_at IS NOT NULL
  AND trim(purchase_orders.expected_delivery_at) <> ''
  AND length(purchase_orders.currency) = 3
  AND purchase_orders.currency GLOB '[A-Z][A-Z][A-Z]'
  AND EXISTS (
    SELECT 1
    FROM purchase_order_lines issue_line
    WHERE issue_line.purchase_order_id = purchase_orders.id
      AND issue_line.tenant_id = purchase_orders.tenant_id
  )
  AND NOT EXISTS (
    SELECT 1
    FROM purchase_order_lines issue_line
    WHERE issue_line.purchase_order_id = purchase_orders.id
      AND issue_line.tenant_id = purchase_orders.tenant_id
      AND (
        issue_line.unit_cost_minor IS NULL
        OR issue_line.unit_cost_minor < 0
        OR issue_line.currency IS NULL
        OR issue_line.currency <> purchase_orders.currency
      )
  )
`;

function purchaseOrderIssueBasisGuardSql(orderAlias: 'po' | 'purchase_orders') {
  return `
    (
    EXISTS (
      SELECT 1 FROM purchase_requests manual_request
      WHERE manual_request.id = ${orderAlias}.purchase_request_id
        AND manual_request.tenant_id = ${orderAlias}.tenant_id
        AND manual_request.source = 'manual'
        AND length(trim(manual_request.note)) > 0
    )
    OR
    EXISTS (
      SELECT 1
      FROM audit_logs planning_audit
      WHERE planning_audit.tenant_id = ${orderAlias}.tenant_id
        AND planning_audit.entity_type = 'purchase_request'
        AND planning_audit.entity_id = ${orderAlias}.purchase_request_id
        AND planning_audit.action = 'CREATE_PURCHASE_REQUEST_FROM_PLAN'
        AND CASE
          WHEN json_valid(planning_audit.after_json)
            AND json_type(planning_audit.after_json, '$.planningEvidence') = 'object'
            AND json_extract(planning_audit.after_json, '$.planningEvidence.schemaVersion') = 1
            AND json_type(planning_audit.after_json, '$.planningEvidence.rows') = 'array'
            AND json_array_length(planning_audit.after_json, '$.planningEvidence.rows') > 0
          THEN NOT EXISTS (
            SELECT 1
            FROM json_each(planning_audit.after_json, '$.planningEvidence.rows') evidence_row
            WHERE json_type(evidence_row.value) <> 'object'
              OR json_type(evidence_row.value, '$.planRowId') <> 'text'
              OR json_type(evidence_row.value, '$.skuId') <> 'text'
              OR json_type(evidence_row.value, '$.recommendationVersion') <> 'text'
              OR json_type(evidence_row.value, '$.allocations') <> 'array'
              OR json_array_length(evidence_row.value, '$.allocations') = 0
              OR EXISTS (
                SELECT 1
                FROM json_each(evidence_row.value, '$.allocations') evidence_allocation
                WHERE json_type(evidence_allocation.value) <> 'object'
                  OR json_type(evidence_allocation.value, '$.demandId') <> 'text'
                  OR json_type(evidence_allocation.value, '$.quantity') <> 'integer'
                  OR json_extract(evidence_allocation.value, '$.quantity') <= 0
              )
          )
          ELSE 0
        END = 1
    )
    )
  `;
}

function purchaseOrderSourceGuardSql(orderAlias: 'po' | 'purchase_orders') {
  return `
    EXISTS (
      SELECT 1
      FROM purchase_requests issue_request
      WHERE issue_request.id = ${orderAlias}.purchase_request_id
        AND issue_request.tenant_id = ${orderAlias}.tenant_id
        AND issue_request.status = 'approved'
        AND (issue_request.source <> 'manual' OR length(trim(issue_request.note)) > 0)
    )
    AND EXISTS (
      SELECT 1
      FROM purchase_order_lines issue_line
      WHERE issue_line.purchase_order_id = ${orderAlias}.id
        AND issue_line.tenant_id = ${orderAlias}.tenant_id
    )
    AND NOT EXISTS (
      SELECT 1
      FROM purchase_order_lines issue_line
      JOIN purchase_requests issue_request
        ON issue_request.id = ${orderAlias}.purchase_request_id
        AND issue_request.tenant_id = issue_line.tenant_id
      LEFT JOIN purchase_request_lines request_line
        ON request_line.id = issue_line.purchase_request_line_id
        AND request_line.tenant_id = issue_line.tenant_id
      LEFT JOIN purchase_demands demand
        ON demand.id = request_line.purchase_demand_id
        AND demand.tenant_id = request_line.tenant_id
      LEFT JOIN skus sku
        ON sku.id = request_line.sku_id AND sku.tenant_id = request_line.tenant_id
      WHERE issue_line.purchase_order_id = ${orderAlias}.id
        AND issue_line.tenant_id = ${orderAlias}.tenant_id
        AND (
          request_line.id IS NULL
          OR request_line.request_id IS NOT ${orderAlias}.purchase_request_id
          OR request_line.active <> 1
          OR request_line.sku_id IS NOT issue_line.sku_id
          OR request_line.requested_quantity <> issue_line.ordered_quantity
          OR CASE WHEN issue_request.source = 'manual' THEN
            request_line.purchase_demand_id IS NOT NULL
            OR request_line.source_required_quantity IS NOT NULL
            OR request_line.source_updated_at IS NOT NULL
            OR sku.active IS NOT 1
          ELSE
            demand.id IS NULL
            OR demand.status <> 'open'
            OR demand.mapped_sku_id IS NOT request_line.sku_id
            OR demand.required_quantity IS NULL
            OR demand.required_quantity < request_line.requested_quantity
            OR demand.source_updated_at IS NOT request_line.source_updated_at
          END
        )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM purchase_request_lines request_line
      WHERE request_line.request_id = ${orderAlias}.purchase_request_id
        AND request_line.tenant_id = ${orderAlias}.tenant_id
        AND request_line.active = 1
        AND NOT EXISTS (
          SELECT 1
          FROM purchase_order_lines issue_line
          WHERE issue_line.purchase_order_id = ${orderAlias}.id
            AND issue_line.tenant_id = ${orderAlias}.tenant_id
            AND issue_line.purchase_request_line_id = request_line.id
        )
    )
  `;
}

const PURCHASE_REQUEST_PLANNING_AUDIT_SQL = `(SELECT planning_audit.after_json
  FROM audit_logs planning_audit
  WHERE planning_audit.tenant_id = request.tenant_id
    AND planning_audit.entity_type = 'purchase_request'
    AND planning_audit.entity_id = request.id
    AND planning_audit.action = 'CREATE_PURCHASE_REQUEST_FROM_PLAN'
  ORDER BY planning_audit.created_at, planning_audit.id
  LIMIT 1)`;

async function combinedIssueStatements(db: D1Database, user: UserContext, input: {
  id: string; version: number; idempotencyKey: string; now: string; actor: PurchaseOrderActor;
}) {
  const issueKey = `issue:${await hashPayload([input.id, input.idempotencyKey])}`;
  const issueRequestHash = await hashPayload({ action: 'issue', note: null, expectedVersion: input.version });
  // A failed guard violates the status constraint so D1 rolls back the preceding save as well.
  return [
    db.prepare(`
      UPDATE purchase_orders
      SET status = CASE WHEN ${PURCHASE_ORDER_ACTOR_GUARD_SQL}
          AND ${PURCHASE_ORDER_ISSUE_GUARD_SQL}
          AND ${purchaseOrderIssueBasisGuardSql('purchase_orders')}
          AND ${purchaseOrderSourceGuardSql('purchase_orders')}
        THEN 'issued' ELSE NULL END,
        issued_at = ?, updated_at = ?, version = version + 1, last_action_key = ?
      WHERE id = ? AND tenant_id = ? AND version = ? AND status = 'draft' AND last_action_key = ?
    `).bind(
      ...purchaseOrderActorBindings(input.actor), input.now, input.now, issueKey,
      input.id, user.tenantId, input.version, input.idempotencyKey,
    ),
    auditStatement(db, user, {
      action: 'ISSUE_PURCHASE_ORDER', entityType: 'purchase_order', entityId: input.id,
      beforeJson: stableJson({ status: 'draft', version: input.version }),
      afterJson: stableJson({ requestHash: issueRequestHash, status: 'issued', version: input.version + 1, note: null }),
      idempotencyKey: issueKey, now: input.now,
      onlyWhenSql: `EXISTS (SELECT 1 FROM purchase_orders WHERE id = ? AND tenant_id = ? AND status = 'issued' AND last_action_key = ?)`,
      onlyWhenBindings: [input.id, user.tenantId, issueKey],
    }),
  ];
}

async function loadPurchaseOrderIssueReadiness(
  db: D1Database,
  tenantId: string,
  purchaseOrderId: string,
) {
  return db.prepare(`
    SELECT
      po.id,
      po.status,
      po.version,
      po.purchase_request_id,
      request.source AS request_source,
      po.supplier_id,
      supplier.active AS supplier_active,
      po.delivery_warehouse_id,
      po.expected_delivery_at,
      po.currency,
      CASE WHEN EXISTS (
        SELECT 1 FROM warehouses delivery_warehouse
        WHERE delivery_warehouse.id = po.delivery_warehouse_id
          AND delivery_warehouse.tenant_id = po.tenant_id
      ) THEN 1 ELSE 0 END AS delivery_warehouse_valid,
      (SELECT COUNT(*) FROM purchase_order_lines line
        WHERE line.purchase_order_id = po.id AND line.tenant_id = po.tenant_id) AS line_count,
      (SELECT COUNT(*) FROM purchase_order_lines line
        WHERE line.purchase_order_id = po.id
          AND line.tenant_id = po.tenant_id
          AND (line.unit_cost_minor IS NULL OR line.unit_cost_minor < 0)) AS missing_unit_cost_count,
      (SELECT COUNT(*) FROM purchase_order_lines line
        WHERE line.purchase_order_id = po.id
          AND line.tenant_id = po.tenant_id
          AND (line.currency IS NULL OR line.currency <> po.currency)) AS line_currency_mismatch_count,
      ${PURCHASE_REQUEST_PLANNING_AUDIT_SQL} AS planning_audit_json,
      CASE WHEN (${purchaseOrderSourceGuardSql('po')}) THEN 1 ELSE 0 END AS source_ready
    FROM purchase_orders po
    JOIN purchase_requests request
      ON request.id = po.purchase_request_id AND request.tenant_id = po.tenant_id
    LEFT JOIN suppliers supplier
      ON supplier.id = po.supplier_id
      AND supplier.tenant_id = po.tenant_id
    WHERE po.tenant_id = ? AND po.id = ?
    LIMIT 1
  `).bind(tenantId, purchaseOrderId).first<PurchaseOrderIssueReadinessRow>();
}

function assertPurchaseOrderIssuable(order: Pick<PurchaseOrderIssueReadinessRow,
  'supplier_id' | 'supplier_active' | 'delivery_warehouse_id' | 'delivery_warehouse_valid' | 'expected_delivery_at' | 'currency'
  | 'line_count' | 'missing_unit_cost_count' | 'line_currency_mismatch_count'>) {
  if (!order.supplier_id) {
    throw new HttpError(409, '确认下单前必须选择供应商', 'PURCHASE_ORDER_SUPPLIER_REQUIRED');
  }
  if (order.supplier_active !== 1) {
    throw new HttpError(409, '供应商已停用，不能确认下单', 'PURCHASE_SUPPLIER_INACTIVE');
  }
  if (!order.delivery_warehouse_id || Number(order.delivery_warehouse_valid) !== 1) {
    throw new HttpError(
      409,
      '确认下单前必须选择当前工作区内有效的收货仓库',
      'PURCHASE_ORDER_DELIVERY_WAREHOUSE_REQUIRED',
    );
  }
  if (!order.expected_delivery_at?.trim()) {
    throw new HttpError(
      409,
      '确认下单前必须填写预计交期',
      'PURCHASE_ORDER_EXPECTED_DELIVERY_REQUIRED',
    );
  }
  if (!order.currency || !/^[A-Z]{3}$/u.test(order.currency)) {
    throw new HttpError(
      409,
      '确认下单前必须填写 3 位大写币种代码',
      'PURCHASE_ORDER_CURRENCY_REQUIRED',
    );
  }
  if (Number(order.line_count) === 0) {
    throw new HttpError(409, '采购单至少需要一条采购明细', 'PURCHASE_ORDER_LINES_REQUIRED');
  }
  if (Number(order.missing_unit_cost_count) > 0) {
    throw new HttpError(
      409,
      '确认下单前必须为每条采购明细填写非负采购单价',
      'PURCHASE_ORDER_UNIT_COST_REQUIRED',
    );
  }
  if (Number(order.line_currency_mismatch_count) > 0) {
    throw new HttpError(
      409,
      '采购明细币种必须与采购单币种一致',
      'PURCHASE_ORDER_LINE_CURRENCY_MISMATCH',
    );
  }
}

function assertPurchaseOrderSourceCurrent(order: PurchaseOrderIssueReadinessRow) {
  if (Number(order.source_ready) !== 1) {
    throw new HttpError(
      409,
      '来源采购申请或订单需求已经变化，请取消旧草稿并重新生成采购单',
      'PURCHASE_REQUEST_CHANGED',
    );
  }
}

function readPurchaseOrderPlanningEvidence(order: PurchaseOrderPlanningSource) {
  if (order.request_source === 'manual') return null;
  const parsed = parseJson(order.planning_audit_json);
  const evidence = parsed.planningEvidence;
  if (!isPurchasePlanningEvidence(evidence)) {
    throw new HttpError(
      409,
      '该采购申请缺少可复验的采购计划依据，请从最新采购建议重新生成申请',
      'PURCHASE_PLAN_EVIDENCE_MISSING',
    );
  }
  return evidence;
}

function isPurchasePlanningEvidence(value: unknown): value is PurchasePlanningEvidence {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as {
    schemaVersion?: unknown;
    rows?: unknown;
  };
  return candidate.schemaVersion === 1
    && Array.isArray(candidate.rows)
    && candidate.rows.length > 0
    && candidate.rows.every((row) => {
      if (row === null || typeof row !== 'object' || Array.isArray(row)) return false;
      const evidenceRow = row as Record<string, unknown>;
      return typeof evidenceRow.planRowId === 'string'
        && typeof evidenceRow.skuId === 'string'
        && typeof evidenceRow.recommendationVersion === 'string'
        && Array.isArray(evidenceRow.allocations)
        && evidenceRow.allocations.length > 0
        && evidenceRow.allocations.every((allocation) => {
          if (allocation === null || typeof allocation !== 'object' || Array.isArray(allocation)) return false;
          const evidenceAllocation = allocation as Record<string, unknown>;
          return typeof evidenceAllocation.demandId === 'string'
            && Number.isSafeInteger(evidenceAllocation.quantity)
            && Number(evidenceAllocation.quantity) > 0;
        });
    });
}

async function validateCurrentPurchasePlanningEvidence(
  db: D1Database,
  user: UserContext,
  purchaseRequestId: string,
  evidence: PurchasePlanningEvidence,
  now?: Date,
) {
  const { assertPurchaseRequestPlanningEvidenceCurrent } = await import('./purchase-planning-service');
  await assertPurchaseRequestPlanningEvidenceCurrent(db, user, purchaseRequestId, evidence, { now });
}

async function validateIssuePlanningBasis(
  db: D1Database,
  user: UserContext,
  requestId: string,
  source: PurchaseOrderPlanningSource,
  options: PurchaseOrderWriteOptions,
) {
  const evidence = readPurchaseOrderPlanningEvidence(source);
  if (!evidence) return;
  if (options.validatePlanningEvidence) {
    await options.validatePlanningEvidence(db, user, requestId, evidence);
  } else {
    await validateCurrentPurchasePlanningEvidence(db, user, requestId, evidence, options.planningNow);
  }
}

const PURCHASE_ORDER_SELECT = `
  SELECT
    po.id,
    po.order_no,
    po.purchase_request_id,
    pr.request_no AS purchase_request_no,
    pr.purchaser_member_id,
    po.supplier_id,
    COALESCE(po.supplier_code_snapshot, supplier.code) AS supplier_code,
    COALESCE(po.supplier_name_snapshot, supplier.name) AS supplier_name,
    CASE WHEN po.supplier_name_snapshot IS NOT NULL
      THEN po.supplier_contact_name_snapshot ELSE supplier.contact_name END AS supplier_contact_name,
    CASE WHEN po.supplier_name_snapshot IS NOT NULL
      THEN po.supplier_contact_phone_snapshot ELSE supplier.contact_phone END AS supplier_contact_phone,
    CASE WHEN po.supplier_name_snapshot IS NOT NULL
      THEN po.supplier_contact_email_snapshot ELSE supplier.contact_email END AS supplier_contact_email,
    CASE WHEN po.supplier_name_snapshot IS NOT NULL
      THEN po.supplier_address_snapshot ELSE supplier.address END AS supplier_address,
    po.delivery_warehouse_id,
    CASE WHEN po.delivery_warehouse_name_snapshot IS NOT NULL
      THEN po.delivery_warehouse_code_snapshot ELSE delivery_warehouse.code END AS delivery_warehouse_code,
    COALESCE(po.delivery_warehouse_name_snapshot, delivery_warehouse.name) AS delivery_warehouse_name,
    CASE WHEN po.delivery_warehouse_name_snapshot IS NOT NULL
      THEN po.delivery_contact_name_snapshot ELSE delivery_warehouse.contact_name END AS delivery_contact_name,
    CASE WHEN po.delivery_warehouse_name_snapshot IS NOT NULL
      THEN po.delivery_contact_phone_snapshot ELSE delivery_warehouse.contact_phone END AS delivery_contact_phone,
    CASE WHEN po.delivery_warehouse_name_snapshot IS NOT NULL
      THEN po.delivery_address_snapshot ELSE delivery_warehouse.address END AS delivery_address,
    po.expected_delivery_at,
    po.payment_terms,
    po.trade_terms,
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
  LEFT JOIN suppliers supplier ON supplier.id = po.supplier_id AND supplier.tenant_id = po.tenant_id
  LEFT JOIN warehouses delivery_warehouse
    ON delivery_warehouse.id = po.delivery_warehouse_id
    AND delivery_warehouse.tenant_id = po.tenant_id
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
    line.currency,
    line.product_details_json
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
    contactName: row.contact_name,
    contactPhone: row.contact_phone,
    contactEmail: row.contact_email,
    address: row.address,
    note: row.note,
    active: row.active === 1,
    version: Number(row.version),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapProcurementRecords(
  orders: PurchaseOrderRow[], orderLines: PurchaseOrderLineRow[], receipts: PurchaseReceiptRow[], receiptLines: PurchaseReceiptLineRow[],
) {
  const linesByOrder = new Map<string, ReturnType<typeof mapPurchaseOrderLine>[]>();
  for (const row of orderLines) {
    const lines = linesByOrder.get(row.purchase_order_id) ?? [];
    lines.push(mapPurchaseOrderLine(row));
    linesByOrder.set(row.purchase_order_id, lines);
  }
  const linesByReceipt = new Map<string, ReturnType<typeof mapPurchaseReceiptLine>[]>();
  for (const row of receiptLines) {
    const lines = linesByReceipt.get(row.purchase_receipt_id) ?? [];
    lines.push(mapPurchaseReceiptLine(row));
    linesByReceipt.set(row.purchase_receipt_id, lines);
  }
  return {
    purchaseOrders: orders.map((row) => mapPurchaseOrder(row, linesByOrder.get(row.id) ?? [])),
    purchaseReceipts: receipts.map((row) => mapPurchaseReceipt(row, linesByReceipt.get(row.id) ?? [])),
  };
}

function mapWarehouse(row: WarehouseRow) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    contactName: row.contact_name,
    contactPhone: row.contact_phone,
    address: row.address,
    createdAt: row.created_at,
  };
}

function mapPurchaseOrder(row: PurchaseOrderRow, lines: ReturnType<typeof mapPurchaseOrderLine>[]) {
  return {
    id: row.id,
    orderNo: row.order_no,
    purchaseRequestId: row.purchase_request_id,
    purchaseRequestNo: row.purchase_request_no,
    purchaserMemberId: row.purchaser_member_id,
    supplier: row.supplier_id ? {
      id: row.supplier_id,
      code: row.supplier_code,
      name: row.supplier_name,
      contactName: row.supplier_contact_name,
      contactPhone: row.supplier_contact_phone,
      contactEmail: row.supplier_contact_email,
      address: row.supplier_address,
    } : null,
    deliveryWarehouse: row.delivery_warehouse_id ? {
      id: row.delivery_warehouse_id,
      code: row.delivery_warehouse_code,
      name: row.delivery_warehouse_name,
      contactName: row.delivery_contact_name,
      contactPhone: row.delivery_contact_phone,
      address: row.delivery_address,
    } : null,
    expectedDeliveryAt: row.expected_delivery_at,
    paymentTerms: row.payment_terms,
    tradeTerms: row.trade_terms,
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
  const details = parsePurchaseProductDetails(row.product_details_json);
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
    ...(details ? { productDetails: resolvePurchaseProductDetails(details) } : {}),
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
      sku.active AS sku_active,
      line.requested_quantity,
      line.active,
      ${ORDER_LINE_PRODUCT_DETAILS_SQL} AS product_details_json,
      line.purchase_demand_id,
      line.source_required_quantity,
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

function assertRequestLinesCurrent(lines: RequestLineRow[], source: PurchaseRequestSource) {
  if (source === 'manual') {
    if (lines.some((line) => line.active !== 1 || line.sku_active !== 1
      || line.purchase_demand_id !== null || line.source_required_quantity !== null || line.source_updated_at !== null)) {
      throw new HttpError(409, '手工采购申请含无效 SKU 或采购明细，请重新建单', 'PURCHASE_SKU_UNAVAILABLE');
    }
    return;
  }
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

async function loadPurchaseReceiptOrderReadiness(
  db: D1Database,
  tenantId: string,
  purchaseOrderId: string,
) {
  return db.prepare(`
    SELECT
      purchase_order.id,
      purchase_order.status,
      purchase_order.version,
      purchase_order.delivery_warehouse_id,
      CASE WHEN EXISTS (
        SELECT 1
        FROM warehouses delivery_warehouse
        WHERE delivery_warehouse.id = purchase_order.delivery_warehouse_id
          AND delivery_warehouse.tenant_id = purchase_order.tenant_id
      ) THEN 1 ELSE 0 END AS delivery_warehouse_valid
    FROM purchase_orders purchase_order
    WHERE purchase_order.tenant_id = ? AND purchase_order.id = ?
    LIMIT 1
  `).bind(tenantId, purchaseOrderId).first<PurchaseReceiptOrderReadinessRow>();
}

function assertPurchaseReceiptWarehouse(
  purchaseOrder: PurchaseReceiptOrderReadinessRow,
  warehouseId: string,
) {
  if (!purchaseOrder.delivery_warehouse_id || Number(purchaseOrder.delivery_warehouse_valid) !== 1) {
    throw new HttpError(
      409,
      '采购单未配置当前工作区内有效的收货仓库，不能自动入库',
      'PURCHASE_RECEIPT_DELIVERY_WAREHOUSE_REQUIRED',
    );
  }
  if (purchaseOrder.delivery_warehouse_id !== warehouseId) {
    throw new HttpError(
      409,
      '收货仓库必须与采购单指定的收货仓库一致',
      'PURCHASE_RECEIPT_WAREHOUSE_MISMATCH',
    );
  }
}

async function authorizePurchaseOrderCreation(
  db: D1Database,
  user: UserContext,
  purchaseRequestId: string,
  developmentOpenAccess = false,
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
  return authorizePurchaseOrderMember(db, user, request.purchaser_member_id, developmentOpenAccess, true);
}

const PURCHASE_ORDER_ACTOR_GUARD_SQL = purchaseOrderActorGuardSql('purchase_orders.tenant_id', 'purchase_orders.purchase_request_id');

function purchaseOrderActorGuardSql(tenant: string, request: string) {
  return `(? = 1 OR EXISTS (
    SELECT 1 FROM purchase_requests request
    JOIN members actor ON actor.tenant_id = request.tenant_id AND actor.id = ?
    WHERE (
        (actor.id = request.purchaser_member_id AND actor.role IN ('operator', 'admin'))
        OR (? = 1 AND actor.role = 'admin')
      )
      AND request.tenant_id = ${tenant} AND request.id = ${request}
  ))`;
}

function purchaseOrderActorBindings(actor: PurchaseOrderActor) {
  return [Number(actor.developmentOpenAccess), actor.memberId, Number(actor.canActAsAdministrator)];
}

async function authorizePurchaseOrderAction(
  db: D1Database,
  user: UserContext,
  purchaseOrderId: string,
  developmentOpenAccess: boolean,
  allowAdministrator: boolean,
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
  return authorizePurchaseOrderMember(db, user, order.purchaser_member_id, developmentOpenAccess, allowAdministrator);
}

async function authorizePurchaseOrderMember(
  db: D1Database,
  user: UserContext,
  purchaserMemberId: string,
  developmentOpenAccess: boolean,
  allowAdministrator: boolean,
): Promise<PurchaseOrderActor> {
  const actor = await resolveActorMember(db, user);
  const canActAsAdministrator = allowAdministrator && user.role === 'admin' && actor.role === 'admin';
  const isPurchaser = purchaserMemberId === actor.id && (actor.role === 'operator' || actor.role === 'admin');
  if (!developmentOpenAccess && !isPurchaser && !canActAsAdministrator) {
    throw new HttpError(
      403,
      allowAdministrator ? '只有采购负责人或本工作区管理员可以继续下单' : '只有来源申请指定的采购负责人可以操作该采购单',
      'PURCHASE_ORDER_PURCHASER_REQUIRED',
    );
  }
  return { memberId: actor.id, developmentOpenAccess, canActAsAdministrator };
}

async function resolveActorMemberId(db: D1Database, user: UserContext) {
  return (await resolveActorMember(db, user)).id;
}

async function resolveActorMember(db: D1Database, user: UserContext) {
  const member = await db.prepare(`
    SELECT id, role FROM members WHERE tenant_id = ? AND auth_user_id = ? LIMIT 1
  `).bind(user.tenantId, user.id).first<{ id: string; role: UserContext['role'] }>();
  if (!member) throw new HttpError(409, '当前操作人尚未加入采购工作区', 'PURCHASE_MEMBER_NOT_FOUND');
  return member;
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

function normalizePurchaseReceiptTime(value: string | undefined, now: Date) {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new HttpError(400, '实际到货时间格式无效', 'PURCHASE_RECEIPT_TIME_INVALID');
  }
  if (parsed > now.getTime() + PURCHASE_RECEIPT_FUTURE_TOLERANCE_MS) {
    throw new HttpError(
      400,
      '实际到货时间不能晚于当前时间；请检查设备时间后重试',
      'PURCHASE_RECEIPT_TIME_IN_FUTURE',
    );
  }
  return new Date(parsed).toISOString();
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
  if (message.includes('NOT NULL constraint failed: purchase_orders.status')) {
    return new HttpError(409, '采购权限、供应商、收货仓或采购依据刚发生变化，请刷新后再操作', 'PURCHASE_ORDER_ISSUE_CONFLICT');
  }
  if (message.includes('INVALID_PURCHASE_SUPPLIER')) {
    return new HttpError(409, '供应商不存在或已停用', 'PURCHASE_SUPPLIER_NOT_FOUND');
  }
  if (message.includes('INVALID_PURCHASE_DELIVERY_WAREHOUSE')) {
    return new HttpError(409, '收货仓库不存在或不在当前数据范围内', 'PURCHASE_DELIVERY_WAREHOUSE_NOT_FOUND');
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
  if (message.includes('PURCHASE_RECEIPT_QUALITY_LIMIT')) {
    return new HttpError(409, '本次入库数量超过质检放行数量，请先完成质检', 'PURCHASE_RECEIPT_QUALITY_LIMIT');
  }
  if (message.includes('INVALID_PURCHASE_RECEIPT_LINE')
    || message.includes('ck_purchase_order_lines_received_range')) {
    return new HttpError(409, '收货数量超过采购单未到货数量，请刷新后重试', 'PURCHASE_RECEIPT_EXCEEDS_REMAINING');
  }
  return error;
}
