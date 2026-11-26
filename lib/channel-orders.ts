import { z } from 'zod';
import { cancelledFulfillmentStatuses, completedFulfillmentStatuses, pendingFulfillmentStatuses } from './channel-order-status';
import { HttpError, requirePermission, type UserContext } from './db';

const platforms = ['shopify', 'amazon', 'wayfair', 'yqn'] as const;
export const channelOrderStatuses = ['all', 'pending', 'fulfilled', 'cancelled', 'refund'] as const;
export type ChannelOrderStatus = (typeof channelOrderStatuses)[number];

export const channelOrderListQuerySchema = z.strictObject({
  status: z.enum(channelOrderStatuses).default('all'),
  store: z.string().regex(/^(shopify|amazon|wayfair|yqn)\/[A-Za-z0-9_.-]{1,100}$/u).optional(),
  q: z.string().trim().max(160).default(''),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
}).refine(({ from, to }) => !from || !to || from <= to);

export const channelOrderIdSchema = z.string().min(1).max(180);

type ChannelOrderRow = {
  id: string; platform: string; source_order_id: string; source_order_name: string | null;
  source_created_at: string; source_updated_at: string; source_cancelled_at: string | null;
  test: number | null; financial_status: string | null; fulfillment_status: string | null;
  currency: string | null; current_total_amount: string | null; current_total_minor: number | null;
  refunded_amount: string | null; refunded_minor: number | null; business_ownership: string | null;
  api_version: string; connector_key: string; store_name: string; line_count: number;
  refund_count: number; fulfillment_count: number;
};

const source = `
  FROM platform_orders po
  JOIN platform_stores ps ON ps.id = po.platform_store_id AND ps.tenant_id = po.tenant_id AND ps.platform = po.platform
`;
const selectOrder = `
  SELECT po.id, po.platform, po.source_order_id, po.source_order_name,
         po.source_created_at, po.source_updated_at, po.source_cancelled_at, po.test,
         po.financial_status, po.fulfillment_status, po.currency, po.current_total_amount,
         po.current_total_minor, po.refunded_amount, po.refunded_minor, po.business_ownership,
         po.api_version, ps.connector_key, ps.display_name AS store_name,
         (SELECT COUNT(*) FROM platform_order_lines l INDEXED BY idx_platform_order_lines_order
           WHERE l.tenant_id = po.tenant_id AND l.order_id = po.id AND l.is_current = 1) AS line_count,
         (SELECT COUNT(*) FROM platform_refunds r INDEXED BY idx_platform_refunds_order
           WHERE r.tenant_id = po.tenant_id AND r.order_id = po.id AND r.is_current = 1) AS refund_count,
         (SELECT COUNT(*) FROM platform_fulfillments f INDEXED BY idx_platform_fulfillments_order
           WHERE f.tenant_id = po.tenant_id AND f.order_id = po.id AND f.is_current = 1) AS fulfillment_count
  ${source}
`;

function statuses(values: readonly string[]) {
  return `(${values.map((value) => `'${value}'`).join(', ')})`;
}

const cancelled = `(NULLIF(po.source_cancelled_at, '') IS NOT NULL OR
  COALESCE(po.fulfillment_status, '') IN ${statuses(cancelledFulfillmentStatuses)})`;
const statusPredicate = {
  pending: `NOT ${cancelled} AND po.fulfillment_status IN ${statuses(pendingFulfillmentStatuses)}`,
  fulfilled: `NOT ${cancelled} AND po.fulfillment_status IN ${statuses(completedFulfillmentStatuses)}`,
  cancelled,
};
const orderByUpdated = 'ORDER BY po.source_updated_at DESC, po.id DESC';

function mapOrder(row: ChannelOrderRow) {
  return {
    id: row.id,
    platform: row.platform,
    storeKey: row.connector_key,
    storeName: row.store_name,
    sourceOrderId: row.source_order_id,
    sourceOrderName: row.source_order_name,
    sourceCreatedAt: row.source_created_at,
    sourceUpdatedAt: row.source_updated_at,
    sourceCancelledAt: row.source_cancelled_at || null,
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
  };
}

