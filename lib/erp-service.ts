import { z } from 'zod';
import { canReadChannelOrders, readChannelOrderPreview } from './channel-orders';
import type { CreateOrderInput } from './contracts';
import { ACTION_TARGET, ORDER_STATUSES, canManageWarehouseFulfillment, canTransition, type OrderAction, type OrderStatus } from './domain';
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
  sourceOrder?: { storeKey: string; orderNo: string; observedAt: string };
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
  source_store_key: string | null;
  source_order_no: string | null;
  source_observed_at: string | null;
};

const ORDER_SOURCE = `
  FROM orders o
  JOIN skus s ON s.id = o.sku_id AND s.tenant_id = o.tenant_id
  JOIN warehouses w ON w.id = o.warehouse_id AND w.tenant_id = o.tenant_id
  LEFT JOIN nine_store_order_handoffs h ON h.order_id = o.id AND h.tenant_id = o.tenant_id
`;
const ORDER_SELECT = `
  SELECT o.id, o.order_no, o.channel, o.destination, o.customer_name, o.currency,
         o.amount_minor, o.status, o.sku_id, s.code AS sku_code, s.name AS sku_name,
         o.warehouse_id, w.name AS warehouse_name, o.quantity, o.version, o.created_at, o.updated_at,
         h.store_key AS source_store_key, h.source_order_no, h.source_observed_at
  ${ORDER_SOURCE}
`;

export const orderListQuerySchema = z.strictObject({
  status: z.enum(['all', ...ORDER_STATUSES]).default('all'),
  q: z.string().trim().max(160).default(''),
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
});

export async function listOrders(db: D1Database, user: UserContext, filter: z.infer<typeof orderListQuerySchema>) {
  requirePermission(user, 'orders:read');
  const pageSize = 30;
  const clauses = ['o.tenant_id = ?'];
  const params = [user.tenantId];
  if (filter.status !== 'all') {
    clauses.push('o.status = ?');
    params.push(filter.status);
  }
  if (filter.q) {
    const fields = ['o.order_no', 'o.channel', 'o.destination', 's.code', 's.name', 'w.code', 'w.name', 'h.source_order_no', 'h.store_key'];
    clauses.push(`(${fields.map((field) => `instr(lower(${field}), lower(?)) > 0`).join(' OR ')})`);
    params.push(...fields.map(() => filter.q));
  }
  const scope = `WHERE ${clauses.join(' AND ')}`;
  const [page, count] = await db.batch<OrderRow | { total: number }>([
    db.prepare(`${ORDER_SELECT} ${scope} ORDER BY o.created_at DESC, o.id DESC LIMIT ? OFFSET ?`)
      .bind(...params, pageSize, (filter.page - 1) * pageSize),
    db.prepare(`SELECT COUNT(*) AS total ${ORDER_SOURCE} ${scope}`).bind(...params),
  ]);
  return { orders: (page.results as OrderRow[]).map(mapOrder), total: Number((count.results[0] as { total: number }).total), pageSize };
}

