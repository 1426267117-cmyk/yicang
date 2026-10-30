import { cfWorkerAdapterInitialized } from '@shopify/shopify-api/adapters/cf-worker';
import { ApiVersion, LogSeverity, shopifyApi } from '@shopify/shopify-api';
import type { ShopifyCredentialConfig } from './config';
import { ShopifyConnectorError } from './errors';

export const SHOPIFY_ORDER_READ_SCOPES = [
  'read_orders',
  'read_assigned_fulfillment_orders',
  'read_merchant_managed_fulfillment_orders',
  'read_third_party_fulfillment_orders',
] as const;

export function createShopifyOAuthApi(config: ShopifyCredentialConfig, requestUrl: string) {
  if (!cfWorkerAdapterInitialized) {
    throw new ShopifyConnectorError('SHOPIFY_RUNTIME_UNAVAILABLE', 'Shopify 运行时适配器未初始化');
  }
  if (!config.clientId || !config.clientSecret) {
    throw new ShopifyConnectorError(
      'SHOPIFY_APP_CREDENTIALS_MISSING',
      `${config.displayName} 尚未配置 ERP 独立 Shopify 应用参数`,
    );
  }
  const url = new URL(requestUrl);
  return shopifyApi({
    apiKey: config.clientId,
    apiSecretKey: config.clientSecret,
    apiVersion: ApiVersion.July26,
    scopes: [...SHOPIFY_ORDER_READ_SCOPES],
    hostName: url.host,
    hostScheme: url.protocol === 'http:' ? 'http' : 'https',
    isEmbeddedApp: false,
    // Partner Dev Dashboard 的 custom distribution app 不是后台旧式 custom store app。
    isCustomStoreApp: false,
    userAgentPrefix: 'MUKU-ERP',
    logger: {
      level: LogSeverity.Error,
      httpRequests: false,
      timestamps: false,
    },
  });
}
