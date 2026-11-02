import { ShopifyAdminClient } from './client';
import {
  hasShopifyCredentials,
  isShopifyStoreKey,
  type ShopifyCredentialConfig,
  type ShopifyStoreKey,
} from './config';
import { ShopifyOrderConnector, type ShopifyShopContext } from './connector';
import { resolveShopifyRuntimeConfig } from './credential-store';
import { sanitizedConnectorError, ShopifyConnectorError } from './errors';
import { ensureShopifyOrderWebhookSubscriptions } from './webhook-registration';

const MAX_STORED_SHOPIFY_CREDENTIALS = 100;

type StoredWebhookTarget = {
  tenantId: string;
  storeKey: string;
  shopDomain: string;
  officialStoreId: string;
};

type WebhookRegistrationStats = {
  callbackUri: string;
  created: number;
  updated: number;
  unchanged: number;
};

type WebhookMaintenanceDependencies = {
  loadTargets: (db: D1Database) => Promise<StoredWebhookTarget[]>;
  resolveConfig: typeof resolveShopifyRuntimeConfig;
  createVerifiedRuntime: (config: ShopifyCredentialConfig) => Promise<{
    client: ShopifyAdminClient;
    context: ShopifyShopContext;
  }>;
  ensureSubscriptions: typeof ensureShopifyOrderWebhookSubscriptions;
};

export async function registerStoredShopifyWebhooks(input: {
  db: D1Database;
  runtimeEnv: Record<string, unknown>;
  requestUrl: string;
  dependencies?: Partial<WebhookMaintenanceDependencies>;
}) {
  const dependencies: WebhookMaintenanceDependencies = {
    loadTargets: loadStoredWebhookTargets,
    resolveConfig: resolveShopifyRuntimeConfig,
    createVerifiedRuntime,
    ensureSubscriptions: ensureShopifyOrderWebhookSubscriptions,
    ...input.dependencies,
  };
  const targets = await dependencies.loadTargets(input.db);
  assertUnambiguousWebhookOwnership(targets);

  const registered: Array<{
    storeKey: ShopifyStoreKey;
    created: number;
    updated: number;
    unchanged: number;
  }> = [];
  const failed: Array<{
    storeKey: string;
    code: string;
    retryable: boolean;
  }> = [];

  for (const target of targets) {
    try {
      if (!isShopifyStoreKey(target.storeKey)) {
        throw new ShopifyConnectorError(
          'UNKNOWN_SHOPIFY_STORE',
          '已保存的 Shopify 店铺配置无法识别',
        );
      }
      const config = await dependencies.resolveConfig({
        db: input.db,
        tenantId: target.tenantId,
        runtimeEnv: input.runtimeEnv,
        storeKey: target.storeKey,
        requestUrl: input.requestUrl,
      });
      if (!hasShopifyCredentials(config)) {
        throw new ShopifyConnectorError(
          'SHOPIFY_AUTHORIZATION_REQUIRED',
          `${config.displayName} 尚未完成 Shopify 只读授权`,
        );
      }
      const runtime = await dependencies.createVerifiedRuntime(config);
      assertStoredIdentityMatches(target, runtime.context);
      const result: WebhookRegistrationStats = await dependencies.ensureSubscriptions({
        client: runtime.client,
        storeKey: target.storeKey,
        requestUrl: input.requestUrl,
      });
      registered.push({
        storeKey: target.storeKey,
        created: result.created,
        updated: result.updated,
        unchanged: result.unchanged,
      });
    } catch (error) {
      const failure = sanitizedConnectorError(error);
      failed.push({
        storeKey: target.storeKey,
        code: failure.code,
        retryable: failure.retryable,
      });
    }
  }

  return {
    ok: failed.length === 0,
    storesChecked: targets.length,
    registered,
    failed,
  };
}

async function loadStoredWebhookTargets(db: D1Database) {
  const rows = await db.prepare(`
    SELECT tenant_id, store_key, shop_domain, official_store_id
    FROM connector_credentials
    WHERE platform = 'shopify'
    ORDER BY store_key, tenant_id
    LIMIT ?
  `).bind(MAX_STORED_SHOPIFY_CREDENTIALS + 1).all<{
    tenant_id: string;
    store_key: string;
    shop_domain: string;
    official_store_id: string;
  }>();
  if (rows.results.length > MAX_STORED_SHOPIFY_CREDENTIALS) {
    throw new ShopifyConnectorError(
      'SHOPIFY_WEBHOOK_REGISTRATION_LIMIT',
      '已保存的 Shopify 店铺数量超过安全注册上限',
    );
  }
  return rows.results.map((row) => ({
    tenantId: row.tenant_id,
    storeKey: row.store_key,
    shopDomain: row.shop_domain,
    officialStoreId: row.official_store_id,
  }));
}

function assertUnambiguousWebhookOwnership(targets: StoredWebhookTarget[]) {
  const stores = new Set<string>();
  const domains = new Set<string>();
  const officialStoreIds = new Set<string>();
  for (const target of targets) {
    if (
      stores.has(target.storeKey)
      || domains.has(target.shopDomain)
      || officialStoreIds.has(target.officialStoreId)
    ) {
      throw new ShopifyConnectorError(
        'SHOPIFY_WEBHOOK_OWNER_AMBIGUOUS',
        'Shopify 店铺授权归属不唯一，已停止注册 webhook',
        false,
        409,
      );
    }
    stores.add(target.storeKey);
    domains.add(target.shopDomain);
    officialStoreIds.add(target.officialStoreId);
  }
}

function assertStoredIdentityMatches(target: StoredWebhookTarget, context: ShopifyShopContext) {
  if (context.id !== target.officialStoreId || context.domain !== target.shopDomain) {
    throw new ShopifyConnectorError(
      'SHOPIFY_IDENTITY_MISMATCH',
      'Shopify 当前授权身份与 ERP 已保存店铺不一致，已停止注册 webhook',
    );
  }
}

async function createVerifiedRuntime(config: ShopifyCredentialConfig) {
  const client = new ShopifyAdminClient(config);
  const connector = new ShopifyOrderConnector(config, client);
  const context = await connector.getShopContext();
  return { client, context };
}
