export const SHOPIFY_API_VERSION = '2026-07';
export const SHOPIFY_ORDER_READ_SCOPES = ['read_orders'] as const;
export const SHOPIFY_CATALOG_READ_SCOPES = ['read_products', 'read_inventory'] as const;
type ShopifyReadScope = (typeof SHOPIFY_ORDER_READ_SCOPES)[number] | (typeof SHOPIFY_CATALOG_READ_SCOPES)[number];
export type ShopifyCapabilityState = 'granted' | 'missing' | 'unknown' | 'unconfigured';
export type ShopifyAccessCapabilities = Record<'orders' | 'products' | 'inventory', ShopifyCapabilityState>;

export const SHOPIFY_STORE_CANDIDATES = [
  {
    key: 'zimasya',
    displayName: 'ZIMASYA',
    environmentPrefix: 'SHOPIFY_ZIMASYA',
    authMode: 'oauth',
  },
  {
    key: 'kaguyasu',
    displayName: 'Kaguyasu',
    environmentPrefix: 'SHOPIFY_KAGUYASU',
    authMode: 'oauth',
  },
  {
    key: 'anzhap',
    displayName: 'Anzhap',
    environmentPrefix: 'SHOPIFY_ANZ',
    authMode: 'oauth',
  },
  {
    key: 'bizfurniz',
    displayName: 'BizFurniz',
    environmentPrefix: 'SHOPIFY_BIZFURNIZ',
    authMode: 'oauth',
  },
] as const;

export type ShopifyStoreKey = (typeof SHOPIFY_STORE_CANDIDATES)[number]['key'];

export function isShopifyStoreKey(value: string): value is ShopifyStoreKey {
  return SHOPIFY_STORE_CANDIDATES.some((candidate) => candidate.key === value);
}

export type ShopifyCredentialConfig = {
  key: ShopifyStoreKey;
  displayName: string;
  domain: string;
  expectedDomain: string;
  acceptedDomains: readonly string[];
  environmentPrefix: string;
  authMode: 'oauth' | 'client_credentials';
  credentialRef: string;
  adminAccessToken: string | null;
  clientId: string | null;
  clientSecret: string | null;
  catalogReadEnabled?: boolean;
};

export type ShopifyStoreConfigurationInspection =
  | { ok: true; config: ShopifyCredentialConfig; errorCode: null }
  | {
      ok: false;
      config: null;
      errorCode: 'SHOPIFY_DOMAIN_UNCONFIGURED' | 'INVALID_SHOPIFY_DOMAIN' | 'SHOPIFY_CONFIGURATION_INVALID';
      candidate: (typeof SHOPIFY_STORE_CANDIDATES)[number];
    };

export function resolveShopifyStoreConfig(
  runtimeEnv: Record<string, unknown>,
  storeKey: ShopifyStoreKey,
): ShopifyCredentialConfig {
  const candidate = SHOPIFY_STORE_CANDIDATES.find((item) => item.key === storeKey);
  if (!candidate) throw new Error('UNKNOWN_SHOPIFY_STORE');
  const configuredDomain = envString(runtimeEnv, `${candidate.environmentPrefix}_SHOP_DOMAIN`);
  if (!configuredDomain) throw new Error('SHOPIFY_DOMAIN_UNCONFIGURED');
  const domain = normalizeShopifyDomain(configuredDomain);
  const aliases = envString(runtimeEnv, `${candidate.environmentPrefix}_ACCEPTED_DOMAINS`)
    ?.split(',').map((alias) => alias.trim()).filter(Boolean) ?? [];
  const acceptedDomains = [...new Set([domain, ...aliases.map(normalizeShopifyDomain)])];
  return {
    ...candidate,
    domain,
    expectedDomain: domain,
    acceptedDomains,
    credentialRef: `env:${candidate.environmentPrefix}`,
    adminAccessToken: envString(runtimeEnv, `${candidate.environmentPrefix}_ADMIN_ACCESS_TOKEN`),
    clientId: envString(runtimeEnv, `${candidate.environmentPrefix}_CLIENT_ID`),
    clientSecret: envString(runtimeEnv, `${candidate.environmentPrefix}_CLIENT_SECRET`),
    catalogReadEnabled: envString(runtimeEnv, `${candidate.environmentPrefix}_CATALOG_READ_ENABLED`) === 'true',
  };
}

