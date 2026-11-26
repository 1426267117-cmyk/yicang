import { z } from 'zod';
import { sha256Hex } from './connectors/stable';
import { createOrderSchema } from './contracts';
import { HttpError, requirePermission, type UserContext } from './db';
import type { OrderStatus } from './domain';
import { getOrder, prepareOrderInsert } from './erp-service';
import { nineStoreRoster, type NineStoreOrderSnapshot } from './nine-store-orders-contract';
import { findFeishuNativeIdentity, findHandoffLinks, linkedOrderSummary, type StoredHandoffLink } from './order-handoff-links';

const sourceAgeMs = 15 * 60_000;
const orderNo = z.string().trim().regex(/^[A-Za-z0-9#_.-][A-Za-z0-9#_. -]{2,89}$/u);
const storeKey = z.enum(nineStoreRoster.map(([key]) => key));
const sourceSku = z.string().trim().min(1).max(120).regex(/^[^\r\n@]+$/u);
const channelByPlatform = { amazon: 'Amazon', shopify: 'Shopify', wayfair: 'Wayfair' } as const;

export const nineStoreHandoffQuerySchema = z.strictObject({ store: storeKey, orderNo });
export const nineStoreHandoffPostSchema = z.strictObject({
  storeKey, orderNo, sourceSku, observedAt: z.iso.datetime(),
  skuId: createOrderSchema.shape.skuId.max(160), warehouseId: createOrderSchema.shape.warehouseId.max(160),
  quantity: createOrderSchema.shape.quantity, destination: createOrderSchema.shape.destination,
  customerName: createOrderSchema.shape.customerName, currency: createOrderSchema.shape.currency,
  amountMinor: createOrderSchema.shape.amountMinor, confirmedPending: z.literal(true),
});

type Selector = z.infer<typeof nineStoreHandoffQuerySchema>;
type HandoffInput = z.infer<typeof nineStoreHandoffPostSchema>;
type SourceLine = NineStoreOrderSnapshot['orders'][number];
type StoredSnapshot = { observed_at: string; payload_hash: string; payload_json: string };
type Eligibility = 'ready' | 'source_stale' | 'not_pending' | 'awaiting_sku' | 'ambiguous' | 'refunded' | 'already_linked';
type Source = Pick<SourceLine, 'storeKey' | 'orderNo' | 'sku' | 'fulfillment'> & { observedAt: string };

export type NineStoreHandoffDetails = {
  source: Source;
  eligibility: Eligibility;
  matchedSkuId: string | null;
  linkedOrder: { id: string; orderNo: string; status: OrderStatus; trackedPackages: number } | null;
};

export async function getNineStoreHandoff(db: D1Database, user: UserContext, selector: Selector, now = new Date()): Promise<NineStoreHandoffDetails> {
  requirePermission(user, 'orders:read');
  const [link, snapshot] = await Promise.all([
    findLink(db, user.tenantId, selector),
    loadSource(db, user.tenantId, selector),
  ]);
  if (link) return {
    source: snapshot ? publicSource(snapshot.line, snapshot.observedAt) : linkSource(selector.store, link),
    eligibility: 'already_linked', matchedSkuId: null,
    linkedOrder: linkedOrderSummary(link),
  };
  if (!snapshot) throw missingSource();
  const eligibility = await inspectEligibility(db, user.tenantId, snapshot, now);
  return { source: publicSource(snapshot.line, snapshot.observedAt), ...eligibility, linkedOrder: null };
}

export async function createNineStoreHandoff(db: D1Database, user: UserContext, input: HandoffInput, now = new Date()) {
  requirePermission(user, 'orders:create');
  const selector = { store: input.storeKey, orderNo: orderKey(input.orderNo) };
  const details = {
    skuId: input.skuId, warehouseId: input.warehouseId, quantity: input.quantity, destination: input.destination,
    customerName: input.customerName, currency: input.currency, amountMinor: input.amountMinor,
  };
  const requestHash = await sha256Hex(JSON.stringify([selector.store, selector.orderNo, asciiUpper(input.sourceSku), details]));
  const identity = await findFeishuNativeIdentity(db, user.tenantId, selector.store, selector.orderNo);
  const existing = await findLink(db, user.tenantId, selector, identity);
  if (existing) return replay(existing);

  const snapshot = await loadSource(db, user.tenantId, selector);
  if (!snapshot) throw missingSource();
  if (snapshot.observedAt !== new Date(input.observedAt).toISOString() || asciiUpper(snapshot.line.sku ?? '') !== asciiUpper(input.sourceSku)) {
    throw new HttpError(409, '来源订单已更新，请重新打开并核对后再转单', 'NINE_STORE_HANDOFF_SOURCE_CHANGED');
  }
  const { eligibility, matchedSkuId } = await inspectEligibility(db, user.tenantId, snapshot, now);
  if (eligibility !== 'ready') throw ineligible(eligibility);
  if (matchedSkuId !== input.skuId) {
    throw new HttpError(409, '所选 ERP SKU 与此来源订单的 SKU 不一致', 'NINE_STORE_HANDOFF_SKU_MISMATCH');
  }

  const { line, platform, observedAt, payloadHash } = snapshot;
  const timestamp = now.toISOString();
  const operationKey = `nine-store:${await sha256Hex(JSON.stringify([user.tenantId, selector.store, selector.orderNo]))}`;
  const { id, statement } = prepareOrderInsert(db, user, { channel: channelByPlatform[platform], ...details }, operationKey, requestHash, timestamp, {
    sql: `EXISTS (SELECT 1 FROM nine_store_order_snapshots WHERE tenant_id = ? AND observed_at = ? AND payload_hash = ?)
      AND NOT EXISTS (SELECT 1 FROM nine_store_order_handoffs WHERE tenant_id = ? AND (
        (store_key = ? AND source_order_key IN (${identity.keys.map(() => '?').join(', ')})) OR (platform = ? AND source_record_id = ?)
      ))
      AND NOT EXISTS (
        SELECT 1 FROM native_channel_handoff_proofs proof
        JOIN native_channel_order_identity source ON source.id = proof.platform_order_id AND source.tenant_id = proof.tenant_id
        WHERE proof.tenant_id = ? AND source.store_key = ?
          AND ? IN (source.order_key, source.alternate_order_key, source.internal_order_no, '#' || source.internal_order_no)
      )
      AND 1 = (SELECT COUNT(*) FROM skus WHERE tenant_id = ? AND active = 1 AND upper(code) = upper(?))
      AND EXISTS (
        SELECT 1 FROM inventory_balances b JOIN skus s ON s.id = b.sku_id AND s.tenant_id = b.tenant_id AND s.active = 1
        JOIN warehouses w ON w.id = b.warehouse_id AND w.tenant_id = b.tenant_id
        WHERE b.tenant_id = ? AND b.sku_id = ? AND b.warehouse_id = ? AND upper(s.code) = upper(?)
      )`,
    values: [user.tenantId, observedAt, payloadHash, user.tenantId, selector.store, ...identity.keys, platform, line.recordId,
      user.tenantId, selector.store, selector.orderNo,
      user.tenantId, line.sku, user.tenantId, input.skuId, input.warehouseId, line.sku],
  });
  const [inserted] = await db.batch([
    statement,
    db.prepare(`INSERT INTO nine_store_order_handoffs
      (tenant_id, platform, store_key, source_order_key, source_order_no, source_record_id, source_sku, source_observed_at, order_id, request_hash, created_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, id, ?, ? FROM orders WHERE id = ? AND tenant_id = ?`)
      .bind(user.tenantId, platform, selector.store, selector.orderNo, line.orderNo, line.recordId, line.sku, observedAt,
        requestHash, timestamp, id, user.tenantId),
  ]);
  if (Number(inserted.meta.changes) === 1) return { order: await getOrder(db, user.tenantId, id), source: publicSource(line, observedAt), replayed: false };

  const concurrentLink = await findLink(db, user.tenantId, selector);
  if (concurrentLink) return replay(concurrentLink);
  const current = await loadSource(db, user.tenantId, selector);
  if (!current || current.observedAt !== observedAt || current.payloadHash !== payloadHash) {
    throw new HttpError(409, '来源订单已更新，请重新打开并核对后再转单', 'NINE_STORE_HANDOFF_SOURCE_CHANGED');
  }
  const movedLink = await db.prepare(`SELECT 1 FROM nine_store_order_handoffs WHERE tenant_id = ? AND platform = ? AND source_record_id = ?`)
    .bind(user.tenantId, platform, line.recordId).first();
  if (movedLink) throw new HttpError(409, '来源记录已经转单，店铺或订单号调整后仍需核对原 ERP 单据', 'NINE_STORE_HANDOFF_ALREADY_LINKED');
  throw new HttpError(409, '所选 SKU 未建档、已停用或此仓没有对应的 ERP 库存账', 'NINE_STORE_HANDOFF_INVENTORY_UNAVAILABLE');

  async function replay(link: StoredHandoffLink) {
    if (link.request_hash !== requestHash) {
      throw new HttpError(409, '这笔店铺订单已有 ERP 单据，请查看原单', 'NINE_STORE_HANDOFF_ALREADY_LINKED');
    }
    return { order: await getOrder(db, user.tenantId, link.order_id), source: linkSource(selector.store, link), replayed: true };
  }
}

async function findLink(db: D1Database, tenantId: string, selector: Selector,
  identity?: Awaited<ReturnType<typeof findFeishuNativeIdentity>>) {
  const match = identity ?? await findFeishuNativeIdentity(db, tenantId, selector.store, orderKey(selector.orderNo));
  if (match.uncertain) throw ineligible('ambiguous');
  const { results } = await findHandoffLinks(db, tenantId, selector.store, match.keys, match.nativeOrderId);
  const link = results[0] ?? null;
  if (results.length > 1 || (match.nativeOrderId && link?.platform_order_id && link.platform_order_id !== match.nativeOrderId)) {
    throw ineligible('ambiguous');
  }
  return link;
}

async function loadSource(db: D1Database, tenantId: string, selector: Selector) {
  const stored = await db.prepare(`SELECT observed_at, payload_hash, payload_json FROM nine_store_order_snapshots WHERE tenant_id = ?`)
    .bind(tenantId).first<StoredSnapshot>();
  if (!stored) return null;
  const data = JSON.parse(stored.payload_json) as NineStoreOrderSnapshot;
  const merchant = data.stores.find((entry) => entry.key === selector.store);
  if (!merchant) return null;
  const key = orderKey(selector.orderNo);
  const match = (row: { storeKey: string; orderNo: string }) => row.storeKey === selector.store && orderKey(row.orderNo) === key;
  const rows = data.orders.filter(match);
  if (!rows.length) return null;
  return { observedAt: stored.observed_at, payloadHash: stored.payload_hash, platform: merchant.platform, line: rows[0],
    ambiguous: rows.length !== 1, refunded: data.refunds.some(match) };
}

async function inspectEligibility(db: D1Database, tenantId: string, snapshot: NonNullable<Awaited<ReturnType<typeof loadSource>>>, now: Date):
Promise<{ eligibility: Exclude<Eligibility, 'already_linked'>; matchedSkuId: string | null }> {
  const age = now.getTime() - Date.parse(snapshot.observedAt);
  if (!Number.isFinite(age) || age > sourceAgeMs || age < -60_000) return { eligibility: 'source_stale', matchedSkuId: null };
  if (snapshot.ambiguous) return { eligibility: 'ambiguous', matchedSkuId: null };
  if (snapshot.refunded) return { eligibility: 'refunded', matchedSkuId: null };
  if (snapshot.line.fulfillment !== 'pending') return { eligibility: 'not_pending', matchedSkuId: null };
  if (!snapshot.line.sku) return { eligibility: 'awaiting_sku', matchedSkuId: null };
  const { results } = await db.prepare(`SELECT id FROM skus WHERE tenant_id = ? AND active = 1 AND upper(code) = upper(?) LIMIT 2`)
    .bind(tenantId, snapshot.line.sku).all<{ id: string }>();
  if (results.length !== 1) return { eligibility: 'awaiting_sku', matchedSkuId: null };
  return { eligibility: 'ready', matchedSkuId: results[0].id };
}

function publicSource(line: SourceLine, observedAt: string): Source {
  return { storeKey: line.storeKey, orderNo: line.orderNo, sku: line.sku, fulfillment: line.fulfillment, observedAt };
}

function linkSource(store: Selector['store'], link: StoredHandoffLink): Source {
  return { storeKey: store, orderNo: link.source_order_no, sku: link.source_sku, fulfillment: null, observedAt: link.source_observed_at };
}

function orderKey(value: string) {
  return value.toUpperCase();
}

function asciiUpper(value: string) {
  return value.replace(/[a-z]/gu, (character) => character.toUpperCase());
}

function missingSource() {
  return new HttpError(404, '当前飞书批次没有这笔店铺订单', 'NINE_STORE_HANDOFF_SOURCE_NOT_FOUND');
}

function ineligible(reason: Exclude<Eligibility, 'ready' | 'already_linked'>) {
  const messages = {
    source_stale: '飞书订单已超过 15 分钟未同步，请刷新后再核对',
    not_pending: '飞书来源尚未确认这笔订单待发货，请先核对平台状态',
    awaiting_sku: '来源 SKU 尚无唯一启用的 ERP 同码档案',
    ambiguous: '当前转单支持单行订单，请在平台核对这笔多行订单',
    refunded: '来源订单已出现退款，请先核对是否需要发货',
  };
  return new HttpError(409, messages[reason], `NINE_STORE_HANDOFF_${reason.toUpperCase()}`);
}
