import type { CreateOrderInput } from './contracts';
import { ACTION_TARGET, canTransition, type OrderAction, type OrderStatus } from './domain';
import { HttpError, requirePermission, type UserContext } from './db';

export type OrderRecord = {
  id: string;
  orderNo: string;
  channel: string;
  destination: string;
  customerName: string;
  currency: string;
  amountMinor: number;
  status: OrderStatus;
  skuId: string;
  skuCode: string;
  skuName: string;
  warehouseId: string;
  warehouseName: string;
  quantity: number;
  version: number;
  createdAt: string;
  updatedAt: string;
};

type OrderRow = {
  id: string;
  order_no: string;
  channel: string;
  destination: string;
  customer_name: string;
  currency: string;
  amount_minor: number;
  status: OrderStatus;
  sku_id: string;
  sku_code: string;
  sku_name: string;
  warehouse_id: string;
  warehouse_name: string;
  quantity: number;
  version: number;
  created_at: string;
  updated_at: string;
};

const ORDER_SELECT = `
  SELECT o.id, o.order_no, o.channel, o.destination, o.customer_name, o.currency,
         o.amount_minor, o.status, o.sku_id, s.code AS sku_code, s.name AS sku_name,
         o.warehouse_id, w.name AS warehouse_name, o.quantity, o.version, o.created_at, o.updated_at
  FROM orders o
  JOIN skus s ON s.id = o.sku_id AND s.tenant_id = o.tenant_id
  JOIN warehouses w ON w.id = o.warehouse_id AND w.tenant_id = o.tenant_id
`;

