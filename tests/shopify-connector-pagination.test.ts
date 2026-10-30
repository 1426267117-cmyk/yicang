import { describe, expect, it } from 'vitest';
import { ShopifyAdminClient } from '../lib/connectors/shopify/client';
import { type ShopifyCredentialConfig } from '../lib/connectors/shopify/config';
import { ShopifyOrderConnector } from '../lib/connectors/shopify/connector';
import { money } from './fixtures/shopify-order';

const config: ShopifyCredentialConfig = {
  key: 'zimasya', displayName: 'ZIMASYA', domain: '346c85.myshopify.com',
  expectedDomain: '346c85.myshopify.com', environmentPrefix: 'SHOPIFY_ZIMASYA',
  acceptedDomains: ['346c85.myshopify.com'], authMode: 'oauth', credentialRef: 'env:SHOPIFY_ZIMASYA',
  adminAccessToken: 'test-only-token', clientId: null, clientSecret: null,
};

const truncationCases: Array<[string, (order: ReturnType<typeof baseOrder>) => void]> = [
  ['退款对象', (order) => {
    order.refunds = Array.from({ length: 250 }, (_, index) => ({
      ...order.refunds[0], id: `gid://shopify/Refund/${index + 1}`,
    }));
  }],
  ['履约对象', (order) => {
    order.fulfillments = Array.from({ length: 250 }, (_, index) => ({
      ...order.fulfillments[0], id: `gid://shopify/Fulfillment/${index + 1}`,
    }));
  }],
  ['追踪号', (order) => {
    order.fulfillments[0].trackingInfo = Array.from({ length: 100 }, (_, index) => ({
      company: 'UPS', number: `TRACK-${index + 1}`, url: null,
    }));
  }],
];