export type ChannelOrder = ReturnType<typeof mapOrder>;
export type ChannelOrderStore = { platform: string; key: string; label: string };
type ChannelListFilter = z.infer<typeof channelOrderListQuerySchema>;

export function canReadChannelOrders(user: UserContext) {
  return user.permissions.includes(user.channelScope ? 'channels:read' : 'orders:read');
}

function requireChannelRead(user: UserContext) {
  requirePermission(user, user.channelScope ? 'channels:read' : 'orders:read');
}

function scopeFor(user: UserContext) {
  return {
    clauses: ['po.tenant_id = ?', ...(user.channelScope ? ['po.platform = ?'] : [])],
    params: [user.tenantId, ...(user.channelScope ? [user.channelScope] : [])],
  };
}

export async function readChannelOrderPreview(db: D1Database, user: UserContext) {
  requireChannelRead(user);
  const { clauses, params } = scopeFor(user);
  const rows = await channelOrderPage(db, `WHERE ${clauses.join(' AND ')}`, params, 100, 0).all<ChannelOrderRow>();
  return rows.results.map(mapOrder);
}

function channelOrderPage(db: D1Database, where: string, params: string[], limit: number, offset: number) {
  // Limit the order IDs before looking up line, refund, and fulfillment counts.
  return db.prepare(`${selectOrder} WHERE po.id IN (
    SELECT po.id ${source} ${where} ${orderByUpdated} LIMIT ? OFFSET ?
  ) ${orderByUpdated}`).bind(...params, limit, offset);
}

export async function listChannelOrders(db: D1Database, user: UserContext, filter: ChannelListFilter) {
  requireChannelRead(user);
  const pageSize = 30;
  const { clauses, params } = scopeFor(user);
  clauses.push('COALESCE(po.test, 0) = 0');
  if (filter.store) {
    const [platform, key] = filter.store.split('/');
    if (user.channelScope && user.channelScope !== platform) {
      throw new HttpError(403, '当前账号仅可查看所属渠道', 'PERMISSION_DENIED');
    }
    clauses.push('po.platform = ? AND ps.connector_key = ?');
    params.push(platform, key);
  }
  if (filter.status === 'refund') {
    clauses.push('po.id IN (SELECT order_id FROM platform_refunds WHERE tenant_id = ? AND is_current = 1)');
    params.push(user.tenantId);
  } else if (filter.status !== 'all') {
    clauses.push(statusPredicate[filter.status]);
  }
  if (filter.q) {
    const fields = ['po.source_order_name', 'po.source_order_id', 'ps.display_name', 'ps.connector_key', 'po.financial_status', 'po.fulfillment_status'];
    clauses.push(`(${fields.map((field) => `instr(lower(${field}), lower(?)) > 0`).join(' OR ')}
      OR po.id IN (SELECT line.order_id FROM platform_order_lines line
        WHERE line.tenant_id = ? AND line.is_current = 1
          AND (instr(lower(line.raw_sku), lower(?)) > 0 OR instr(lower(line.title), lower(?)) > 0)))`);
    params.push(...fields.map(() => filter.q), user.tenantId, filter.q, filter.q);
  }
  if (filter.from) {
    clauses.push('po.source_created_at >= ?');
    params.push(chinaMidnight(filter.from).toISOString());
  }
  if (filter.to) {
    clauses.push('po.source_created_at < ?');
    params.push(new Date(chinaMidnight(filter.to).valueOf() + 86_400_000).toISOString());
  }
  const where = `WHERE ${clauses.join(' AND ')}`;
  type CountRow = { total: number };
  const [orders, count, stores] = await db.batch<ChannelOrderRow | CountRow | ChannelOrderStore>([
    channelOrderPage(db, where, params, pageSize, (filter.page - 1) * pageSize),
    db.prepare(`SELECT COUNT(*) AS total ${source} ${where}`).bind(...params),
    db.prepare(`SELECT platform, connector_key AS key, display_name AS label FROM platform_stores
      WHERE tenant_id = ? AND platform IN (${platforms.map(() => '?').join(', ')})
        ${user.channelScope ? 'AND platform = ?' : ''}
      ORDER BY platform, display_name, connector_key`)
      .bind(user.tenantId, ...platforms, ...(user.channelScope ? [user.channelScope] : [])),
  ]);
  return {
    orders: (orders.results as ChannelOrderRow[]).map(mapOrder),
    total: Number((count.results[0] as CountRow).total),
    pageSize,
    stores: stores.results as ChannelOrderStore[],
  };
}