export async function getErpPayload(db: D1Database, user: UserContext) {
  requirePermission(user, 'orders:read');
  const [ordersResult, inventoryResult, auditResult, platformOrdersResult] = await Promise.all([
    db.prepare(`${ORDER_SELECT} WHERE o.tenant_id = ? ORDER BY o.created_at DESC LIMIT 100`).bind(user.tenantId).all<OrderRow>(),
    db.prepare(`
      SELECT b.id, b.sku_id, s.code AS sku_code, s.name AS sku_name,
             b.warehouse_id, w.name AS warehouse_name, b.on_hand_qty, b.reserved_qty,
             b.on_hand_qty - b.reserved_qty AS available_qty, b.version, b.updated_at
      FROM inventory_balances b
      JOIN skus s ON s.id = b.sku_id AND s.tenant_id = b.tenant_id
      JOIN warehouses w ON w.id = b.warehouse_id AND w.tenant_id = b.tenant_id
      WHERE b.tenant_id = ?
      ORDER BY available_qty ASC, s.code ASC
    `).bind(user.tenantId).all<{
      id: string; sku_id: string; sku_code: string; sku_name: string; warehouse_id: string;
      warehouse_name: string; on_hand_qty: number; reserved_qty: number; available_qty: number;
      version: number; updated_at: string;
    }>(),
    user.permissions.includes('audit:read')
      ? db.prepare(`
          SELECT action, entity_id, actor_email, before_json, after_json, created_at
          FROM audit_logs WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 8
        `).bind(user.tenantId).all<{
          action: string; entity_id: string; actor_email: string; before_json: string | null;
          after_json: string | null; created_at: string;
        }>()
      : Promise.resolve({ results: [] }),
    db.prepare(`
      SELECT po.id, po.platform, po.source_order_id, po.source_order_name,
             po.source_created_at, po.source_updated_at, po.source_cancelled_at,
             po.test, po.financial_status, po.fulfillment_status, po.currency,
             po.current_total_amount, po.current_total_minor, po.refunded_amount,
             po.refunded_minor, po.business_ownership, po.api_version,
             ps.connector_key, ps.display_name AS store_name,
             (SELECT COUNT(*) FROM platform_order_lines l WHERE l.order_id = po.id AND l.is_current = 1) AS line_count,
             (SELECT COUNT(*) FROM platform_refunds r WHERE r.order_id = po.id AND r.is_current = 1) AS refund_count,
             (SELECT COUNT(*) FROM platform_fulfillments f WHERE f.order_id = po.id AND f.is_current = 1) AS fulfillment_count
      FROM platform_orders po
      JOIN platform_stores ps ON ps.id = po.platform_store_id AND ps.tenant_id = po.tenant_id
      WHERE po.tenant_id = ?
      ORDER BY po.source_updated_at DESC
      LIMIT 100
    `).bind(user.tenantId).all<{
      id: string; platform: string; source_order_id: string; source_order_name: string | null;
      source_created_at: string; source_updated_at: string; source_cancelled_at: string | null;
      test: number | null; financial_status: string | null; fulfillment_status: string | null;
      currency: string | null; current_total_amount: string | null; current_total_minor: number | null;
      refunded_amount: string | null; refunded_minor: number | null; business_ownership: string | null;
      api_version: string; connector_key: string; store_name: string; line_count: number;
      refund_count: number; fulfillment_count: number;
    }>(),
  ]);

  const orders = ordersResult.results.map(mapOrder);
  const inventory = inventoryResult.results.map((row) => ({
    id: row.id,
    skuId: row.sku_id,
    skuCode: row.sku_code,
    skuName: row.sku_name,
    warehouseId: row.warehouse_id,
    warehouseName: row.warehouse_name,
    onHandQty: row.on_hand_qty,
    reservedQty: row.reserved_qty,
    availableQty: row.available_qty,
    version: row.version,
    updatedAt: row.updated_at,
  }));
  const platformOrders = platformOrdersResult.results.map((row) => ({
    id: row.id,
    platform: row.platform,
    storeKey: row.connector_key,
    storeName: row.store_name,
    sourceOrderId: row.source_order_id,
    sourceOrderName: row.source_order_name,
    sourceCreatedAt: row.source_created_at,
    sourceUpdatedAt: row.source_updated_at,
    sourceCancelledAt: row.source_cancelled_at,
    test: row.test === null ? null : Boolean(row.test),
    financialStatus: row.financial_status,
    fulfillmentStatus: row.fulfillment_status,
    currency: row.currency,
    currentTotalAmount: row.current_total_amount,
    currentTotalMinor: row.current_total_minor,
    refundedAmount: row.refunded_amount,
    refundedMinor: row.refunded_minor,
    businessOwnership: row.business_ownership,
    apiVersion: row.api_version,
    lineCount: Number(row.line_count),
    refundCount: Number(row.refund_count),
    fulfillmentCount: Number(row.fulfillment_count),
  }));

  return {
    ok: true,
    user: {
      displayName: user.displayName,
      email: user.email,
      role: user.role,
      permissions: user.permissions,
      tenantName: user.tenantName,
    },
    orders,
    platformOrders,
    inventory,
    audit: auditResult.results,
    summary: {
      totalOrders: orders.length,
      totalPlatformOrders: platformOrders.length,
      platformPending: platformOrders.filter((order) => order.financialStatus === 'PENDING').length,
      platformCancelled: platformOrders.filter((order) => Boolean(order.sourceCancelledAt)).length,
      platformRefunded: platformOrders.filter((order) => order.refundCount > 0).length,
      pendingReview: orders.filter((order) => order.status === 'pending_review').length,
      readyToShip: orders.filter((order) => order.status === 'reserved').length,
      shipped: orders.filter((order) => order.status === 'shipped').length,
      lowStock: inventory.filter((item) => item.availableQty <= 10).length,
      totalAvailable: inventory.reduce((sum, item) => sum + item.availableQty, 0),
    },
  };
}

export async function createOrder(
  db: D1Database,
  user: UserContext,
  input: CreateOrderInput,
  idempotencyKey: string,
) {
  requirePermission(user, 'orders:create');
  validateIdempotencyKey(idempotencyKey);
  const requestHash = await hashPayload(input);
  const existing = await db.prepare(
    'SELECT id, request_hash FROM orders WHERE tenant_id = ? AND idempotency_key = ? LIMIT 1',
  ).bind(user.tenantId, idempotencyKey).first<{ id: string; request_hash: string }>();

  if (existing) {
    if (existing.request_hash !== requestHash) {
      throw new HttpError(409, '同一幂等键不能用于不同订单参数', 'IDEMPOTENCY_CONFLICT');
    }
    return { order: await getOrder(db, user.tenantId, existing.id), replayed: true };
  }

  const inventory = await db.prepare(`
    SELECT b.id FROM inventory_balances b
    JOIN skus s ON s.id = b.sku_id AND s.tenant_id = b.tenant_id AND s.active = 1
    WHERE b.tenant_id = ? AND b.sku_id = ? AND b.warehouse_id = ? LIMIT 1
  `).bind(user.tenantId, input.skuId, input.warehouseId).first<{ id: string }>();
  if (!inventory) throw new HttpError(404, '所选 SKU 或仓库库存不存在', 'INVENTORY_NOT_FOUND');

  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const requestId = crypto.randomUUID();
  const orderNo = createOrderNumber();
  await db.prepare(`
    INSERT INTO orders (
      id, tenant_id, order_no, idempotency_key, request_hash, channel, destination, customer_name,
      currency, amount_minor, status, sku_id, warehouse_id, quantity, version, created_by, updated_by,
      last_action_key, request_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_review', ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
  `).bind(
    id, user.tenantId, orderNo, idempotencyKey, requestHash, input.channel, input.destination,
    input.customerName, input.currency, input.amountMinor, input.skuId, input.warehouseId,
    input.quantity, user.id, user.id, idempotencyKey, requestId, now, now,
  ).run();

  return { order: await getOrder(db, user.tenantId, id), replayed: false };
}

