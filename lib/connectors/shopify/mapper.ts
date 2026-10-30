import type {
  CanonicalFulfillment,
  CanonicalOrderGraph,
  CanonicalOrderLine,
  CanonicalRefund,
  CanonicalRefundLine,
  CanonicalTransaction,
} from '../types';
import {
  asRecord,
  booleanOrNull,
  exactMoney,
  integerOrNull,
  normalizeSku,
  requireInteger,
  requireString,
  sourceBusinessDate,
  stringOrNull,
} from '../canonical';

export function mapShopifyOrder(order: Record<string, unknown>, timezone: string): CanonicalOrderGraph {
  const sourceCreatedAt = requireString(order.createdAt, 'order.createdAt');
  const lineItems = connectionNodes(order.lineItems, 'order.lineItems').map(mapLine);
  const refunds = objectArray(order.refunds, 'order.refunds').map(mapRefund);
  const fulfillments = objectArray(order.fulfillments, 'order.fulfillments').map(mapFulfillment);
  const currency = stringOrNull(order.currencyCode)
    ?? exactMoney(order.currentTotalPriceSet)?.currency
    ?? null;
  return {
    platform: 'shopify',
    sourceOrderId: requireString(order.id, 'order.id'),
    sourceOrderName: stringOrNull(order.name),
    sourceCreatedAt,
    sourceUpdatedAt: requireString(order.updatedAt, 'order.updatedAt'),
    sourceProcessedAt: stringOrNull(order.processedAt),
    sourceCancelledAt: stringOrNull(order.cancelledAt),
    sourceClosedAt: stringOrNull(order.closedAt),
    sourceTimezone: timezone,
    businessDate: sourceBusinessDate(sourceCreatedAt, timezone),
    test: booleanOrNull(order.test),
    financialStatus: stringOrNull(order.displayFinancialStatus),
    fulfillmentStatus: stringOrNull(order.displayFulfillmentStatus),
    currency,
    subtotal: exactMoney(order.currentSubtotalPriceSet) ?? exactMoney(order.subtotalPriceSet),
    discount: exactMoney(order.totalDiscountsSet),
    shipping: exactMoney(order.totalShippingPriceSet),
    tax: exactMoney(order.totalTaxSet),
    originalTotal: exactMoney(order.totalPriceSet),
    currentTotal: exactMoney(order.currentTotalPriceSet),
    received: exactMoney(order.totalReceivedSet),
    refunded: exactMoney(order.totalRefundedSet),
    businessOwnership: null,
    lines: lineItems,
    refunds,
    fulfillments,
    raw: order,
  };
}

function mapLine(line: Record<string, unknown>): CanonicalOrderLine {
  const rawSku = stringOrNull(line.sku);
  return {
    sourceLineId: requireString(line.id, 'lineItem.id'),
    rawSku,
    normalizedSku: normalizeSku(rawSku),
    sourceProductId: stringOrNull(asRecord(line.product)?.id),
    sourceVariantId: stringOrNull(asRecord(line.variant)?.id),
    title: stringOrNull(line.title),
    name: stringOrNull(line.name),
    orderedQuantity: requireInteger(line.quantity, 'lineItem.quantity'),
    currentQuantity: integerOrNull(line.currentQuantity),
    unfulfilledQuantity: integerOrNull(line.unfulfilledQuantity),
    unitPrice: exactMoney(line.originalUnitPriceSet),
    originalTotal: exactMoney(line.originalTotalSet),
    discountedTotal: exactMoney(line.discountedTotalSet),
    discount: exactMoney(line.totalDiscountSet),
    raw: line,
  };
}

