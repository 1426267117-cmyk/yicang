import { z } from 'zod';
import { HttpError, type UserContext } from './db';
import { canManageWarehouseFulfillment, canReadWarehouseFulfillment, type OrderStatus } from './domain';
import { confirmWarehouseOrderShipment } from './erp-service';

const stageVersions = { pick: 1, verify: 2, pack: 3 } as const;
const expectedVersion = z.number().int().nonnegative().max(2);
const quantity = z.number().int().positive().max(2_147_483_647);

export const warehouseOutboundStepSchema = z.discriminatedUnion('step', [
  z.object({ step: z.literal('pick'), expectedVersion, quantity }).strict(),
  z.object({ step: z.literal('verify'), expectedVersion, quantity, skuCode: z.string().trim().min(1).max(160) }).strict(),
  z.object({ step: z.literal('pack'), expectedVersion, packageCount: quantity }).strict(),
]);

export type WarehouseOutboundStep = z.infer<typeof warehouseOutboundStepSchema>;
export const warehouseOutboundActionSchema = z.union([
  warehouseOutboundStepSchema,
  z.strictObject({ step: z.literal('ship'), expectedVersion: z.literal(3) }),
]);
type Stage = WarehouseOutboundStep['step'];
type Event = {
  step: Stage; version: number; quantity: number | null; skuCode: string | null;
  packageCount: number | null; createdAt: string;
};
export type WarehouseOutboundState = {
  orderId: string; orderNo: string; orderStatus: OrderStatus; quantity: number; version: number;
  skuCode: string; events: Event[];
};

type StateRow = {
  orderId: string; orderNo: string; orderStatus: OrderStatus; orderQuantity: number; orderSkuCode: string;
  step: Stage | null; version: number | null; confirmedQuantity: number | null;
  verifiedSkuCode: string | null; packageCount: number | null; createdAt: string | null;
};

export async function getWarehouseOutbound(db: D1Database, user: UserContext, orderId: string) {
  if (!canReadWarehouseFulfillment(user.permissions, user.channelScope)) {
    throw new HttpError(403, '当前岗位无权查看出库作业', 'PERMISSION_DENIED');
  }
  const warehouseOnly = !user.permissions.includes('orders:read');
  return readState(db, user.tenantId, orderId, warehouseOnly);
}

export async function confirmWarehouseOutboundShipment(db: D1Database, user: UserContext, orderId: string, operationKey: string) {
  const result = await confirmWarehouseOrderShipment(db, user, orderId, operationKey);
  return { ...result, state: await readState(db, user.tenantId, orderId) };
}

