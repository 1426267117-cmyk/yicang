import type { CanonicalOrderGraph } from '../types';
import { PlatformOrderRepository } from '../repository';
import { ShopifyAdminClient } from './client';
import {
  hasShopifyCredentials,
  isShopifyStoreKey,
  SHOPIFY_API_VERSION,
  type ShopifyCredentialConfig,
  type ShopifyStoreKey,
} from './config';
import { ShopifyOrderConnector, type ShopifyShopContext } from './connector';
import { resolveShopifyRuntimeConfig } from './credential-store';
import { ShopifyConnectorError } from './errors';
import { ShopifyWebhookError } from './webhook';

const WEBHOOK_LEASE_MILLISECONDS = 10 * 60 * 1000;
const MAX_WEBHOOK_ATTEMPTS = 5;
const RETRY_DELAYS_SECONDS = [60, 5 * 60, 15 * 60, 60 * 60] as const;

type WebhookEvent = {
  id: string;
  tenantId: string;
  storeKey: string;
  topic: string;
  shopDomain: string;
  sourceOrderId: string;
  attempts: number;
  leaseId: string;
};

export type ShopifyWebhookOrderLoader = (event: WebhookEvent) => Promise<{
  config: ShopifyCredentialConfig;
  context: ShopifyShopContext;
  graph: CanonicalOrderGraph;
}>;

export async function processShopifyWebhookBatch(input: {
  db: D1Database;
  tenantId: string;
  runtimeEnv: Record<string, unknown>;
  requestUrl: string;
  maxEvents: number;
  now?: () => Date;
  loadOrder?: ShopifyWebhookOrderLoader;
}) {
  const nowFn = input.now ?? (() => new Date());
  const maxEvents = Math.max(1, Math.min(10, input.maxEvents));
  const stats = {
    claimed: 0,
    processed: 0,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    retried: 0,
    failed: 0,
    leaseLost: 0,
  };
  await recoverExpiredLeases(input.db, input.tenantId, nowFn().toISOString());
  const loadOrder = input.loadOrder ?? createDefaultOrderLoader({
    db: input.db,
    tenantId: input.tenantId,
    runtimeEnv: input.runtimeEnv,
    requestUrl: input.requestUrl,
  });
  const repository = new PlatformOrderRepository(input.db, input.tenantId);

  for (let index = 0; index < maxEvents; index += 1) {
    const event = await claimNextEvent(input.db, input.tenantId, nowFn());
    if (!event) break;
    stats.claimed += 1;
    try {
      const loaded = await loadOrder(event);
      if (loaded.context.domain !== event.shopDomain) {
        throw new ShopifyWebhookError(
          'SHOPIFY_WEBHOOK_SHOP_MISMATCH',
          'Shopify webhook 店铺与授权身份不匹配',
          401,
        );
      }
      const fetchedAt = nowFn().toISOString();
      const store = await repository.upsertVerifiedShopifyStore(
        loaded.config,
        loaded.context,
        fetchedAt,
      );
      const outcome = await repository.upsertOrderGraph({
        storeId: store.id,
        graph: loaded.graph,
        apiVersion: SHOPIFY_API_VERSION,
        runId: null,
        fetchedAt,
      });
      const completed = await completeEvent(input.db, event, nowFn().toISOString());
      if (!completed) {
        stats.leaseLost += 1;
        continue;
      }
      stats.processed += 1;
      stats[outcome] += 1;
    } catch (error) {
      const failedAt = nowFn();
      const retry = event.attempts < MAX_WEBHOOK_ATTEMPTS && shouldRetry(error);
      const recorded = await recordFailure({
        db: input.db,
        event,
        errorCode: safeErrorCode(error),
        retry,
        failedAt,
      });
      if (!recorded) {
        stats.leaseLost += 1;
      } else if (retry) {
        stats.retried += 1;
      } else {
        stats.failed += 1;
      }
    }
  }
  return { ok: true as const, maxAttempts: MAX_WEBHOOK_ATTEMPTS, stats };
}

function createDefaultOrderLoader(input: {
  db: D1Database;
  tenantId: string;
  runtimeEnv: Record<string, unknown>;
  requestUrl: string;
}): ShopifyWebhookOrderLoader {
  const runtimes = new Map<ShopifyStoreKey, {
    config: ShopifyCredentialConfig;
    context: ShopifyShopContext;
    connector: ShopifyOrderConnector;
  }>();
  return async (event) => {
    if (!isShopifyStoreKey(event.storeKey)) {
      throw new ShopifyWebhookError('UNKNOWN_SHOPIFY_STORE', '未找到该 Shopify 店铺配置', 404);
    }
    let runtime = runtimes.get(event.storeKey);
    if (!runtime) {
      const config = await resolveShopifyRuntimeConfig({
        db: input.db,
        tenantId: input.tenantId,
        runtimeEnv: input.runtimeEnv,
        storeKey: event.storeKey,
        requestUrl: input.requestUrl,
      });
      if (!hasShopifyCredentials(config)) {
        throw new ShopifyWebhookError(
          'SHOPIFY_AUTHORIZATION_REQUIRED',
          `${config.displayName} 尚未完成 Shopify 只读授权`,
          409,
        );
      }
      const connector = new ShopifyOrderConnector(config, new ShopifyAdminClient(config));
      const context = await connector.getShopContext();
      runtime = { config, context, connector };
      runtimes.set(event.storeKey, runtime);
    }
    return {
      config: runtime.config,
      context: runtime.context,
      graph: await runtime.connector.fetchOrder(event.sourceOrderId, runtime.context),
    };
  };
}

