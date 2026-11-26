import { z } from 'zod';
import { sha256Hex } from './connectors/stable';
import { createOrderSchema } from './contracts';
import { HttpError, requirePermission, type UserContext } from './db';
import { getOrder, prepareOrderInsert } from './erp-service';
import { findHandoffLinks, linkedOrderSummary, type StoredHandoffLink } from './order-handoff-links';

const orderNoPattern = /^[A-Za-z0-9#_.-][A-Za-z0-9#_. -]{2,89}$/u;
const maximumSourceAgeMs = 15 * 60_000;
const storeKey = z.enum(['amazon-senyu', 'amazon-kaguyasu', 'amazon-zhongcheng', 'amazon-genji',
  'shopify-zimasya', 'shopify-kaguyasu', 'shopify-anzhap', 'shopify-bizfurniz']);

export const nativeChannelHandoffPostSchema = z.strictObject({
  storeKey,
  sourceVersion: z.string().regex(/^[a-f0-9]{64}$/u),
  skuId: createOrderSchema.shape.skuId.max(160),
  warehouseId: createOrderSchema.shape.warehouseId.max(160),
  customerName: createOrderSchema.shape.customerName,
  destination: createOrderSchema.shape.destination,
  confirmedMerchantFulfillment: z.literal(true),
  confirmedUnrefunded: z.literal(true),
  confirmedPayment: z.literal(true),
});

type Input = z.infer<typeof nativeChannelHandoffPostSchema>;
const reasons = {
  ready: null,
  already_linked: '这笔店铺订单已有 ERP 单据。',
  test_order: '测试订单不进入 ERP 发货流程。',
  unverified_store: '当前店铺的官方连接归属尚未核验，或店铺已停用。',
  identity_ambiguous: '平台单号、店铺或历史关联有多种匹配，请核对平台原单和已有 ERP 单据。',
  refunded: '平台或历史退款记录显示此单存在退款。',
  not_pending: '平台当前没有确认整单处于待发货状态，或已经有履约记录。',
  payment_unverified: '当前平台订单未明确标记为已付款且退款额为零。',
  merchant_unverified: '平台没有确认这笔 Amazon 订单由卖家自行发货。',
  ambiguous_lines: '当前仅支持一条可确认的商品明细。',
  shipping_unverified: '平台未确认该商品可整单实物发货。请同步订单后核对。',
  quantity_unverified: '平台待发件数缺失、超过可处理范围或与原订单数量不一致。',
  missing_title: '平台未提供商品名称。',
  amount_unverified: '平台未提供有效原币金额，或当前 ERP 单据尚不支持该币种。',
  awaiting_sku: '平台 SKU 尚无唯一启用的 ERP 同码档案。',
  source_stale: '此平台订单超过 15 分钟未更新核验，请重新同步这一单。',
} as const;
type Eligibility = keyof typeof reasons;
type Candidate = {
  id: string; platform: 'amazon' | 'shopify'; platform_store_id: string; official_store_id: string;
  store_key: Input['storeKey'] | null; order_no: string | null; order_key: string | null;
  alternate_order_key: string | null; internal_order_no: string | null;
  source_version: string; source_updated_at: string; fetched_at: string;
  currency: 'CNY' | 'USD' | 'EUR' | 'GBP' | null; amount_minor: number | null; platform_line_id: string | null;
  line_version: string | null; sku: string | null; title: string | null; quantity: number | null; eligibility: Eligibility;
};

export async function getNativeChannelHandoff(db: D1Database, user: UserContext, nativeOrderId: string, now = new Date()) {
  requireHandoffPermission(user, 'orders:read');
  const source = await loadCandidate(db, user.tenantId, nativeOrderId);
  const identity = await readLinks(db, user.tenantId, source);
  const linkedOrder = identity.link ? linkedOrderSummary(identity.link) : null;
  const review = linkedOrder ? { eligibility: 'already_linked' as const, matchedSkuId: null }
    : await inspectCandidate(db, user.tenantId, source, identity.ambiguous, now);
  return { source: publicSource(source), ...review, reason: reasons[review.eligibility], linkedOrder,
    canCreate: review.eligibility === 'ready' && user.permissions.includes('orders:create') };
}

export async function createNativeChannelHandoff(db: D1Database, user: UserContext, nativeOrderId: string, input: Input, now = new Date()) {
  requireHandoffPermission(user, 'orders:create');
  const source = await loadCandidate(db, user.tenantId, nativeOrderId);
  if (source.store_key !== input.storeKey) throw sourceChanged();
  const requestHash = await sha256Hex(JSON.stringify([source.id, input.storeKey, input.sourceVersion, input.skuId, input.warehouseId,
    input.customerName, input.destination]));
  const identity = await readLinks(db, user.tenantId, source);
  if (identity.link) return replay(identity.link);
  if (source.source_version !== input.sourceVersion) throw sourceChanged();
  const review = await inspectCandidate(db, user.tenantId, source, identity.ambiguous, now);
  if (review.eligibility !== 'ready') throw blocked(review.eligibility);
  if (review.matchedSkuId !== input.skuId) {
    throw new HttpError(409, '所选 ERP SKU 与此平台订单的 SKU 不一致', 'NATIVE_HANDOFF_SKU_MISMATCH');
  }
  const { platform, order_no, order_key, sku, quantity, currency, amount_minor, platform_line_id, line_version } = source;
  if (!order_no || !order_key || !sku || !quantity || !currency || !amount_minor || !platform_line_id || !line_version) throw sourceChanged();

  const { displayKeys, possibleInternalKeys } = possibleKeys(source);
  const keys = [...new Set([...displayKeys, ...possibleInternalKeys])];
  const timestamp = now.toISOString();
  const operationKey = `native-channel:${await sha256Hex(JSON.stringify([user.tenantId, source.id]))}`;
  const { id, statement } = prepareOrderInsert(db, user, {
    channel: platform === 'amazon' ? 'Amazon' : 'Shopify', skuId: input.skuId, warehouseId: input.warehouseId,
    quantity, currency, amountMinor: amount_minor, customerName: input.customerName, destination: input.destination,
  }, operationKey, requestHash, timestamp, {
    sql: `EXISTS (
      SELECT 1 FROM native_channel_handoff_candidates current
      WHERE current.tenant_id = ? AND current.id = ? AND current.eligibility = 'ready' AND current.store_key = ?
        AND current.order_key = ? AND current.platform_store_id = ? AND current.official_store_id = ?
        AND current.source_version = ? AND current.platform_line_id = ? AND current.line_version = ?
        AND current.sku = ? AND current.currency = ? AND current.amount_minor = ? AND current.quantity = ?
        AND julianday(current.fetched_at) BETWEEN julianday(?, '-15 minutes') AND julianday(?, '+1 minute')
    ) AND NOT EXISTS (
      SELECT 1 FROM nine_store_order_handoffs WHERE tenant_id = ? AND store_key = ?
        AND source_order_key IN (${keys.map(() => '?').join(', ')})
    ) AND NOT EXISTS (
      SELECT 1 FROM native_channel_handoff_proofs WHERE tenant_id = ? AND platform_order_id = ?
    ) AND 1 = (SELECT COUNT(*) FROM skus WHERE tenant_id = ? AND active = 1 AND upper(code) = upper(?))
      AND EXISTS (
        SELECT 1 FROM inventory_balances b JOIN skus s ON s.id = b.sku_id AND s.tenant_id = b.tenant_id AND s.active = 1
        JOIN warehouses w ON w.id = b.warehouse_id AND w.tenant_id = b.tenant_id
        WHERE b.tenant_id = ? AND b.sku_id = ? AND b.warehouse_id = ? AND upper(s.code) = upper(?)
      )`,
    values: [user.tenantId, source.id, input.storeKey, order_key, source.platform_store_id, source.official_store_id,
      input.sourceVersion, platform_line_id, line_version, sku, currency, amount_minor, quantity, timestamp, timestamp,
      user.tenantId, input.storeKey, ...keys, user.tenantId, source.id, user.tenantId, sku,
      user.tenantId, input.skuId, input.warehouseId, sku],
  });
  const [inserted] = await db.batch([
    statement,
    db.prepare(`INSERT INTO nine_store_order_handoffs
      (tenant_id, platform, store_key, source_order_key, source_order_no, source_record_id, source_sku, source_observed_at, order_id, request_hash, created_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, current.fetched_at, o.id, ?, ? FROM orders o
      JOIN platform_orders current ON current.id = ? AND current.tenant_id = o.tenant_id
      WHERE o.id = ? AND o.tenant_id = ?`)
      .bind(user.tenantId, platform, input.storeKey, order_key, order_no, `native:${source.id}`, sku, requestHash,
        timestamp, source.id, id, user.tenantId),
    db.prepare(`INSERT INTO native_channel_handoff_proofs
      (order_id, tenant_id, platform_store_id, official_store_id, platform_order_id, platform_line_id, source_version)
      SELECT id, tenant_id, ?, ?, ?, ?, ? FROM orders WHERE id = ? AND tenant_id = ?`)
      .bind(source.platform_store_id, source.official_store_id, source.id, platform_line_id, input.sourceVersion, id, user.tenantId),
  ]);
  if (Number(inserted.meta.changes) === 1) {
    const { id: orderId, orderNo, status } = await getOrder(db, user.tenantId, id);
    return { order: { id: orderId, orderNo, status }, source: publicSource(source), replayed: false };
  }

  const current = await loadCandidate(db, user.tenantId, nativeOrderId);
  const after = await readLinks(db, user.tenantId, current);
  if (after.link) return replay(after.link);
  if (current.source_version !== source.source_version || current.line_version !== source.line_version
    || current.store_key !== source.store_key || current.official_store_id !== source.official_store_id) throw sourceChanged();
  const inspected = await inspectCandidate(db, user.tenantId, current, after.ambiguous, now);
  if (inspected.eligibility !== 'ready') throw blocked(inspected.eligibility);
  throw new HttpError(409, '所选 SKU 未建档、已停用或此仓没有对应的 ERP 库存账', 'NATIVE_HANDOFF_INVENTORY_UNAVAILABLE');

  function replay(link: StoredHandoffLink) {
    if (link.platform_order_id !== source.id || link.request_hash !== requestHash) throw blocked('already_linked');
    const { id, orderNo, status } = linkedOrderSummary(link);
    return { order: { id, orderNo, status }, source: publicSource(source), replayed: true };
  }
}

async function loadCandidate(db: D1Database, tenantId: string, nativeOrderId: string) {
  const source = await db.prepare(`SELECT * FROM native_channel_handoff_candidates WHERE tenant_id = ? AND id = ?`)
    .bind(tenantId, nativeOrderId).first<Candidate>();
  if (!source) throw new HttpError(404, '当前工作区没有找到这笔官方渠道订单', 'NATIVE_HANDOFF_NOT_FOUND');
  return source;
}

function possibleKeys(source: Candidate) {
  const displayKeys = [source.order_key, source.alternate_order_key].filter((key): key is string => key !== null);
  const possibleInternalKeys = source.internal_order_no ? [source.internal_order_no, `#${source.internal_order_no}`] : [];
  return { displayKeys, possibleInternalKeys };
}

async function readLinks(db: D1Database, tenantId: string, source: Candidate) {
  if (!source.store_key || !source.order_key || source.eligibility === 'identity_ambiguous') return { link: null, ambiguous: false };
  const { displayKeys, possibleInternalKeys } = possibleKeys(source);
  const { results } = await findHandoffLinks(db, tenantId, source.store_key, [...new Set([...displayKeys, ...possibleInternalKeys])], source.id);
  if (results.length > 1) return { link: null, ambiguous: true };
  const link = results[0] ?? null;
  if (link && (link.platform_order_id ? link.platform_order_id !== source.id : !displayKeys.includes(link.source_order_no.toUpperCase()))) {
    return { link: null, ambiguous: true };
  }
  return { link, ambiguous: false };
}

async function inspectCandidate(db: D1Database, tenantId: string, source: Candidate, ambiguous: boolean, now: Date):
Promise<{ eligibility: Eligibility; matchedSkuId: string | null }> {
  if (ambiguous || !source.order_no || !orderNoPattern.test(source.order_no)) return { eligibility: 'identity_ambiguous', matchedSkuId: null };
  if (source.eligibility !== 'ready') return { eligibility: source.eligibility, matchedSkuId: null };
  const age = now.getTime() - Date.parse(source.fetched_at);
  if (!Number.isFinite(age) || age > maximumSourceAgeMs || age < -60_000) return { eligibility: 'source_stale', matchedSkuId: null };
  const { results } = await db.prepare('SELECT id FROM skus WHERE tenant_id = ? AND active = 1 AND upper(code) = upper(?) LIMIT 2')
    .bind(tenantId, source.sku).all<{ id: string }>();
  if (results.length !== 1) return { eligibility: 'awaiting_sku', matchedSkuId: null };
  return { eligibility: 'ready', matchedSkuId: results[0].id };
}

function publicSource(source: Candidate) {
  return { platform: source.platform, storeKey: source.store_key, orderNo: source.order_no,
    sourceVersion: source.source_version, sourceUpdatedAt: source.source_updated_at, fetchedAt: source.fetched_at,
    sku: source.sku, title: source.title, quantity: source.quantity, currency: source.currency, amountMinor: source.amount_minor };
}

function requireHandoffPermission(user: UserContext, permission: 'orders:read' | 'orders:create') {
  if (user.channelScope) throw new HttpError(403, '当前频道岗位无权办理 ERP 转单', 'PERMISSION_DENIED');
  requirePermission(user, permission);
}

function blocked(eligibility: Exclude<Eligibility, 'ready'>) {
  return new HttpError(409, reasons[eligibility], `NATIVE_HANDOFF_${eligibility.toUpperCase()}`);
}

function sourceChanged() {
  return new HttpError(409, '平台订单或店铺已更新，请重新打开并核对后再转单', 'NATIVE_HANDOFF_SOURCE_CHANGED');
}
