import { ShopifyConnectorError } from './errors';

export function shopifyPublicOrigin(runtime: Record<string, unknown>, requestUrl: string) {
  if (runtime.ERP_HOST_RUNTIME !== 'aws') return new URL(requestUrl).origin;

  const origin = typeof runtime.ERP_PUBLIC_ORIGIN === 'string' ? URL.parse(runtime.ERP_PUBLIC_ORIGIN) : null;
  if (origin?.protocol !== 'https:' || origin.pathname !== '/' || origin.search || origin.hash
    || origin.username || origin.password) {
    throw new ShopifyConnectorError('SHOPIFY_PUBLIC_ORIGIN_INVALID', 'Shopify 授权和通知需要已配置的 ERP HTTPS 地址');
  }
  return origin.origin;
}
