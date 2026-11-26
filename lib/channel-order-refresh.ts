import { HttpError, requirePermission, type UserContext } from './db';
import { amazonOrdersApiVersion, amazonStoreKeySchema, chooseAmazonStore, type AmazonStoreConfig } from './connectors/amazon/store-settings';
import { createAmazonOrdersSource } from './connectors/amazon/orders';
import { PlatformOrderRepository } from './connectors/repository';
import { ShopifyAdminClient } from './connectors/shopify/client';
import { hasShopifyCredentials, isShopifyStoreKey, SHOPIFY_API_VERSION, type ShopifyStoreKey } from './connectors/shopify/config';
import { resolveShopifyRuntimeConfig } from './connectors/shopify/credential-store';
import { ShopifyOrderConnector } from './connectors/shopify/connector';
import type { CanonicalOrderGraph, OrderConnectorPlatform } from './connectors/types';

type StoredOrder = {
  platform: string;
  store_id: string;
  store_key: string;
  official_store_id: string;
  source_order_id: string;
  source_updated_at: string;
};
type SourceContext = { db: D1Database; user: UserContext; runtimeEnv: Record<string, unknown>; requestUrl: string };
type RefreshDependencies = {
  shopify: (context: SourceContext, store: StoredOrder, key: ShopifyStoreKey) => Promise<CanonicalOrderGraph>;
  amazon: (config: AmazonStoreConfig, orderId: string) => Promise<CanonicalOrderGraph<'amazon'>>;
};

export async function refreshChannelOrder(
  context: SourceContext,
  id: string,
  overrides: Partial<RefreshDependencies> = {},
) {
  const { db, user, runtimeEnv } = context;
  requirePermission(user, 'connectors:sync');
  if (user.channelScope) throw new HttpError(403, '当前账号没有刷新渠道来源的权限', 'PERMISSION_DENIED');
  const stored = await db.prepare(`
    SELECT po.platform, po.platform_store_id AS store_id, po.source_order_id, po.source_updated_at,
      ps.connector_key AS store_key, ps.official_store_id
    FROM platform_orders po
    JOIN platform_stores ps ON ps.id = po.platform_store_id AND ps.tenant_id = po.tenant_id AND ps.platform = po.platform
    WHERE po.tenant_id = ? AND po.id = ? AND COALESCE(po.test, 0) = 0 AND ps.active = 1
  `).bind(user.tenantId, id).first<StoredOrder>();
  if (!stored) throw new HttpError(404, '未找到可刷新的渠道订单', 'CHANNEL_ORDER_NOT_FOUND');

  let graph: CanonicalOrderGraph<OrderConnectorPlatform>;
  let apiVersion: string;
  if (stored.platform === 'shopify' && isShopifyStoreKey(stored.store_key)) {
    graph = await (overrides.shopify ?? fetchShopifyOrder)(context, stored, stored.store_key);
    apiVersion = SHOPIFY_API_VERSION;
  } else if (stored.platform === 'amazon') {
    const key = amazonStoreKeySchema.safeParse(stored.store_key);
    if (!key.success) throw unsupportedSource();
    const config = chooseAmazonStore(runtimeEnv, user.tenantId, key.data);
    if (config.sellerId !== stored.official_store_id) {
      throw new HttpError(409, 'Amazon 授权归属与此订单不一致', 'AMAZON_STORE_BINDING_CONFLICT');
    }
    graph = await (overrides.amazon ?? fetchAmazonOrder)(config, stored.source_order_id);
    apiVersion = amazonOrdersApiVersion;
  } else {
    throw unsupportedSource();
  }
  if (graph.platform !== stored.platform || graph.sourceOrderId !== stored.source_order_id) {
    throw new HttpError(409, '平台返回的订单身份与此记录不一致', 'CHANNEL_ORDER_IDENTITY_MISMATCH');
  }
  const fetchedAt = new Date().toISOString();
  const repository = new PlatformOrderRepository(db, user.tenantId, graph.platform);
  await repository.upsertOrderGraph({ storeId: stored.store_id, graph, apiVersion, runId: null, fetchedAt });
  const updated = await db.prepare('SELECT fetched_at FROM platform_orders WHERE id = ? AND tenant_id = ?')
    .bind(id, user.tenantId).first<{ fetched_at: string }>();
  if (!updated || Date.parse(updated.fetched_at) < Date.parse(fetchedAt)) {
    throw new HttpError(409, '平台返回的是旧版本，请稍后重新刷新来源', 'CHANNEL_ORDER_SOURCE_BEHIND');
  }
  return { refreshedAt: updated.fetched_at };
}

async function fetchShopifyOrder(context: SourceContext, stored: StoredOrder, storeKey: ShopifyStoreKey) {
  const { db, user, runtimeEnv, requestUrl } = context;
  const config = await resolveShopifyRuntimeConfig({ db, tenantId: user.tenantId, runtimeEnv, storeKey, requestUrl });
  if (!hasShopifyCredentials(config)) throw new HttpError(409, '该 Shopify 店铺尚未获得订单读取授权', 'SHOPIFY_AUTHORIZATION_REQUIRED');
  const connector = new ShopifyOrderConnector(config, new ShopifyAdminClient(config));
  const shop = await connector.getShopContext();
  if (shop.id !== stored.official_store_id) {
    throw new HttpError(409, 'Shopify 授权归属与此订单不一致', 'SHOPIFY_IDENTITY_MISMATCH');
  }
  return connector.fetchOrder(stored.source_order_id, shop);
}

async function fetchAmazonOrder(config: AmazonStoreConfig, orderId: string) {
  const source = createAmazonOrdersSource(config);
  await source.verifyOrder(config.verificationOrderId);
  return source.readOrder(orderId);
}

function unsupportedSource() {
  return new HttpError(409, '该来源暂不支持按单刷新', 'CHANNEL_ORDER_REFRESH_UNSUPPORTED');
}