export async function getErpPayload(db: D1Database, user: UserContext, options = { includePlatformPreview: true }) {
  const channelScope = user.channelScope ?? null;
  const allOrders = !channelScope && user.permissions.includes('orders:read');
  const channelOrders = canReadChannelOrders(user);
  const [ordersResult, inventoryResult, auditResult, platformOrders, orderTotals, platformTotals] = await Promise.all([
    allOrders
      ? db.prepare(`${ORDER_SELECT} WHERE o.tenant_id = ? ORDER BY o.created_at DESC LIMIT 100`).bind(user.tenantId).all<OrderRow>()
      : { results: [] },
    (allOrders || (!channelScope && user.permissions.includes('warehouse:read'))) ? db.prepare(`
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
    }>() : { results: [] },
    !channelScope && user.permissions.includes('audit:read')
      ? db.prepare(`
          SELECT action, entity_id, actor_email, before_json, after_json, created_at
          FROM audit_logs WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 8
        `).bind(user.tenantId).all<{
          action: string; entity_id: string; actor_email: string; before_json: string | null;
          after_json: string | null; created_at: string;
        }>()
      : Promise.resolve({ results: [] }),
    channelOrders && options.includePlatformPreview ? readChannelOrderPreview(db, user) : [],
    allOrders ? db.prepare(`
      SELECT COUNT(*) AS totalOrders,
             COUNT(CASE WHEN status = 'pending_review' THEN 1 END) AS pendingReview,
             COUNT(CASE WHEN status = 'reserved' THEN 1 END) AS readyToShip,
             COUNT(CASE WHEN status = 'shipped' THEN 1 END) AS shipped
      FROM orders WHERE tenant_id = ?
    `).bind(user.tenantId).first<{ totalOrders: number; pendingReview: number; readyToShip: number; shipped: number }>() : null,
    channelOrders ? db.prepare(`
      SELECT COUNT(*) AS totalPlatformOrders,
             COUNT(CASE WHEN po.financial_status = 'PENDING' THEN 1 END) AS platformPending,
             COUNT(NULLIF(po.source_cancelled_at, '')) AS platformCancelled,
             COUNT(CASE WHEN EXISTS (SELECT 1 FROM platform_refunds r
               WHERE r.tenant_id = po.tenant_id AND r.order_id = po.id AND r.is_current = 1) THEN 1 END) AS platformRefunded
      FROM platform_orders po
      JOIN platform_stores ps ON ps.id = po.platform_store_id AND ps.tenant_id = po.tenant_id AND ps.platform = po.platform
      WHERE po.tenant_id = ? AND (? IS NULL OR po.platform = ?)
    `).bind(user.tenantId, channelScope, channelScope)
      .first<{ totalPlatformOrders: number; platformPending: number; platformCancelled: number; platformRefunded: number }>() : null,
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
  return {
    ok: true,
    user: {
      displayName: user.displayName,
      email: user.email,
      role: user.role,
      permissions: user.permissions,
      tenantName: user.tenantName,
      accessProfile: user.accessProfile ?? null,
      channelScope,
      authProvider: user.authProvider ?? 'existing' as const,
    },
    orders,
    platformOrders,
    inventory,
    audit: auditResult.results,
    summary: {
      totalOrders: orderTotals?.totalOrders ?? 0,
      totalPlatformOrders: platformTotals?.totalPlatformOrders ?? 0,
      platformPending: platformTotals?.platformPending ?? 0,
      platformCancelled: platformTotals?.platformCancelled ?? 0,
      platformRefunded: platformTotals?.platformRefunded ?? 0,
      pendingReview: orderTotals?.pendingReview ?? 0,
      readyToShip: orderTotals?.readyToShip ?? 0,
      shipped: orderTotals?.shipped ?? 0,
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

  const { id, statement } = prepareOrderInsert(db, user, input, idempotencyKey, requestHash, new Date().toISOString());
  await statement.run();
  return { order: await getOrder(db, user.tenantId, id), replayed: false };
}

type OrderInsertInput = Omit<CreateOrderInput, 'channel'> & { channel: CreateOrderInput['channel'] | 'Amazon' | 'Wayfair' };

export function prepareOrderInsert(
  db: D1Database,
  user: UserContext,
  input: OrderInsertInput,
  idempotencyKey: string,
  requestHash: string,
  now: string,
  guard?: { sql: string; values: (string | number | null)[] },
) {
  const id = crypto.randomUUID();
  const requestId = crypto.randomUUID();
  const orderNo = createOrderNumber();
  const values = "?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_review', ?, ?, ?, 1, ?, ?, ?, ?, ?, ?";
  const statement = db.prepare(`
    INSERT INTO orders (
      id, tenant_id, order_no, idempotency_key, request_hash, channel, destination, customer_name,
      currency, amount_minor, status, sku_id, warehouse_id, quantity, version, created_by, updated_by,
      last_action_key, request_id, created_at, updated_at
    ) ${guard ? `SELECT ${values} WHERE ${guard.sql}` : `VALUES (${values})`}
  `).bind(
    id, user.tenantId, orderNo, idempotencyKey, requestHash, input.channel, input.destination,
    input.customerName, input.currency, input.amountMinor, input.skuId, input.warehouseId,
    input.quantity, user.id, user.id, idempotencyKey, requestId, now, now,
    ...(guard?.values ?? []),
  );
  return { id, statement };
}

export async function executeOrderAction(
  db: D1Database,
  user: UserContext,
  orderId: string,
  action: OrderAction,
  idempotencyKey: string,
) {
  validateIdempotencyKey(idempotencyKey);
  requirePermission(user, ACTION_TARGET[action].permission);
  return transitionOrder(db, user, orderId, action, idempotencyKey);
}

export async function confirmWarehouseOrderShipment(db: D1Database, user: UserContext, orderId: string, idempotencyKey: string) {
  validateIdempotencyKey(idempotencyKey);
  if (!canManageWarehouseFulfillment(user.permissions, user.channelScope)) {
    throw new HttpError(403, '当前岗位无权确认仓库发货', 'PERMISSION_DENIED');
  }
  const { replayed } = await transitionOrder(db, user, orderId, 'ship', idempotencyKey, true);
  return { replayed };
}

async function transitionOrder(
  db: D1Database,
  user: UserContext,
  orderId: string,
  action: OrderAction,
  idempotencyKey: string,
  requireWarehousePack = false,
) {
  const transition = ACTION_TARGET[action];

  const expectedAuditAction = action === 'approve' ? 'APPROVE_ORDER' : action === 'ship' ? 'SHIP_ORDER' : 'CANCEL_ORDER';
  const receiptQuery = db.prepare(
    'SELECT entity_id, action FROM audit_logs WHERE tenant_id = ? AND idempotency_key = ? LIMIT 1',
  ).bind(user.tenantId, idempotencyKey);
  async function hasMatchingReceipt() {
    const receipt = await receiptQuery.first<{ entity_id: string; action: string }>();
    if (receipt && (receipt.entity_id !== orderId || receipt.action !== expectedAuditAction)) {
      throw new HttpError(409, '该幂等键已用于另一项业务操作', 'IDEMPOTENCY_CONFLICT');
    }
    return receipt !== null;
  }
  const matchedReceipt = await hasMatchingReceipt();
  const current = await getOrder(db, user.tenantId, orderId);
  if (requireWarehousePack && (current.status === 'reserved' || current.status === 'shipped') && !await db.prepare(`
    SELECT 1 FROM warehouse_outbound_events WHERE tenant_id = ? AND order_id = ? AND version = 3
  `).bind(user.tenantId, orderId).first()) {
    throw new HttpError(409, '请完成拣货、复核和打包后再确认发货', 'WAREHOUSE_PACK_REQUIRED');
  }
  if (matchedReceipt || current.status === transition.to) return { order: current, replayed: true };
  if (!canTransition(current.status, action)) {
    throw new HttpError(409, '当前订单状态不允许执行该操作', 'INVALID_ORDER_TRANSITION');
  }

  const now = new Date().toISOString();
  const result = await db.prepare(`
    UPDATE orders
    SET status = ?, version = version + 1, updated_by = ?, last_action_key = ?, request_id = ?, updated_at = ?
    WHERE id = ? AND tenant_id = ? AND status = ? AND version = ?
  `).bind(
    transition.to, user.id, idempotencyKey, crypto.randomUUID(), now,
    orderId, user.tenantId, current.status, current.version,
  ).run().catch((error: unknown) => {
    if (error instanceof Error && error.message.includes('NINE_STORE_HANDOFF_SOURCE_CHANGED')) {
      throw new HttpError(409, '平台订单尚未确认待发货或已有退款，请刷新飞书同步后复核', 'NINE_STORE_HANDOFF_SOURCE_CHANGED');
    }
    if (error instanceof Error && error.message.includes('NATIVE_CHANNEL_HANDOFF_SOURCE_CHANGED')) {
      throw new HttpError(409, '官方渠道订单已变化、数据超时或出现退款，请重新同步该单并核对', 'NATIVE_CHANNEL_HANDOFF_SOURCE_CHANGED');
    }
    throw error;
  });

  const replayed = result.meta.changes === 0;
  if (replayed) await hasMatchingReceipt();
  const updated = await getOrder(db, user.tenantId, orderId);
  if (updated.status !== transition.to) {
    throw new HttpError(409, '订单已被其他操作更新，请刷新后重试', 'CONCURRENT_UPDATE');
  }
  return { order: updated, replayed };
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
    ...(row.source_store_key && row.source_order_no && row.source_observed_at ? { sourceOrder: {
      storeKey: row.source_store_key, orderNo: row.source_order_no, observedAt: row.source_observed_at,
    } } : {}),
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