export async function executeOrderAction(
  db: D1Database,
  user: UserContext,
  orderId: string,
  action: OrderAction,
  idempotencyKey: string,
) {
  validateIdempotencyKey(idempotencyKey);
  const transition = ACTION_TARGET[action];
  requirePermission(user, transition.permission);

  const expectedAuditAction = action === 'approve' ? 'APPROVE_ORDER' : action === 'ship' ? 'SHIP_ORDER' : 'CANCEL_ORDER';
  const receipt = await db.prepare(
    'SELECT entity_id, action FROM audit_logs WHERE tenant_id = ? AND idempotency_key = ? LIMIT 1',
  ).bind(user.tenantId, idempotencyKey).first<{ entity_id: string; action: string }>();
  if (receipt) {
    if (receipt.entity_id !== orderId || receipt.action !== expectedAuditAction) {
      throw new HttpError(409, '该幂等键已用于另一项业务操作', 'IDEMPOTENCY_CONFLICT');
    }
    return { order: await getOrder(db, user.tenantId, orderId), replayed: true };
  }

  const current = await getOrder(db, user.tenantId, orderId);
  if (current.status === transition.to) return { order: current, replayed: true };
  if (!canTransition(current.status, action)) {
    throw new HttpError(409, '当前订单状态不允许执行该操作', 'INVALID_ORDER_TRANSITION');
  }

  const now = new Date().toISOString();
  await db.prepare(`
    UPDATE orders
    SET status = ?, version = version + 1, updated_by = ?, last_action_key = ?, request_id = ?, updated_at = ?
    WHERE id = ? AND tenant_id = ? AND status = ? AND version = ?
  `).bind(
    transition.to, user.id, idempotencyKey, crypto.randomUUID(), now,
    orderId, user.tenantId, current.status, current.version,
  ).run();

  const updated = await getOrder(db, user.tenantId, orderId);
  if (updated.status !== transition.to) {
    throw new HttpError(409, '订单已被其他操作更新，请刷新后重试', 'CONCURRENT_UPDATE');
  }
  return { order: updated, replayed: false };
}

export async function getOrder(db: D1Database, tenantId: string, id: string) {
  const row = await db.prepare(`${ORDER_SELECT} WHERE o.tenant_id = ? AND o.id = ? LIMIT 1`)
    .bind(tenantId, id)
    .first<OrderRow>();
  if (!row) throw new HttpError(404, '订单不存在或不在当前数据范围内', 'ORDER_NOT_FOUND');
  return mapOrder(row);
}

function mapOrder(row: OrderRow): OrderRecord {
  return {
    id: row.id,
    orderNo: row.order_no,
    channel: row.channel,
    destination: row.destination,
    customerName: row.customer_name,
    currency: row.currency,
    amountMinor: row.amount_minor,
    status: row.status,
    skuId: row.sku_id,
    skuCode: row.sku_code,
    skuName: row.sku_name,
    warehouseId: row.warehouse_id,
    warehouseName: row.warehouse_name,
    quantity: row.quantity,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function validateIdempotencyKey(key: string) {
  if (!key || key.length < 8 || key.length > 128) {
    throw new HttpError(400, '缺少有效的 Idempotency-Key', 'INVALID_IDEMPOTENCY_KEY');
  }
}

async function hashPayload(input: CreateOrderInput) {
  const stable = JSON.stringify([
    input.channel, input.destination, input.customerName, input.currency,
    input.amountMinor, input.skuId, input.warehouseId, input.quantity,
  ]);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(stable));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function createOrderNumber() {
  const now = new Date();
  const date = now.toISOString().slice(2, 10).replaceAll('-', '');
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 6).toUpperCase();
  return `YC${date}-${suffix}`;
}
