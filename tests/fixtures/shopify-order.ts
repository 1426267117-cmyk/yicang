import { mapShopifyOrder } from '../../lib/connectors/shopify/mapper';

export function shopifyOrderFixture(overrides: Record<string, unknown> = {}) {
  const raw = {
    id: 'gid://shopify/Order/1001',
    name: '#1001',
    createdAt: '2026-10-20T23:30:00Z',
    updatedAt: '2026-10-21T01:00:00Z',
    processedAt: '2026-10-20T23:31:00Z',
    cancelledAt: null,
    closedAt: null,
    test: false,
    displayFinancialStatus: 'PARTIALLY_REFUNDED',
    displayFulfillmentStatus: 'PARTIALLY_FULFILLED',
    currencyCode: 'USD',
    subtotalPriceSet: money('100.00'),
    currentSubtotalPriceSet: money('80.00'),
    totalDiscountsSet: money('5.00'),
    totalShippingPriceSet: money('10.00'),
    totalTaxSet: money('6.40'),
    totalPriceSet: money('111.40'),
    currentTotalPriceSet: money('91.40'),
    totalRefundedSet: money('20.00'),
    lineItems: {
      nodes: [
        {
          id: 'gid://shopify/LineItem/1', sku: ' ABC-01 ', title: 'Desk', name: 'Desk',
          quantity: 2, currentQuantity: 1, unfulfilledQuantity: 0,
          originalUnitPriceSet: money('50.00'), originalTotalSet: money('100.00'),
          discountedTotalSet: money('95.00'), totalDiscountSet: money('5.00'),
        },
        {
          id: 'gid://shopify/LineItem/2', sku: null, title: 'Service', name: 'Service',
          quantity: 1, currentQuantity: 1, unfulfilledQuantity: 1,
          originalUnitPriceSet: money('0.00'), originalTotalSet: money('0.00'),
          discountedTotalSet: money('0.00'), totalDiscountSet: money('0.00'),
        },
      ],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
    refunds: [{
      id: 'gid://shopify/Refund/1', createdAt: '2026-10-21T00:30:00Z',
      updatedAt: '2026-10-21T00:31:00Z', note: 'partial', totalRefundedSet: money('20.00'),
      refundLineItems: {
        nodes: [{
          id: 'gid://shopify/RefundLineItem/1', quantity: 1, restockType: 'NO_RESTOCK',
          subtotalSet: money('20.00'), totalTaxSet: money('0.00'),
          lineItem: { id: 'gid://shopify/LineItem/1' },
        }],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
      transactions: {
        nodes: [
          {
            id: 'gid://shopify/OrderTransaction/1', kind: 'REFUND', status: 'SUCCESS',
            gateway: 'shopify_payments', createdAt: '2026-10-21T00:30:00Z',
            processedAt: '2026-10-21T00:30:01Z', test: false, amountSet: money('20.00'),
            parentTransaction: { id: 'gid://shopify/OrderTransaction/0' },
          },
          {
            id: 'gid://shopify/OrderTransaction/2', kind: 'REFUND', status: 'FAILURE',
            gateway: 'shopify_payments', createdAt: '2026-10-21T00:32:00Z',
            processedAt: '2026-10-21T00:32:01Z', test: false, amountSet: money('5.00'),
            parentTransaction: { id: 'gid://shopify/OrderTransaction/0' },
          },
        ],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    }],
    fulfillments: [
      {
        id: 'gid://shopify/Fulfillment/1', status: 'SUCCESS', createdAt: '2026-10-21T02:00:00Z',
        updatedAt: '2026-10-21T02:05:00Z', deliveredAt: null, estimatedDeliveryAt: '2026-10-25T00:00:00Z',
        trackingInfo: [{ company: 'UPS', number: '1Z111', url: 'https://example.invalid/1Z111' }],
        fulfillmentLineItems: {
          nodes: [{ id: 'gid://shopify/FulfillmentLineItem/1', quantity: 1, lineItem: { id: 'gid://shopify/LineItem/1' } }],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
      {
        id: 'gid://shopify/Fulfillment/2', status: 'SUCCESS', createdAt: '2026-10-21T03:00:00Z',
        updatedAt: '2026-10-21T03:05:00Z', deliveredAt: null, estimatedDeliveryAt: null,
        trackingInfo: [{ company: 'FedEx', number: 'FX222', url: 'https://example.invalid/FX222' }],
        fulfillmentLineItems: {
          nodes: [{ id: 'gid://shopify/FulfillmentLineItem/2', quantity: 1, lineItem: { id: 'gid://shopify/LineItem/2' } }],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    ],
    ...overrides,
  };
  return mapShopifyOrder(raw, 'America/Los_Angeles');
}

export function money(amount: string, currencyCode = 'USD') {
  return { shopMoney: { amount, currencyCode } };
}
