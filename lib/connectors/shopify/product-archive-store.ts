import { z } from 'zod';
import { ShopifyAdminClient } from './client';
import { loadShopifyOAuthCredential } from './credential-store';
import { normalizeShopifyDomain, resolveShopifyStoreConfig, shopifyDomainAccepted, withShopifyAdminAccessToken,
  type ShopifyCredentialConfig, type ShopifyStoreKey } from './config';
import { ShopifyConnectorError } from './errors';
import shopContextQuery from './graphql/shop-context.graphql?raw';

const shopContextSchema = z.object({
  shop: z.object({ id: z.string().regex(/^gid:\/\/shopify\/Shop\/\d+$/u), name: z.string(), myshopifyDomain: z.string() }),
  currentAppInstallation: z.object({ accessScopes: z.array(z.object({ handle: z.string() })) }),
});

export async function getVerifiedShopifyProductArchiveStore(input: {
  db: D1Database;
  tenantId: string;
  runtimeEnv: Record<string, unknown>;
  storeKey: ShopifyStoreKey;
  makeClient?: (config: ShopifyCredentialConfig) => Pick<ShopifyAdminClient, 'graphql'>;
  now?: Date;
}) {
  const { db, tenantId, storeKey, runtimeEnv, makeClient = (config) => new ShopifyAdminClient(config), now = new Date() } = input;
  const base = resolveShopifyStoreConfig(runtimeEnv, storeKey);
  // This lookup uses the current credential without rotating or saving it.
  const stored = await loadShopifyOAuthCredential(db, tenantId, storeKey, runtimeEnv);
  if (stored?.accessTokenExpiresAt && !(Date.parse(stored.accessTokenExpiresAt) > now.getTime())) {
    throw new ShopifyConnectorError('SHOPIFY_PRODUCT_AUTHORIZATION_EXPIRED', '该店铺的 Shopify 授权已到期，请从店铺接入更新授权');
  }
  if (!stored?.accessToken && !base.adminAccessToken) {
    throw new ShopifyConnectorError('SHOPIFY_AUTHORIZATION_REQUIRED', '该 Shopify 店铺尚未在易仓完成授权');
  }
  if (stored && !shopifyDomainAccepted(base, stored.shopDomain)) throw identityMismatch();
  const config = stored ? withShopifyAdminAccessToken(base, {
    token: stored.accessToken, domain: stored.shopDomain, credentialRef: `d1:shopify:${storeKey}`,
  }) : base;
  const { results } = await db.prepare(`
    SELECT official_store_id FROM connector_credentials
    WHERE tenant_id = ? AND platform = 'shopify' AND store_key = ?
    UNION
    SELECT official_store_id FROM platform_stores
    WHERE tenant_id = ? AND platform = 'shopify' AND connector_key = ?
  `).bind(tenantId, storeKey, tenantId, storeKey).all<{ official_store_id: string }>();
  if (!results.length) {
    throw new ShopifyConnectorError('SHOPIFY_PRODUCT_STORE_UNVERIFIED', '该工作区尚未核验此 Shopify 店铺，请先完成店铺接入');
  }
  const client = makeClient(config);
  const parsed = shopContextSchema.safeParse(await client.graphql<unknown>(shopContextQuery));
  if (!parsed.success) throw new ShopifyConnectorError('SHOPIFY_PRODUCT_INVALID_RESPONSE', '无法核验 Shopify 返回的店铺身份');
  const { shop, currentAppInstallation } = parsed.data;
  let domain: string;
  try {
    domain = normalizeShopifyDomain(shop.myshopifyDomain);
  } catch {
    throw identityMismatch();
  }
  if (!shopifyDomainAccepted(config, domain) || results.some(({ official_store_id }) => official_store_id !== shop.id)) {
    throw identityMismatch();
  }
  const context = {
    name: shop.name,
    domain,
    scopes: new Set(currentAppInstallation.accessScopes.map(({ handle }) => handle)),
  };
  return { context, client };
}

function identityMismatch() {
  return new ShopifyConnectorError('SHOPIFY_IDENTITY_MISMATCH', 'Shopify 返回的店铺身份与易仓配置不一致');
}
