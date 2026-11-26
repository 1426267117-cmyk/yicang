import { z } from 'zod';
import { HttpError, requirePermission, type UserContext } from './db';
import { canReadInventoryMovements, canReadWarehouseFulfillment } from './domain';

const quantity = z.int().min(0).max(2_147_483_647);
const identifier = z.string().trim().min(1).max(160);

export const warehouseStockCountSchema = z.strictObject({
  warehouseId: identifier,
  skuId: identifier,
  expectedVersion: z.int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1),
  countedQty: quantity,
  reason: z.string().trim().min(1).max(500),
});
type StockCountInput = z.infer<typeof warehouseStockCountSchema>;
type OpeningStockGuard = { snapshotVersion: string; skuCode: string; warehouseCode: string };

const movementTypes = ['reserve', 'release', 'ship', 'receipt', 'receipt_correction', 'opening', 'count'] as const;
export type WarehouseMovementType = (typeof movementTypes)[number];

export const warehouseQuerySchema = z.strictObject({
  kind: z.enum(['outbound', 'counts', 'movements']),
  warehouse: identifier.optional(),
  q: z.string().trim().max(160).optional(),
  stage: z.enum(['0', '1', '2', '3']).optional(),
  sku: identifier.optional(),
  movement: z.enum(movementTypes).optional(),
  from: z.iso.date().optional(),
  through: z.iso.date().optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
}).superRefine((query, context) => {
  if (query.from && query.through && query.from > query.through) {
    context.addIssue({ code: 'custom', path: ['through'], message: '结束日期不能早于开始日期' });
  }
  if (query.kind !== 'movements' && (query.sku || query.movement || query.from || query.through)) {
    context.addIssue({ code: 'custom', path: ['kind'], message: '库存流水筛选只适用于流水查询' });
  }
});
type WarehouseQuery = z.infer<typeof warehouseQuerySchema>;
export type WarehouseOutboundVersion = 0 | 1 | 2 | 3;

export type WarehouseOutboundOrder = {
  id: string;
  orderNo: string;
  skuCode: string;
  skuName: string;
  warehouseName: string;
  quantity: number;
  reservedAt: string;
  outboundVersion: WarehouseOutboundVersion;
  packedPackageCount: number | null;
};

export type WarehouseStockCount = {
  id: string;
  skuCode: string;
  skuName: string;
  warehouseName: string;
  beforeOnHandQty: number;
  reservedQty: number;
  countedQty: number;
  reason: string;
  createdAt: string;
};

export type WarehouseMovement = {
  id: string; type: WarehouseMovementType;
  skuCode: string; skuName: string; warehouseName: string;
  onHandDelta: number; reservedDelta: number;
  reference: string; purchaseOrderNo: string | null; originalReceiptNo: string | null;
  reason: string | null; beforeOnHandQty: number | null; afterOnHandQty: number | null;
  actor: string | null; createdAt: string;
};

export type WarehousePage =
  | { ok: true; kind: 'outbound'; rows: WarehouseOutboundOrder[]; hasNext: boolean }
  | { ok: true; kind: 'counts'; rows: WarehouseStockCount[]; hasNext: boolean }
  | { ok: true; kind: 'movements'; rows: WarehouseMovement[]; hasNext: boolean };

const pageSize = 25;

