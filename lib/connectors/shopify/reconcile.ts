import { PlatformOrderRepository } from '../repository';
import { ShopifyAdminClient } from './client';
import {
  hasShopifyCredentials,
  isShopifyStoreKey,
  type ShopifyCredentialConfig,
  type ShopifyStoreKey,
} from './config';
import { ShopifyOrderConnector } from './connector';
import { resolveShopifyRuntimeConfig } from './credential-store';
import { sanitizedConnectorError, ShopifyConnectorError } from './errors';
import { runShopifyOrderSync } from './sync-service';

const MAX_RECONCILE_TARGETS = 100;
const MAX_RECONCILE_TENANTS = 20;

type StoredReconcileTarget = {
  tenantId: string;
  storeKey: string;
};

type ReconcileDependencies = {
  loadTargets: (db: D1Database, tenantIds?: string[]) => Promise<StoredReconcileTarget[]>;
  resolveConfig: typeof resolveShopifyRuntimeConfig;
  runSync: (input: {
    db: D1Database;
    tenantId: string;
    config: ShopifyCredentialConfig;
    maxPages: number;
  }) => ReturnType<typeof runShopifyOrderSync>;
};

export async function reconcileStoredShopifyOrders(input: {
  db: D1Database;
  runtimeEnv: Record<string, unknown>;
  requestUrl: string;
  tenantIds?: string[];
  storeKeys?: ShopifyStoreKey[];
  maxPages: number;
  dependencies?: Partial<ReconcileDependencies>;
}) {
  const dependencies: ReconcileDependencies = {
    loadTargets: loadStoredReconcileTargets,
    resolveConfig: resolveShopifyRuntimeConfig,
    runSync: runIncrementalSync,
    ...input.dependencies,
  };
  const requestedTenantIds = input.tenantIds ? new Set(input.tenantIds) : null;
  const requestedKeys = input.storeKeys ? new Set(input.storeKeys) : null;
  const loaded = await dependencies.loadTargets(input.db, input.tenantIds);
  const targets = loaded.filter((target) => (
    (!requestedTenantIds || requestedTenantIds.has(target.tenantId))
    && (!requestedKeys || requestedKeys.has(target.storeKey as ShopifyStoreKey))
  ));
  assertUnambiguousTargets(targets);

  const synced: Array<{
    storeKey: ShopifyStoreKey;
    pagesCompleted: number;
    ordersSeen: number;
    ordersInserted: number;
    ordersUpdated: number;
    ordersUnchanged: number;
    completedAt: string;
  }> = [];
  const failed: Array<{ storeKey: string; code: string; retryable: boolean }> = [];
  const skipped: Array<{ storeKey: ShopifyStoreKey; code: string }> = [];

  if (requestedKeys) {
    const configured = new Set(targets.map((target) => target.storeKey));
    for (const storeKey of requestedKeys) {
      if (!configured.has(storeKey)) {
        skipped.push({ storeKey, code: 'SHOPIFY_AUTHORIZATION_REQUIRED' });
      }
    }
  }

  for (const target of targets) {
    try {
      if (!isShopifyStoreKey(target.storeKey)) {
        throw new ShopifyConnectorError('UNKNOWN_SHOPIFY_STORE', '已保存的 Shopify 店铺配置无法识别');
      }
      // This resolver owns access-token refresh. A scheduled run therefore uses
      // the same encrypted refresh-token lease and rotation path as an operator run.
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
      const result = await dependencies.runSync({
        db: input.db,
        tenantId: target.tenantId,
        config,
        maxPages: input.maxPages,
      });
      synced.push({
        storeKey: target.storeKey,
        pagesCompleted: result.stats.pagesCompleted,
        ordersSeen: result.stats.ordersSeen,
        ordersInserted: result.stats.ordersInserted,
        ordersUpdated: result.stats.ordersUpdated,
        ordersUnchanged: result.stats.ordersUnchanged,
        completedAt: result.completedAt,
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
    ok: failed.length === 0 && skipped.length === 0,
    storesChecked: targets.length,
    synced,
    skipped,
    failed,
  };
}

async function runIncrementalSync(input: {
  db: D1Database;
  tenantId: string;
  config: ShopifyCredentialConfig;
  maxPages: number;
}) {
  const client = new ShopifyAdminClient(input.config);
  const connector = new ShopifyOrderConnector(input.config, client);
  const repository = new PlatformOrderRepository(input.db, input.tenantId);
  return runShopifyOrderSync({
    request: {
      storeKey: input.config.key,
      mode: 'incremental',
      maxPages: input.maxPages,
    },
    config: input.config,
    connector,
    repository,
  });
}

async function loadStoredReconcileTargets(db: D1Database, tenantIds?: string[]) {
  if (tenantIds && tenantIds.length > MAX_RECONCILE_TENANTS) {
    throw new ShopifyConnectorError(
      'SHOPIFY_RECONCILE_TENANT_LIMIT',
      '单次 Shopify 对账的租户数量超过安全上限',
    );
  }
  if (tenantIds?.length === 0) return [];
  const tenantClause = tenantIds
    ? `AND tenant_id IN (${tenantIds.map(() => '?').join(', ')})`
    : '';
  const rows = await db.prepare(`
    SELECT tenant_id, store_key
    FROM connector_credentials
    WHERE platform = 'shopify'
      ${tenantClause}
    ORDER BY store_key, tenant_id
    LIMIT ?
  `).bind(...(tenantIds ?? []), MAX_RECONCILE_TARGETS + 1)
    .all<{ tenant_id: string; store_key: string }>();
  if (rows.results.length > MAX_RECONCILE_TARGETS) {
    throw new ShopifyConnectorError(
      'SHOPIFY_RECONCILE_TARGET_LIMIT',
      '已授权的 Shopify 店铺数量超过单次任务安全上限',
    );
  }
  return rows.results.map((row) => ({ tenantId: row.tenant_id, storeKey: row.store_key }));
}

function assertUnambiguousTargets(targets: StoredReconcileTarget[]) {
  const keys = new Set<string>();
  for (const target of targets) {
    if (keys.has(target.storeKey)) {
      throw new ShopifyConnectorError(
        'SHOPIFY_RECONCILE_OWNER_AMBIGUOUS',
        'Shopify 店铺授权归属不唯一，已停止定时对账',
        false,
        409,
      );
    }
    keys.add(target.storeKey);
  }
}