function mapRefund(refund: Record<string, unknown>): CanonicalRefund {
  const lines = connectionNodes(refund.refundLineItems, 'refund.refundLineItems').map(mapRefundLine);
  const transactions = connectionNodes(refund.transactions, 'refund.transactions').map(mapTransaction);
  return {
    sourceRefundId: requireString(refund.id, 'refund.id'),
    sourceCreatedAt: stringOrNull(refund.createdAt),
    sourceUpdatedAt: stringOrNull(refund.updatedAt),
    note: stringOrNull(refund.note),
    amount: exactMoney(refund.totalRefundedSet),
    lines,
    transactions,
    raw: refund,
  };
}

function mapRefundLine(line: Record<string, unknown>): CanonicalRefundLine {
  return {
    sourceRefundLineId: requireString(line.id, 'refundLineItem.id'),
    sourceOrderLineId: stringOrNull(asRecord(line.lineItem)?.id),
    quantity: requireInteger(line.quantity, 'refundLineItem.quantity'),
    restockType: stringOrNull(line.restockType),
    sourceLocationId: stringOrNull(asRecord(line.location)?.id),
    subtotal: exactMoney(line.subtotalSet),
    tax: exactMoney(line.totalTaxSet),
    raw: line,
  };
}

function mapTransaction(transaction: Record<string, unknown>): CanonicalTransaction {
  return {
    sourceTransactionId: requireString(transaction.id, 'transaction.id'),
    sourceParentTransactionId: stringOrNull(asRecord(transaction.parentTransaction)?.id),
    kind: stringOrNull(transaction.kind),
    status: stringOrNull(transaction.status),
    gateway: stringOrNull(transaction.gateway),
    test: booleanOrNull(transaction.test),
    amount: exactMoney(transaction.amountSet),
    sourceCreatedAt: stringOrNull(transaction.createdAt),
    sourceProcessedAt: stringOrNull(transaction.processedAt),
    raw: transaction,
  };
}

function mapFulfillment(fulfillment: Record<string, unknown>): CanonicalFulfillment {
  const tracking = objectArray(fulfillment.trackingInfo, 'fulfillment.trackingInfo').map((item, index) => ({
    sequence: index,
    company: stringOrNull(item.company),
    number: stringOrNull(item.number),
    url: stringOrNull(item.url),
    raw: item,
  }));
  const lines = connectionNodes(fulfillment.fulfillmentLineItems, 'fulfillment.fulfillmentLineItems').map((line) => ({
    sourceFulfillmentLineId: requireString(line.id, 'fulfillmentLineItem.id'),
    sourceOrderLineId: stringOrNull(asRecord(line.lineItem)?.id),
    quantity: requireInteger(line.quantity, 'fulfillmentLineItem.quantity'),
    raw: line,
  }));
  return {
    sourceFulfillmentId: requireString(fulfillment.id, 'fulfillment.id'),
    status: stringOrNull(fulfillment.status),
    shipmentStatus: stringOrNull(fulfillment.shipmentStatus),
    sourceLocationId: stringOrNull(asRecord(fulfillment.location)?.id),
    sourceCreatedAt: stringOrNull(fulfillment.createdAt),
    sourceUpdatedAt: stringOrNull(fulfillment.updatedAt),
    deliveredAt: stringOrNull(fulfillment.deliveredAt),
    estimatedDeliveryAt: stringOrNull(fulfillment.estimatedDeliveryAt),
    lines,
    tracking,
    raw: fulfillment,
  };
}

function connectionNodes(value: unknown, field: string) {
  const connection = asRecord(value);
  if (!connection || !Array.isArray(connection.nodes)) throw new Error(`INVALID_SHOPIFY_FIELD:${field}`);
  return connection.nodes.map((item) => {
    const record = asRecord(item);
    if (!record) throw new Error(`INVALID_SHOPIFY_FIELD:${field}`);
    return record;
  });
}

function objectArray(value: unknown, field: string) {
  if (!Array.isArray(value)) throw new Error(`INVALID_SHOPIFY_FIELD:${field}`);
  return value.map((item) => {
    const record = asRecord(item);
    if (!record) throw new Error(`INVALID_SHOPIFY_FIELD:${field}`);
    return record;
  });
}
