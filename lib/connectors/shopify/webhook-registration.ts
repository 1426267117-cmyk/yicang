import { ShopifyAdminClient } from './client';
import type { ShopifyStoreKey } from './config';
import { ShopifyConnectorError } from './errors';

const subscriptionsQuery = `#graphql
  query ErpWebhookSubscriptions($first: Int!) {
    webhookSubscriptions(first: $first) {
      nodes { id topic uri includeFields }
      pageInfo { hasNextPage }
    }
  }
`;

const createSubscriptionMutation = `#graphql
  mutation ErpWebhookSubscriptionCreate(
    $topic: WebhookSubscriptionTopic!
    $subscription: WebhookSubscriptionInput!
  ) {
    webhookSubscriptionCreate(topic: $topic, webhookSubscription: $subscription) {
      webhookSubscription { id topic uri includeFields }
      userErrors { field message }
    }
  }
`;

const updateSubscriptionMutation = `#graphql
  mutation ErpWebhookSubscriptionUpdate(
    $id: ID!
    $subscription: WebhookSubscriptionInput!
  ) {
    webhookSubscriptionUpdate(id: $id, webhookSubscription: $subscription) {
      webhookSubscription { id topic uri includeFields }
      userErrors { field message }
    }
  }
`;

export const SHOPIFY_ERP_WEBHOOK_SUBSCRIPTIONS = [
  { topic: 'ORDERS_CREATE', includeFields: ['id', 'admin_graphql_api_id'] },
  { topic: 'ORDERS_UPDATED', includeFields: ['id', 'admin_graphql_api_id'] },
  { topic: 'ORDERS_CANCELLED', includeFields: ['id', 'admin_graphql_api_id'] },
  { topic: 'REFUNDS_CREATE', includeFields: ['order_id'] },
] as const;

type WebhookSubscriptionNode = {
  id: string;
  topic: string;
  uri: string;
  includeFields: string[] | null;
};

type GraphqlClient = Pick<ShopifyAdminClient, 'graphql'>;

export async function ensureShopifyOrderWebhookSubscriptions(input: {
  client: GraphqlClient;
  storeKey: ShopifyStoreKey;
  requestUrl: string;
}) {
  const callbackUri = webhookCallbackUri(input.requestUrl, input.storeKey);
  const existing = await listSubscriptions(input.client);
  const stats = { created: 0, updated: 0, unchanged: 0 };

  for (const desired of SHOPIFY_ERP_WEBHOOK_SUBSCRIPTIONS) {
    const candidate = existing.find((item) => item.topic === desired.topic && item.uri === callbackUri);
    if (!candidate) {
      await createSubscription(input.client, desired.topic, callbackUri, [...desired.includeFields]);
      stats.created += 1;
      continue;
    }
    if (candidate.uri === callbackUri && sameFields(candidate.includeFields, desired.includeFields)) {
      stats.unchanged += 1;
      continue;
    }
    await updateSubscription(input.client, candidate.id, callbackUri, [...desired.includeFields]);
    stats.updated += 1;
  }

  return { callbackUri, ...stats };
}

function webhookCallbackUri(requestUrl: string, storeKey: ShopifyStoreKey) {
  const uri = new URL(`/api/connectors/shopify/webhooks/${encodeURIComponent(storeKey)}`, requestUrl);
  if (uri.protocol !== 'https:' && uri.hostname !== 'localhost' && uri.hostname !== '127.0.0.1') {
    throw new ShopifyConnectorError(
      'SHOPIFY_WEBHOOK_CALLBACK_INSECURE',
      'Shopify webhook 回调必须使用 HTTPS',
    );
  }
  uri.username = '';
  uri.password = '';
  uri.search = '';
  uri.hash = '';
  return uri.toString();
}

async function listSubscriptions(client: GraphqlClient) {
  const data = await client.graphql<{
    webhookSubscriptions?: {
      nodes?: WebhookSubscriptionNode[];
      pageInfo?: { hasNextPage?: boolean };
    };
  }>(subscriptionsQuery, { first: 250 });
  const connection = data.webhookSubscriptions;
  if (!connection || !Array.isArray(connection.nodes)) {
    throw new ShopifyConnectorError(
      'SHOPIFY_WEBHOOK_SUBSCRIPTIONS_INVALID',
      'Shopify webhook 订阅列表响应无效',
    );
  }
  if (connection.pageInfo?.hasNextPage) {
    throw new ShopifyConnectorError(
      'SHOPIFY_WEBHOOK_SUBSCRIPTIONS_LIMIT',
      'Shopify webhook 订阅超过单次安全核验上限',
    );
  }
  return connection.nodes;
}

async function createSubscription(
  client: GraphqlClient,
  topic: string,
  uri: string,
  includeFields: string[],
) {
  const data = await client.graphql<{
    webhookSubscriptionCreate?: {
      webhookSubscription?: { id?: string } | null;
      userErrors?: Array<{ message?: string }>;
    };
  }>(createSubscriptionMutation, {
    topic,
    subscription: { uri, format: 'JSON', includeFields },
  });
  assertMutationSucceeded(
    data.webhookSubscriptionCreate,
    'SHOPIFY_WEBHOOK_SUBSCRIPTION_CREATE_FAILED',
  );
}

async function updateSubscription(
  client: GraphqlClient,
  id: string,
  uri: string,
  includeFields: string[],
) {
  const data = await client.graphql<{
    webhookSubscriptionUpdate?: {
      webhookSubscription?: { id?: string } | null;
      userErrors?: Array<{ message?: string }>;
    };
  }>(updateSubscriptionMutation, {
    id,
    subscription: { uri, format: 'JSON', includeFields },
  });
  assertMutationSucceeded(
    data.webhookSubscriptionUpdate,
    'SHOPIFY_WEBHOOK_SUBSCRIPTION_UPDATE_FAILED',
  );
}

function assertMutationSucceeded(
  payload: {
    webhookSubscription?: { id?: string } | null;
    userErrors?: Array<{ message?: string }>;
  } | undefined,
  code: string,
) {
  if (!payload || !payload.userErrors) {
    throw new ShopifyConnectorError(code, 'Shopify webhook 订阅响应不完整');
  }
  if (payload.userErrors.length > 0) {
    throw new ShopifyConnectorError(code, 'Shopify 拒绝了 ERP webhook 订阅配置');
  }
  if (!payload.webhookSubscription?.id) {
    throw new ShopifyConnectorError(code, 'Shopify webhook 订阅结果缺少订阅标识');
  }
}

function sameFields(actual: string[] | null, expected: readonly string[]) {
  if (!actual) return false;
  return [...actual].sort().join('\u0000') === [...expected].sort().join('\u0000');
}