export function shopifyRequestedReadScopes(config: Pick<ShopifyCredentialConfig, 'catalogReadEnabled'>): ShopifyReadScope[] {
  return config.catalogReadEnabled ? [...SHOPIFY_ORDER_READ_SCOPES, ...SHOPIFY_CATALOG_READ_SCOPES] : [...SHOPIFY_ORDER_READ_SCOPES];
}

export function hasShopifyReadScope(scopes: ReadonlySet<string>, scope: ShopifyReadScope) {
  return scopes.has(scope) || (scope !== 'read_orders' && scopes.has(`write_${scope.slice(5)}`));
}

export function missingShopifyReadScopes(config: Pick<ShopifyCredentialConfig, 'catalogReadEnabled'>, scopes: ReadonlySet<string>) {
  return shopifyRequestedReadScopes(config).filter((scope) => !hasShopifyReadScope(scopes, scope));
}

export function shopifyAccessCapabilities(configured: boolean, scopes: ReadonlySet<string> | null): ShopifyAccessCapabilities {
  const state = (scope: ShopifyReadScope): ShopifyCapabilityState => !configured ? 'unconfigured' : !scopes ? 'unknown'
    : hasShopifyReadScope(scopes, scope) ? 'granted' : 'missing';
  return { orders: state('read_orders'), products: state('read_products'), inventory: state('read_inventory') };
}

export function inspectShopifyStoreConfiguration(
  runtimeEnv: Record<string, unknown>,
  storeKey: ShopifyStoreKey,
): ShopifyStoreConfigurationInspection {
  const candidate = SHOPIFY_STORE_CANDIDATES.find((item) => item.key === storeKey);
  if (!candidate) throw new Error('UNKNOWN_SHOPIFY_STORE');
  try {
    return { ok: true, config: resolveShopifyStoreConfig(runtimeEnv, storeKey), errorCode: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    return {
      ok: false,
      config: null,
      errorCode: message === 'SHOPIFY_DOMAIN_UNCONFIGURED' || message === 'INVALID_SHOPIFY_DOMAIN'
        ? message
        : 'SHOPIFY_CONFIGURATION_INVALID',
      candidate,
    };
  }
}

export function hasShopifyCredentials(config: ShopifyCredentialConfig) {
  return Boolean(
    config.adminAccessToken
    || (config.authMode === 'client_credentials' && config.clientId && config.clientSecret),
  );
}

export function configuredShopifyEnvironmentStoreKeys(
  runtimeEnv: Record<string, unknown>,
): ShopifyStoreKey[] {
  return SHOPIFY_STORE_CANDIDATES
    // Target discovery must not parse optional SHOP_DOMAIN values for stores
    // that have no usable server-side credential. A stale typo in an unused
    // candidate must not stop reconciliation for every authorized store.
    .filter((candidate) => envString(
      runtimeEnv,
      `${candidate.environmentPrefix}_ADMIN_ACCESS_TOKEN`,
    ) !== null)
    .map((candidate) => candidate.key);
}

export function readyShopifyEnvironmentStoreKeys(
  runtimeEnv: Record<string, unknown>,
): ShopifyStoreKey[] {
  return configuredShopifyEnvironmentStoreKeys(runtimeEnv).filter((storeKey) => {
    try {
      return hasShopifyCredentials(resolveShopifyStoreConfig(runtimeEnv, storeKey));
    } catch {
      return false;
    }
  });
}

export function invalidShopifyEnvironmentStoreKeys(
  runtimeEnv: Record<string, unknown>,
): ShopifyStoreKey[] {
  const ready = new Set(readyShopifyEnvironmentStoreKeys(runtimeEnv));
  return configuredShopifyEnvironmentStoreKeys(runtimeEnv)
    .filter((storeKey) => !ready.has(storeKey));
}

export function hasShopifyAppCredentials(config: ShopifyCredentialConfig) {
  return Boolean(config.clientId && config.clientSecret);
}

export function withShopifyAdminAccessToken(
  config: ShopifyCredentialConfig,
  input: { token: string; domain: string; credentialRef: string },
): ShopifyCredentialConfig {
  const domain = normalizeShopifyDomain(input.domain);
  if (!shopifyDomainAccepted(config, domain)) throw new Error('SHOPIFY_DOMAIN_NOT_ALLOWED');
  return {
    ...config,
    domain,
    credentialRef: input.credentialRef,
    adminAccessToken: input.token,
  };
}

export function shopifyDomainAccepted(config: ShopifyCredentialConfig, value: string) {
  const domain = normalizeShopifyDomain(value);
  return config.acceptedDomains.includes(domain);
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