export async function getWarehousePage(db: D1Database, user: UserContext, query: WarehouseQuery): Promise<WarehousePage> {
  const warehouse = query.warehouse ?? '';
  const search = query.q ?? '';
  const offset = (query.page - 1) * pageSize;
  if (query.kind === 'movements') return listWarehouseMovements(db, user, query, offset);
  if (query.kind === 'outbound') {
    if (!canReadWarehouseFulfillment(user.permissions, user.channelScope)) {
      throw new HttpError(403, '当前岗位无权查看待出库订单', 'PERMISSION_DENIED');
    }
    const stage = query.stage === undefined ? null : Number(query.stage);
    const { results } = await db.prepare(`
      SELECT o.id, o.order_no AS orderNo, s.code AS skuCode, s.name AS skuName,
        w.name AS warehouseName, o.quantity, o.updated_at AS reservedAt,
        COALESCE(e.version, 0) AS outboundVersion, e.package_count AS packedPackageCount
      FROM orders o
      JOIN skus s ON s.id = o.sku_id AND s.tenant_id = o.tenant_id
      JOIN warehouses w ON w.id = o.warehouse_id AND w.tenant_id = o.tenant_id
      LEFT JOIN warehouse_outbound_events e ON e.tenant_id = o.tenant_id AND e.order_id = o.id
        AND e.version = (SELECT MAX(v.version) FROM warehouse_outbound_events v
          WHERE v.tenant_id = o.tenant_id AND v.order_id = o.id)
      WHERE o.tenant_id = ? AND o.status = 'reserved' AND (? = '' OR w.id = ?)
        AND (? IS NULL OR COALESCE(e.version, 0) = ?)
        AND (? = '' OR instr(lower(o.order_no), lower(?)) > 0 OR instr(lower(s.code), lower(?)) > 0
          OR instr(lower(s.name), lower(?)) > 0 OR instr(lower(w.name), lower(?)) > 0)
      ORDER BY o.updated_at, o.id
      LIMIT ? OFFSET ?
    `).bind(user.tenantId, warehouse, warehouse, stage, stage, search, search, search, search, search, pageSize + 1, offset)
      .all<WarehouseOutboundOrder>();
    return { ok: true, kind: 'outbound', rows: results.slice(0, pageSize), hasNext: results.length > pageSize };
  }

  if (!user.permissions.includes('warehouse:read')) requirePermission(user, 'purchase:read');
  const { results } = await db.prepare(`
    SELECT c.id, s.code AS skuCode, s.name AS skuName, w.name AS warehouseName,
      c.before_on_hand_qty AS beforeOnHandQty, c.reserved_qty AS reservedQty, c.counted_qty AS countedQty,
      c.reason, c.created_at AS createdAt
    FROM warehouse_stock_counts c
    JOIN skus s ON s.id = c.sku_id AND s.tenant_id = c.tenant_id
    JOIN warehouses w ON w.id = c.warehouse_id AND w.tenant_id = c.tenant_id
    WHERE c.tenant_id = ? AND (? = '' OR w.id = ?)
      AND (? = '' OR instr(lower(s.code), lower(?)) > 0 OR instr(lower(s.name), lower(?)) > 0
        OR instr(lower(w.name), lower(?)) > 0 OR instr(lower(c.reason), lower(?)) > 0)
    ORDER BY c.created_at DESC, c.id DESC
    LIMIT ? OFFSET ?
  `).bind(user.tenantId, warehouse, warehouse, search, search, search, search, search, pageSize + 1, offset)
    .all<WarehouseStockCount>();
  return { ok: true, kind: 'counts', rows: results.slice(0, pageSize), hasNext: results.length > pageSize };
}