export async function recordWarehouseOutboundStep(
  db: D1Database,
  user: UserContext,
  orderId: string,
  input: WarehouseOutboundStep,
  operationKey: string,
) {
  if (!canManageWarehouseFulfillment(user.permissions, user.channelScope)) {
    throw new HttpError(403, '当前岗位无权办理出库作业', 'PERMISSION_DENIED');
  }
  if (operationKey.length < 8 || operationKey.length > 128) {
    throw new HttpError(400, '缺少有效的 Idempotency-Key', 'INVALID_IDEMPOTENCY_KEY');
  }

  const version = stageVersions[input.step];
  const confirmedQuantity = input.step === 'pack' ? null : input.quantity;
  const verifiedSku = input.step === 'verify' ? input.skuCode : null;
  const packageCount = input.step === 'pack' ? input.packageCount : null;
  const requestBody = [orderId, input.step, input.expectedVersion, confirmedQuantity, verifiedSku, packageCount];
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(requestBody)));
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  const replay = await replayStep(db, user.tenantId, orderId, operationKey, hash);
  if (replay) return replay;

  const current = await readState(db, user.tenantId, orderId);
  if (current.orderStatus !== 'reserved' || current.version !== input.expectedVersion || version !== current.version + 1) {
    const concurrentReplay = await replayStep(db, user.tenantId, orderId, operationKey, hash);
    if (concurrentReplay) return concurrentReplay;
    if (current.orderStatus !== 'reserved') throw unavailableOrder();
    throw versionConflict();
  }
  if (confirmedQuantity !== null && confirmedQuantity !== current.quantity) {
    throw new HttpError(409, `实物数量应为预占的 ${current.quantity} 件，请重新核对`, 'WAREHOUSE_OUTBOUND_QUANTITY_MISMATCH');
  }
  if (verifiedSku !== null && verifiedSku !== current.skuCode) {
    throw new HttpError(409, '复核 SKU 与订单不一致，请重新核对实物', 'WAREHOUSE_OUTBOUND_SKU_MISMATCH');
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const auditBefore = JSON.stringify({ version: current.version, step: current.events.at(-1)?.step ?? null });
  const auditAfter = JSON.stringify({ version, step: input.step, quantity: confirmedQuantity, skuCode: verifiedSku, packageCount });
  try {
    await db.batch([
      db.prepare(`
        INSERT INTO warehouse_outbound_events (id, tenant_id, order_id, version, step, quantity,
          sku_code, package_count, operation_key, request_hash, created_by, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(id, user.tenantId, orderId, version, input.step, confirmedQuantity, verifiedSku, packageCount,
        operationKey, hash, user.id, now),
      db.prepare(`
        INSERT INTO audit_logs (id, tenant_id, actor_id, actor_email, action, entity_type, entity_id,
          before_json, after_json, request_id, idempotency_key, source, created_at)
        VALUES (?, ?, ?, ?, ?, 'order', ?, ?, ?, ?, ?, 'ui', ?)
      `).bind(crypto.randomUUID(), user.tenantId, user.id, user.email, `WAREHOUSE_OUTBOUND_${input.step.toUpperCase()}`,
        orderId, auditBefore, auditAfter, id, `warehouse-outbound:${operationKey}`, now),
    ]);
  } catch (error) {
    const concurrentReplay = await replayStep(db, user.tenantId, orderId, operationKey, hash);
    if (concurrentReplay) return concurrentReplay;
    const message = String(error);
    if (message.includes('WAREHOUSE_OUTBOUND_VERSION_CONFLICT') || message.includes('WAREHOUSE_OUTBOUND_VALUE_MISMATCH')) {
      throw versionConflict();
    }
    if (message.includes('WAREHOUSE_OUTBOUND_ORDER_UNAVAILABLE')) throw unavailableOrder();
    throw error;
  }
  return { state: await readState(db, user.tenantId, orderId), replayed: false };
}

async function readState(db: D1Database, tenantId: string, orderId: string, warehouseOnly = false): Promise<WarehouseOutboundState> {
  const { results } = await db.prepare(`
    SELECT o.id AS orderId, o.order_no AS orderNo, o.status AS orderStatus, o.quantity AS orderQuantity,
      s.code AS orderSkuCode, e.step, e.version, e.quantity AS confirmedQuantity,
      e.sku_code AS verifiedSkuCode, e.package_count AS packageCount, e.created_at AS createdAt
    FROM orders o
    JOIN skus s ON s.id = o.sku_id AND s.tenant_id = o.tenant_id
    LEFT JOIN warehouse_outbound_events e ON e.order_id = o.id AND e.tenant_id = o.tenant_id
    WHERE o.id = ? AND o.tenant_id = ?
      AND (? = 0 OR o.status IN ('reserved', 'shipped') OR e.id IS NOT NULL)
    ORDER BY e.version
  `).bind(orderId, tenantId, warehouseOnly ? 1 : 0).all<StateRow>();
  const order = results[0];
  if (!order) throw new HttpError(404, '当前工作区没有找到该订单', 'ORDER_NOT_FOUND');
  const events: Event[] = [];
  for (const row of results) {
    if (row.step && row.version && row.createdAt) {
      events.push({ step: row.step, version: row.version, quantity: row.confirmedQuantity,
        skuCode: row.verifiedSkuCode, packageCount: row.packageCount, createdAt: row.createdAt });
    }
  }
  return { orderId: order.orderId, orderNo: order.orderNo, orderStatus: order.orderStatus,
    quantity: order.orderQuantity, skuCode: order.orderSkuCode, version: events.at(-1)?.version ?? 0, events };
}

async function replayStep(db: D1Database, tenantId: string, orderId: string, operationKey: string, hash: string) {
  const existing = await db.prepare(`
    SELECT request_hash FROM warehouse_outbound_events WHERE tenant_id = ? AND operation_key = ?
  `).bind(tenantId, operationKey).first<{ request_hash: string }>();
  if (!existing) return null;
  if (existing.request_hash !== hash) throw new HttpError(409, '该操作编号已用于不同内容', 'IDEMPOTENCY_CONFLICT');
  return { state: await readState(db, tenantId, orderId), replayed: true };
}

function versionConflict() {
  return new HttpError(409, '出库作业已更新，请刷新后核对当前步骤', 'WAREHOUSE_OUTBOUND_VERSION_CONFLICT');
}

function unavailableOrder() {
  return new HttpError(409, '只有已预占的订单可以登记出库作业', 'WAREHOUSE_OUTBOUND_ORDER_UNAVAILABLE');
}
