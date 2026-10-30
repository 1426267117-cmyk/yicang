export const SHOPIFY_API_VERSION = '2026-07';

export const SHOPIFY_STORE_CANDIDATES = [
  {
    key: 'zimasya',
    displayName: 'ZIMASYA',
    expectedDomain: '346c85.myshopify.com',
    environmentPrefix: 'SHOPIFY_ZIMASYA',
  },
  {
    key: 'kaguyasu',
    displayName: 'Kaguyasu',
    expectedDomain: 'officebaseca.myshopify.com',
    environmentPrefix: 'SHOPIFY_KAGUYASU',
  },
  {
    key: 'anzhap',
    displayName: 'Anzhap',
    expectedDomain: 'anzhap.myshopify.com',
    environmentPrefix: 'SHOPIFY_ANZ',
  },
  {
    key: 'bizfurniz',
    displayName: 'BizFurniz',
    expectedDomain: 'bizfurniz.myshopify.com',
    environmentPrefix: 'SHOPIFY_BIZFURNIZ',
  },
] as const;

export type ShopifyStoreKey = (typeof SHOPIFY_STORE_CANDIDATES)[number]['key'];

export type ShopifyCredentialConfig = {
  key: ShopifyStoreKey;
  displayName: string;
  domain: string;
  expectedDomain: string;
  environmentPrefix: string;
  adminAccessToken: string | null;
  clientId: string | null;
  clientSecret: string | null;
};

export function resolveShopifyStoreConfig(
  runtimeEnv: Record<string, unknown>,
  storeKey: ShopifyStoreKey,
): ShopifyCredentialConfig {
  const candidate = SHOPIFY_STORE_CANDIDATES.find((item) => item.key === storeKey);
  if (!candidate) throw new Error('UNKNOWN_SHOPIFY_STORE');
  const overrideDomain = envString(runtimeEnv, `${candidate.environmentPrefix}_SHOP_DOMAIN`);
  const domain = normalizeShopifyDomain(overrideDomain ?? candidate.expectedDomain);
  return {
    ...candidate,
    domain,
    adminAccessToken: envString(runtimeEnv, `${candidate.environmentPrefix}_ADMIN_ACCESS_TOKEN`),
    clientId: envString(runtimeEnv, `${candidate.environmentPrefix}_CLIENT_ID`),
    clientSecret: envString(runtimeEnv, `${candidate.environmentPrefix}_CLIENT_SECRET`),
  };
}

export function hasShopifyCredentials(config: ShopifyCredentialConfig) {
  return Boolean(config.adminAccessToken || (config.clientId && config.clientSecret));
}

export function normalizeShopifyDomain(value: string) {
  const domain = value.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(domain)) {
    throw new Error('INVALID_SHOPIFY_DOMAIN');
  }
  return domain;
}

function envString(runtimeEnv: Record<string, unknown>, key: string) {
  const value = runtimeEnv[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
