import { z } from 'zod';
import { asRecord, decimalToMinor, normalizeDecimal, normalizeSku, stringOrNull } from '../canonical';
import type { CanonicalOrderGraph, CanonicalOrderLine, ExactMoney } from '../types';
import { AmazonConnectorError } from './errors';

export type AmazonOrderGraph = CanonicalOrderGraph<'amazon'>;

const amazonTimestamp = z.iso.datetime({ offset: true });
export const amazonOrderId = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/u;

export function parseAmazonTime(value: unknown) {
  if (typeof value !== 'string' || value.length > 45 || !amazonTimestamp.safeParse(value).success) return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function amazonMoney(value: unknown): ExactMoney | null {
  const money = asRecord(value);
  const amount = typeof money?.amount === 'string' && money.amount.length <= 120 ? normalizeDecimal(money.amount) : null;
  const currency = typeof money?.currencyCode === 'string' && /^[A-Z]{3}$/u.test(money.currencyCode) ? money.currencyCode : null;
  return amount !== null && currency !== null ? { amount, currency, minor: decimalToMinor(amount, currency) } : null;
}

function nonnegativeInteger(value: unknown) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function mapLine(value: unknown): CanonicalOrderLine {
  const line = asRecord(value);
  const sourceLineId = stringOrNull(line?.orderItemId);
  const orderedQuantity = nonnegativeInteger(line?.quantityOrdered);
  if (!sourceLineId || sourceLineId.trim() !== sourceLineId || sourceLineId.length > 160 || orderedQuantity === null) {
    throw new AmazonConnectorError('AMAZON_INVALID_RESPONSE');
  }
  const product = asRecord(line?.product);
  const fulfillment = asRecord(line?.fulfillment);
  const rawSku = stringOrNull(product?.sellerSku);
  const asin = stringOrNull(product?.asin);
  const title = stringOrNull(product?.title);
  const unitPrice = amazonMoney(asRecord(product?.price)?.unitPrice);
  const unfulfilledQuantity = nonnegativeInteger(fulfillment?.quantityUnfulfilled);
  return {
    sourceLineId, rawSku, normalizedSku: normalizeSku(rawSku), sourceProductId: asin, sourceVariantId: null,
    title, name: null, orderedQuantity, currentQuantity: null, unfulfilledQuantity,
    unitPrice, originalTotal: null, discountedTotal: null, discount: null,
    raw: {
      orderItemId: sourceLineId, quantityOrdered: orderedQuantity,
      product: { asin, title, sellerSku: rawSku, price: { unitPrice } },
      fulfillment: { quantityUnfulfilled: unfulfilledQuantity, quantityFulfilled: nonnegativeInteger(fulfillment?.quantityFulfilled) },
      proceeds: { proceedsTotal: amazonMoney(asRecord(line?.proceeds)?.proceedsTotal) },
    },
  };
}

export function mapAmazonOrder(value: unknown, marketplaceId: string): AmazonOrderGraph {
  const order = asRecord(value);
  const sourceOrderId = stringOrNull(order?.orderId);
  const createdAt = parseAmazonTime(order?.createdTime);
  const updatedAt = parseAmazonTime(order?.lastUpdatedTime);
  if (!sourceOrderId || !amazonOrderId.test(sourceOrderId) || createdAt === null || updatedAt === null || !Array.isArray(order?.orderItems)) {
    throw new AmazonConnectorError('AMAZON_INVALID_RESPONSE');
  }
  const channel = asRecord(order.salesChannel);
  if (channel?.marketplaceId !== marketplaceId) throw new AmazonConnectorError('AMAZON_ORDER_MARKETPLACE_MISMATCH');
  const lines = order.orderItems.map(mapLine);
  if (new Set(lines.map((line) => line.sourceLineId)).size !== lines.length) throw new AmazonConnectorError('AMAZON_INVALID_RESPONSE');
  const fulfillment = asRecord(order.fulfillment);
  const proceeds = asRecord(order.proceeds);
  const currentTotal = amazonMoney(proceeds?.grandTotal);
  const fulfillmentStatus = stringOrNull(fulfillment?.fulfillmentStatus);
  return {
    platform: 'amazon', sourceOrderId, sourceOrderName: sourceOrderId,
    sourceCreatedAt: new Date(createdAt).toISOString(), sourceUpdatedAt: new Date(updatedAt).toISOString(),
    sourceProcessedAt: null, sourceCancelledAt: null, sourceClosedAt: null, sourceTimezone: null, businessDate: null,
    test: null, financialStatus: null, fulfillmentStatus, currency: currentTotal?.currency ?? null,
    subtotal: null, discount: null, shipping: null, tax: null, originalTotal: null, currentTotal,
    received: null, refunded: null, businessOwnership: null, lines, refunds: [], fulfillments: [],
    raw: {
      orderId: sourceOrderId, createdTime: order.createdTime, lastUpdatedTime: order.lastUpdatedTime,
      salesChannel: { marketplaceId, channelName: stringOrNull(channel?.channelName) },
      fulfillment: { fulfillmentStatus, fulfilledBy: stringOrNull(fulfillment?.fulfilledBy) },
      proceeds: { grandTotal: currentTotal }, orderItems: lines.map((line) => line.raw),
    },
  };
}