describe('Shopify 多层分页', () => {
  it('补齐订单行、退款行、退款交易和履约行的后续页', async () => {
    const operations: string[] = [];
    const fakeFetch: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
      const operation = body.query.match(/query\s+(\w+)/)?.[1] ?? 'unknown';
      operations.push(operation);
      const data = responseFor(operation, body.variables);
      return new Response(JSON.stringify({ data }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const client = new ShopifyAdminClient(config, fakeFetch, async () => undefined, () => 0);
    const connector = new ShopifyOrderConnector(config, client);
    const context = await connector.getShopContext();
    const order = await connector.fetchOrder('gid://shopify/Order/1001', context);

    expect(order.lines.map((item) => item.sourceLineId)).toEqual(['gid://shopify/LineItem/1', 'gid://shopify/LineItem/2']);
    expect(order.refunds[0].lines).toHaveLength(2);
    expect(order.refunds[0].transactions).toHaveLength(2);
    expect(order.fulfillments[0].lines).toHaveLength(2);
    expect(operations).toContain('ErpOrderLineItemsPage');
    expect(operations).toContain('ErpRefundDetailsPage');
    expect(operations).toContain('ErpFulfillmentLinesPage');
  });

  it.each(truncationCases)('%s达到单次读取上限时拒绝把截断响应写成完整订单', async (_label, mutate) => {
    const rawOrder = baseOrder();
    mutate(rawOrder);
    const fakeFetch: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { query: string };
      const operation = body.query.match(/query\s+(\w+)/)?.[1] ?? 'unknown';
      const data = operation === 'ErpShopContext'
        ? responseFor(operation, {})
        : operation === 'ErpOrderDetails'
          ? { order: rawOrder }
          : (() => { throw new Error(`Unexpected operation: ${operation}`); })();
      return new Response(JSON.stringify({ data }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const client = new ShopifyAdminClient(config, fakeFetch, async () => undefined, () => 0);
    const connector = new ShopifyOrderConnector(config, client);
    const context = await connector.getShopContext();
    await expect(connector.fetchOrder('gid://shopify/Order/1001', context))
      .rejects.toMatchObject({ code: 'SHOPIFY_INCOMPLETE_ORDER_RESPONSE' });
  });
});

function responseFor(operation: string, variables: Record<string, unknown>): Record<string, unknown> {
  if (operation === 'ErpShopContext') return {
    shop: { id: 'gid://shopify/Shop/1', name: 'ZIMASYA', myshopifyDomain: '346c85.myshopify.com', ianaTimezone: 'America/Los_Angeles', timezoneOffset: '-0700', currencyCode: 'USD' },
    currentAppInstallation: { accessScopes: [{ handle: 'read_orders' }, { handle: 'read_all_orders' }] },
  };
  if (operation === 'ErpOrderDetails') return { order: baseOrder() };
  if (operation === 'ErpOrderLineItemsPage') return { order: {
    id: variables.id,
    lineItems: { nodes: [line('gid://shopify/LineItem/2')], pageInfo: { hasNextPage: false, endCursor: null } },
  } };
  if (operation === 'ErpRefundDetailsPage') return { refund: {
    id: variables.id,
    refundLineItems: { nodes: [{ id: 'gid://shopify/RefundLineItem/2', quantity: 1, restockType: 'NO_RESTOCK', subtotalSet: money('2.00'), totalTaxSet: money('0.00'), lineItem: { id: 'gid://shopify/LineItem/2' } }], pageInfo: { hasNextPage: false, endCursor: null } },
    transactions: { nodes: [{ id: 'gid://shopify/OrderTransaction/2', kind: 'REFUND', status: 'FAILURE', gateway: 'test', createdAt: '2026-10-21T00:00:00Z', processedAt: null, test: true, amountSet: money('2.00'), parentTransaction: null }], pageInfo: { hasNextPage: false, endCursor: null } },
  } };
  if (operation === 'ErpFulfillmentLinesPage') return { fulfillment: {
    id: variables.id,
    fulfillmentLineItems: { nodes: [{ id: 'gid://shopify/FulfillmentLineItem/2', quantity: 1, lineItem: { id: 'gid://shopify/LineItem/2' } }], pageInfo: { hasNextPage: false, endCursor: null } },
  } };
  throw new Error(`Unexpected operation: ${operation}`);
}

function baseOrder() {
  return {
    id: 'gid://shopify/Order/1001', name: '#1001', createdAt: '2026-10-20T23:30:00Z', updatedAt: '2026-10-21T01:00:00Z',
    processedAt: null, cancelledAt: null, closedAt: null, test: false,
    displayFinancialStatus: 'PENDING', displayFulfillmentStatus: 'PARTIALLY_FULFILLED', currencyCode: 'USD',
    subtotalPriceSet: money('4.00'), currentSubtotalPriceSet: money('4.00'), totalDiscountsSet: money('0.00'),
    totalShippingPriceSet: money('0.00'), totalTaxSet: money('0.00'), totalPriceSet: money('4.00'),
    currentTotalPriceSet: money('4.00'), totalReceivedSet: money('0.00'), totalRefundedSet: money('2.00'),
    lineItems: { nodes: [line('gid://shopify/LineItem/1')], pageInfo: { hasNextPage: true, endCursor: 'line-cursor-1' } },
    refunds: [{
      id: 'gid://shopify/Refund/1', createdAt: '2026-10-21T00:00:00Z', updatedAt: '2026-10-21T00:01:00Z', note: null, totalRefundedSet: money('2.00'),
      refundLineItems: { nodes: [{ id: 'gid://shopify/RefundLineItem/1', quantity: 1, restockType: 'NO_RESTOCK', subtotalSet: money('2.00'), totalTaxSet: money('0.00'), lineItem: { id: 'gid://shopify/LineItem/1' } }], pageInfo: { hasNextPage: true, endCursor: 'refund-line-cursor-1' } },
      transactions: { nodes: [{ id: 'gid://shopify/OrderTransaction/1', kind: 'REFUND', status: 'SUCCESS', gateway: 'test', createdAt: '2026-10-21T00:00:00Z', processedAt: null, test: true, amountSet: money('2.00'), parentTransaction: null }], pageInfo: { hasNextPage: true, endCursor: 'transaction-cursor-1' } },
    }],
    fulfillments: [{
      id: 'gid://shopify/Fulfillment/1', status: 'SUCCESS', createdAt: '2026-10-21T02:00:00Z', updatedAt: '2026-10-21T02:01:00Z',
      deliveredAt: null, estimatedDeliveryAt: null, trackingInfo: [{ company: 'UPS', number: 'TRACK1', url: null }],
      fulfillmentLineItems: { nodes: [{ id: 'gid://shopify/FulfillmentLineItem/1', quantity: 1, lineItem: { id: 'gid://shopify/LineItem/1' } }], pageInfo: { hasNextPage: true, endCursor: 'fulfillment-line-cursor-1' } },
    }],
  };
}

function line(id: string) {
  return {
    id, sku: id.endsWith('/1') ? 'SKU-1' : 'SKU-2', title: 'Item', name: 'Item', quantity: 1,
    currentQuantity: 1, unfulfilledQuantity: 0, originalUnitPriceSet: money('2.00'),
    originalTotalSet: money('2.00'), discountedTotalSet: money('2.00'), totalDiscountSet: money('0.00'),
  };
}
