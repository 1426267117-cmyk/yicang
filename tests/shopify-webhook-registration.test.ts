import { describe, expect, it } from 'vitest';
import {
  ensureShopifyOrderWebhookSubscriptions,
  SHOPIFY_ERP_WEBHOOK_SUBSCRIPTIONS,
} from '../lib/connectors/shopify/webhook-registration';

describe('Shopify webhook 订阅注册', () => {
  it('首次授权创建四个最小字段订阅', async () => {
    const calls: Array<{ query: string; variables?: Record<string, unknown> }> = [];
    const client = fakeClient(calls, []);
    const result = await ensureShopifyOrderWebhookSubscriptions({
      client,
      storeKey: 'bizfurniz',
      requestUrl: 'https://erp.example/api/connectors/shopify/oauth/bizfurniz/callback',
    });

    expect(result).toMatchObject({ created: 4, updated: 0, unchanged: 0 });
    const mutations = calls.filter((call) => call.query.includes('webhookSubscriptionCreate'));
    expect(mutations).toHaveLength(4);
    expect(mutations.map((call) => call.variables)).toEqual(
      SHOPIFY_ERP_WEBHOOK_SUBSCRIPTIONS.map((subscription) => ({
        topic: subscription.topic,
        subscription: {
          uri: 'https://erp.example/api/connectors/shopify/webhooks/bizfurniz',
          format: 'JSON',
          includeFields: [...subscription.includeFields],
        },
      })),
    );
  });

  it('相同订阅不重复创建，字段过宽时收敛更新', async () => {
    const calls: Array<{ query: string; variables?: Record<string, unknown> }> = [];
    const uri = 'https://erp.example/api/connectors/shopify/webhooks/bizfurniz';
    const client = fakeClient(calls, [
      { id: 'wh1', topic: 'ORDERS_CREATE', uri, includeFields: ['id', 'admin_graphql_api_id'] },
      { id: 'wh2', topic: 'ORDERS_UPDATED', uri, includeFields: null },
      { id: 'wh3', topic: 'ORDERS_CANCELLED', uri, includeFields: ['admin_graphql_api_id', 'id'] },
      { id: 'wh4', topic: 'REFUNDS_CREATE', uri, includeFields: ['order_id', 'admin_graphql_api_id'] },
    ]);
    const result = await ensureShopifyOrderWebhookSubscriptions({
      client,
      storeKey: 'bizfurniz',
      requestUrl: 'https://erp.example/callback',
    });
    expect(result).toMatchObject({ created: 0, updated: 2, unchanged: 2 });
    const updates = calls.filter((call) => call.query.includes('webhookSubscriptionUpdate'));
    expect(updates).toHaveLength(2);
    expect(updates[0]?.variables).toMatchObject({
      id: 'wh2',
      subscription: { includeFields: ['id', 'admin_graphql_api_id'] },
    });
    expect(updates[1]?.variables).toMatchObject({
      id: 'wh4',
      subscription: { includeFields: ['order_id'] },
    });
  });

  it('不覆盖同主题的其他回调地址', async () => {
    const calls: Array<{ query: string; variables?: Record<string, unknown> }> = [];
    const client = fakeClient(calls, [{
      id: 'other-uri',
      topic: 'ORDERS_CREATE',
      uri: 'https://other.example/webhooks/orders',
      includeFields: ['id', 'admin_graphql_api_id'],
    }]);
    const result = await ensureShopifyOrderWebhookSubscriptions({
      client,
      storeKey: 'bizfurniz',
      requestUrl: 'https://erp.example/callback',
    });
    expect(result).toMatchObject({ created: 4, updated: 0, unchanged: 0 });
    expect(calls.some((call) => call.query.includes('webhookSubscriptionUpdate'))).toBe(false);
  });
});

function fakeClient(
  calls: Array<{ query: string; variables?: Record<string, unknown> }>,
  nodes: Array<{ id: string; topic: string; uri: string; includeFields: string[] | null }>,
) {
  return {
    async graphql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
      calls.push({ query, variables });
      if (query.includes('query ErpWebhookSubscriptions')) {
        return {
          webhookSubscriptions: { nodes, pageInfo: { hasNextPage: false } },
        } as T;
      }
      if (query.includes('webhookSubscriptionCreate')) {
        return { webhookSubscriptionCreate: { webhookSubscription: { id: 'created' }, userErrors: [] } } as T;
      }
      if (query.includes('webhookSubscriptionUpdate')) {
        return { webhookSubscriptionUpdate: { webhookSubscription: { id: 'updated' }, userErrors: [] } } as T;
      }
      throw new Error('Unexpected query');
    },
  };
}