async function listWarehouseMovements(db: D1Database, user: UserContext, query: WarehouseQuery, offset: number): Promise<WarehousePage> {
  if (!canReadInventoryMovements(user.permissions, user.channelScope)) {
    throw new HttpError(403, '当前岗位无权查看库存流水', 'PERMISSION_DENIED');
  }
  const start = query.from ? shanghaiMidnight(query.from) : '';
  const end = query.through ? shanghaiMidnight(query.through, 1) : '';
  const warehouse = query.warehouse ?? '';
  const sku = query.sku ?? '';
  const type = query.movement ?? '';
  const search = query.q ?? '';
  const { results } = await db.prepare(`
    WITH movements AS (
      SELECT m.id, m.tenant_id, m.sku_id, m.warehouse_id, m.type, m.on_hand_delta, m.reserved_delta,
        o.order_no AS reference, NULL AS purchase_order_no, NULL AS original_receipt_no, NULL AS reason,
        NULL AS before_on_hand_qty, NULL AS after_on_hand_qty, m.created_by, m.created_at
      FROM inventory_movements m
      JOIN orders o ON o.id = m.order_id AND o.tenant_id = m.tenant_id
      WHERE m.tenant_id = ? AND m.type IN ('reserve', 'release', 'ship')
      UNION ALL
      SELECT m.id, m.tenant_id, m.sku_id, m.warehouse_id, 'receipt', m.on_hand_delta, 0,
        r.receipt_no, p.order_no, NULL, NULL, NULL, NULL, m.created_by, m.created_at
      FROM inventory_inbound_movements m
      JOIN purchase_receipts r ON r.id = m.purchase_receipt_id AND r.tenant_id = m.tenant_id
      JOIN purchase_orders p ON p.id = m.purchase_order_id AND p.tenant_id = m.tenant_id
      WHERE m.tenant_id = ?
      UNION ALL
      SELECT m.id, m.tenant_id, m.sku_id, m.warehouse_id, 'receipt_correction', m.on_hand_delta, 0,
        c.correction_no, p.order_no, r.receipt_no, c.reason, NULL, NULL, m.created_by, m.created_at
      FROM inventory_receipt_correction_movements m
      JOIN purchase_receipt_corrections c ON c.id = m.correction_id AND c.tenant_id = m.tenant_id
      JOIN purchase_receipts r ON r.id = m.purchase_receipt_id AND r.tenant_id = m.tenant_id
      JOIN purchase_orders p ON p.id = m.purchase_order_id AND p.tenant_id = m.tenant_id
      WHERE m.tenant_id = ?
      UNION ALL
      SELECT c.id, c.tenant_id, c.sku_id, c.warehouse_id,
        CASE WHEN a.action = 'POST_OPENING_WAREHOUSE_STOCK' THEN 'opening' ELSE 'count' END,
        c.counted_qty - c.before_on_hand_qty, 0, c.id, NULL, NULL, c.reason,
        c.before_on_hand_qty, c.counted_qty, c.created_by, c.created_at
      FROM warehouse_stock_counts c
      LEFT JOIN audit_logs a ON a.tenant_id = c.tenant_id AND a.entity_id = c.id
        AND a.idempotency_key = 'warehouse-stock-count:' || c.operation_key
      WHERE c.tenant_id = ?
    )
    SELECT m.id, m.type, s.code AS skuCode, s.name AS skuName, w.name AS warehouseName,
      m.on_hand_delta AS onHandDelta, m.reserved_delta AS reservedDelta, m.reference,
      m.purchase_order_no AS purchaseOrderNo, m.original_receipt_no AS originalReceiptNo, m.reason,
      m.before_on_hand_qty AS beforeOnHandQty, m.after_on_hand_qty AS afterOnHandQty,
      a.display_name AS actor, m.created_at AS createdAt
    FROM movements m
    JOIN skus s ON s.id = m.sku_id AND s.tenant_id = m.tenant_id
    JOIN warehouses w ON w.id = m.warehouse_id AND w.tenant_id = m.tenant_id
    LEFT JOIN members a ON a.auth_user_id = m.created_by AND a.tenant_id = m.tenant_id
    WHERE (? = '' OR m.warehouse_id = ?) AND (? = '' OR m.sku_id = ?) AND (? = '' OR m.type = ?)
      AND (? = '' OR m.created_at >= ?) AND (? = '' OR m.created_at < ?)
      AND (? = '' OR instr(lower(s.code), lower(?)) > 0 OR instr(lower(s.name), lower(?)) > 0
        OR instr(lower(w.code), lower(?)) > 0 OR instr(lower(w.name), lower(?)) > 0
        OR instr(lower(m.reference), lower(?)) > 0 OR instr(lower(m.purchase_order_no), lower(?)) > 0
        OR instr(lower(m.original_receipt_no), lower(?)) > 0 OR instr(lower(m.reason), lower(?)) > 0)
    ORDER BY m.created_at DESC, m.id DESC, m.type ASC
    LIMIT ? OFFSET ?
  `).bind(user.tenantId, user.tenantId, user.tenantId, user.tenantId, warehouse, warehouse, sku, sku, type, type,
    start, start, end, end, search, search, search, search, search, search, search, search, search, pageSize + 1, offset)
    .all<WarehouseMovement>();
  return { ok: true, kind: 'movements', rows: results.slice(0, pageSize), hasNext: results.length > pageSize };
}

function shanghaiMidnight(date: string, nextDay = 0) {
  return new Date(Date.parse(`${date}T00:00:00+08:00`) + nextDay * 86_400_000).toISOString();
}