async function recoverExpiredLeases(db: D1Database, tenantId: string, now: string) {
  await db.prepare(`
    UPDATE shopify_webhook_events
    SET status = CASE WHEN attempts >= ? THEN 'failed' ELSE 'pending' END,
        last_error_code = COALESCE(last_error_code, 'SHOPIFY_WEBHOOK_LEASE_EXPIRED'),
        next_attempt_at = CASE WHEN attempts >= ? THEN NULL ELSE ? END,
        lease_id = NULL, lease_expires_at = NULL, updated_at = ?
    WHERE tenant_id = ? AND status = 'processing'
      AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
  `).bind(MAX_WEBHOOK_ATTEMPTS, MAX_WEBHOOK_ATTEMPTS, now, now, tenantId, now).run();
}

async function claimNextEvent(db: D1Database, tenantId: string, now: Date): Promise<WebhookEvent | null> {
  const timestamp = now.toISOString();
  for (let collision = 0; collision < 3; collision += 1) {
    const row = await db.prepare(`
      SELECT id, tenant_id, store_key, topic, shop_domain, source_order_id, attempts
      FROM shopify_webhook_events
      WHERE tenant_id = ? AND status = 'pending' AND source_order_id IS NOT NULL
        AND attempts < ? AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
      ORDER BY created_at, id
      LIMIT 1
    `).bind(tenantId, MAX_WEBHOOK_ATTEMPTS, timestamp).first<{
      id: string;
      tenant_id: string;
      store_key: string;
      topic: string;
      shop_domain: string;
      source_order_id: string;
      attempts: number;
    }>();
    if (!row) return null;
    const leaseId = crypto.randomUUID();
    const leaseExpiresAt = new Date(now.getTime() + WEBHOOK_LEASE_MILLISECONDS).toISOString();
    const claimed = await db.prepare(`
      UPDATE shopify_webhook_events
      SET status = 'processing', attempts = attempts + 1, lease_id = ?,
          lease_expires_at = ?, next_attempt_at = NULL, updated_at = ?
      WHERE id = ? AND tenant_id = ? AND status = 'pending' AND attempts = ?
        AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
    `).bind(
      leaseId,
      leaseExpiresAt,
      timestamp,
      row.id,
      tenantId,
      row.attempts,
      timestamp,
    ).run();
    if (changedRows(claimed) === 1) {
      return {
        id: row.id,
        tenantId: row.tenant_id,
        storeKey: row.store_key,
        topic: row.topic,
        shopDomain: row.shop_domain,
        sourceOrderId: row.source_order_id,
        attempts: row.attempts + 1,
        leaseId,
      };
    }
  }
  return null;
}

async function completeEvent(db: D1Database, event: WebhookEvent, now: string) {
  const result = await db.prepare(`
    UPDATE shopify_webhook_events
    SET status = 'processed', processed_at = ?, last_error_code = NULL,
        next_attempt_at = NULL, lease_id = NULL, lease_expires_at = NULL, updated_at = ?
    WHERE id = ? AND tenant_id = ? AND status = 'processing' AND lease_id = ?
  `).bind(now, now, event.id, event.tenantId, event.leaseId).run();
  return changedRows(result) === 1;
}

async function recordFailure(input: {
  db: D1Database;
  event: WebhookEvent;
  errorCode: string;
  retry: boolean;
  failedAt: Date;
}) {
  const timestamp = input.failedAt.toISOString();
  const nextAttemptAt = input.retry
    ? new Date(input.failedAt.getTime() + retryDelaySeconds(input.event.attempts) * 1000).toISOString()
    : null;
  const result = await input.db.prepare(`
    UPDATE shopify_webhook_events
    SET status = ?, last_error_code = ?, next_attempt_at = ?,
        lease_id = NULL, lease_expires_at = NULL, updated_at = ?
    WHERE id = ? AND tenant_id = ? AND status = 'processing' AND lease_id = ?
  `).bind(
    input.retry ? 'pending' : 'failed',
    input.errorCode,
    nextAttemptAt,
    timestamp,
    input.event.id,
    input.event.tenantId,
    input.event.leaseId,
  ).run();
  return changedRows(result) === 1;
}

function retryDelaySeconds(attempts: number) {
  return RETRY_DELAYS_SECONDS[Math.min(attempts - 1, RETRY_DELAYS_SECONDS.length - 1)] ?? 60 * 60;
}

function safeErrorCode(error: unknown) {
  if (error instanceof ShopifyConnectorError || error instanceof ShopifyWebhookError) {
    return error.code.slice(0, 120);
  }
  return 'SHOPIFY_WEBHOOK_PROCESS_FAILED';
}

function shouldRetry(error: unknown) {
  if (error instanceof ShopifyConnectorError) {
    return error.retryable || error.code === 'SHOPIFY_ORDER_MISSING';
  }
  if (error instanceof ShopifyWebhookError) return error.status >= 500;
  return true;
}

function changedRows(result: D1Result<unknown>) {
  return Number(result.meta.changes ?? 0);
}