function chinaMidnight(date: string) {
  return new Date(`${date}T00:00:00+08:00`);
}

type LineRow = {
  id: string; rawSku: string | null; title: string | null; skuCode: string | null;
  orderedQuantity: number; currentQuantity: number | null; unfulfilledQuantity: number | null;
  currency: string | null; unitPriceAmount: string | null;
};
type RefundRow = { id: string; createdAt: string | null; currency: string | null; amount: string | null };
type FulfillmentRow = {
  id: string; status: string | null; shipmentStatus: string | null;
  updatedAt: string | null; deliveredAt: string | null;
};
type TrackingRow = { id: string; fulfillmentId: string; company: string | null; trackingNumber: string | null };
const detailRowLimit = 250;

export async function getChannelOrder(db: D1Database, user: UserContext, id: string) {
  requireChannelRead(user);
  const { clauses, params } = scopeFor(user);
  const where = `WHERE ${clauses.join(' AND ')} AND po.id = ? AND COALESCE(po.test, 0) = 0`;
  const child = `WHERE row.tenant_id = ? AND row.order_id IN (SELECT po.id ${source} ${where}) AND row.is_current = 1`;
  const values = [user.tenantId, ...params, id, detailRowLimit];
  const [order, lines, refunds, fulfillments, tracking] = await db.batch<ChannelOrderRow | LineRow | RefundRow | FulfillmentRow | TrackingRow>([
    db.prepare(`${selectOrder} ${where}`).bind(...params, id),
    db.prepare(`SELECT row.id, row.raw_sku AS rawSku, COALESCE(row.title, row.name) AS title,
        s.code AS skuCode, row.ordered_quantity AS orderedQuantity, row.current_quantity AS currentQuantity,
        row.unfulfilled_quantity AS unfulfilledQuantity, row.currency, row.unit_price_amount AS unitPriceAmount
      FROM platform_order_lines row LEFT JOIN skus s ON s.id = row.mapped_sku_id AND s.tenant_id = row.tenant_id
      ${child} ORDER BY row.id LIMIT ?`).bind(...values),
    db.prepare(`SELECT row.id, row.source_created_at AS createdAt, row.currency, row.amount
      FROM platform_refunds row ${child} ORDER BY row.source_created_at DESC, row.id LIMIT ?`).bind(...values),
    db.prepare(`SELECT row.id, row.status, row.shipment_status AS shipmentStatus, row.source_updated_at AS updatedAt,
        row.delivered_at AS deliveredAt FROM platform_fulfillments row
      ${child} ORDER BY row.source_updated_at DESC, row.id LIMIT ?`).bind(...values),
    db.prepare(`SELECT row.id, row.fulfillment_id AS fulfillmentId, row.company, row.tracking_number AS trackingNumber
      FROM platform_fulfillment_tracking row JOIN platform_fulfillments f
        ON f.id = row.fulfillment_id AND f.tenant_id = row.tenant_id AND f.order_id = row.order_id AND f.is_current = 1
      ${child} ORDER BY row.fulfillment_id, row.sequence, row.id LIMIT ?`).bind(...values.slice(0, -1), detailRowLimit + 1),
  ]);
  const found = order.results[0] as ChannelOrderRow | undefined;
  if (!found) throw new HttpError(404, '未找到渠道订单', 'CHANNEL_ORDER_NOT_FOUND');
  return {
    order: mapOrder(found),
    lines: lines.results as LineRow[],
    refunds: refunds.results as RefundRow[],
    fulfillments: fulfillments.results as FulfillmentRow[],
    tracking: tracking.results.slice(0, detailRowLimit) as TrackingRow[],
    trackingLimited: tracking.results.length > detailRowLimit,
  };
}

export type ChannelOrderDetails = Awaited<ReturnType<typeof getChannelOrder>>;
export type ChannelOrderList = Awaited<ReturnType<typeof listChannelOrders>>;