export async function recordWarehouseStockCount(
  db: D1Database,
  user: UserContext,
  input: StockCountInput,
  operationKey: string,
  opening?: OpeningStockGuard,
) {
  requirePermission(user, 'warehouse:manage');
  if (!/^[a-zA-Z0-9._:-]{8,128}$/.test(operationKey)) {
    throw new HttpError(400, '库存盘点操作缺少有效的去重标识', 'INVALID_IDEMPOTENCY_KEY');
  }

  const requestJson = JSON.stringify([input.warehouseId, input.skuId, input.expectedVersion, input.countedQty, input.reason,
    ...(opening ? [opening.snapshotVersion, opening.skuCode, opening.warehouseCode] : [])]);
  const hashBytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(requestJson));
  const hash = Array.from(new Uint8Array(hashBytes), (value) => value.toString(16).padStart(2, '0')).join('');
  const replay = await replayWarehouseStockCount(db, user.tenantId, operationKey, hash);
  if (replay) return replay;

  const previous = await db.prepare(`
    SELECT COALESCE(b.version, 0) AS version, COALESCE(b.on_hand_qty, 0) AS onHandQty,
      COALESCE(b.reserved_qty, 0) AS reservedQty
    FROM skus s
    JOIN warehouses w ON w.tenant_id = s.tenant_id
    LEFT JOIN inventory_balances b ON b.tenant_id = s.tenant_id AND b.sku_id = s.id AND b.warehouse_id = w.id
    WHERE s.tenant_id = ? AND s.id = ? AND w.id = ?
  `).bind(user.tenantId, input.skuId, input.warehouseId)
    .first<{ version: number; onHandQty: number; reservedQty: number }>();
  if (!previous) throw new HttpError(404, '当前工作区没有找到该 SKU 或仓库', 'WAREHOUSE_STOCK_COUNT_SCOPE_MISMATCH');
  if (previous.version !== input.expectedVersion) {
    const concurrentReplay = await replayWarehouseStockCount(db, user.tenantId, operationKey, hash);
    if (concurrentReplay) return concurrentReplay;
    throw stockCountVersionConflict();
  }
  if (input.countedQty < previous.reservedQty) {
    throw new HttpError(409, '实盘数不能低于订单预占数量，请先核查预占订单', 'WAREHOUSE_STOCK_COUNT_RESERVED');
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const auditBefore = JSON.stringify(previous);
  const auditAfter = JSON.stringify({ warehouseId: input.warehouseId, skuId: input.skuId,
    onHandQty: input.countedQty, reservedQty: previous.reservedQty,
    version: previous.version + 1, reason: input.reason, ...(opening ? { openingSnapshotVersion: opening.snapshotVersion } : {}) });
  const openingGuard = opening ? `
    WHERE NOT EXISTS (
      SELECT 1 FROM inventory_balances WHERE tenant_id = ? AND sku_id = ? AND warehouse_id = ?
    ) AND EXISTS (SELECT 1 FROM skus WHERE tenant_id = ? AND id = ? AND code = ? AND active = 1)
      AND EXISTS (SELECT 1 FROM warehouses WHERE tenant_id = ? AND id = ? AND code = ?)
      AND ? = (SELECT payload_hash FROM feishu_procurement_previews WHERE tenant_id = ?
        ORDER BY snapshot_date DESC, id DESC LIMIT 1)
  ` : '';
  const openingBindings = opening ? [
    user.tenantId, input.skuId, input.warehouseId, user.tenantId, input.skuId, opening.skuCode,
    user.tenantId, input.warehouseId, opening.warehouseCode, opening.snapshotVersion, user.tenantId,
  ] : [];
  try {
    const [write] = await db.batch([
      db.prepare(`
        INSERT INTO warehouse_stock_counts (
          id, tenant_id, sku_id, warehouse_id, before_on_hand_qty, reserved_qty, counted_qty, inventory_version,
          reason, operation_key, request_hash, created_by, created_at
        ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? ${openingGuard}
      `).bind(id, user.tenantId, input.skuId, input.warehouseId, previous.onHandQty, previous.reservedQty,
        input.countedQty, previous.version, input.reason, operationKey, hash, user.id, now, ...openingBindings),
      db.prepare(`
        INSERT INTO audit_logs (
          id, tenant_id, actor_id, actor_email, action, entity_type, entity_id, before_json, after_json,
          request_id, idempotency_key, source, created_at
        ) SELECT ?, ?, ?, ?, ?, 'warehouse_stock_count', ?, ?, ?, ?, ?, 'ui', ? ${opening ? 'WHERE changes() = 1' : ''}
      `).bind(crypto.randomUUID(), user.tenantId, user.id, user.email,
        opening ? 'POST_OPENING_WAREHOUSE_STOCK' : 'COUNT_WAREHOUSE_STOCK', id, auditBefore, auditAfter,
        id, `warehouse-stock-count:${operationKey}`, now),
    ]);
    if (opening && Number(write.meta.changes) !== 1) {
      throw new HttpError(409, '期初资料或库存账已变化，请刷新后重新核对。', 'OPENING_STOCK_STATE_CHANGED');
    }
  } catch (error) {
    const concurrentReplay = await replayWarehouseStockCount(db, user.tenantId, operationKey, hash);
    if (concurrentReplay) return concurrentReplay;
    if (String(error).includes('WAREHOUSE_STOCK_COUNT_VERSION_CONFLICT')) throw stockCountVersionConflict();
    if (String(error).includes('WAREHOUSE_STOCK_COUNT_SCOPE_MISMATCH')) {
      throw new HttpError(404, '当前工作区没有找到该 SKU 或仓库', 'WAREHOUSE_STOCK_COUNT_SCOPE_MISMATCH');
    }
    throw error;
  }
  return { id, replayed: false };
}

async function replayWarehouseStockCount(db: D1Database, tenantId: string, key: string, hash: string) {
  const existing = await db.prepare(`
    SELECT id, request_hash FROM warehouse_stock_counts WHERE tenant_id = ? AND operation_key = ?
  `).bind(tenantId, key).first<{ id: string; request_hash: string }>();
  if (!existing) return null;
  if (existing.request_hash !== hash) throw new HttpError(409, '同一个盘点操作已用于不同内容', 'IDEMPOTENCY_CONFLICT');
  return { id: existing.id, replayed: true };
}

function stockCountVersionConflict() {
  return new HttpError(409, '盘点期间库存发生变化，请刷新库存并重新核对实盘数', 'WAREHOUSE_STOCK_COUNT_VERSION_CONFLICT');
}
