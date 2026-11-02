import { readFileSync } from 'node:fs';
import { Miniflare } from 'miniflare';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ShopifyCredentialConfig } from '../lib/connectors/shopify/config';
import type { ShopifyShopContext } from '../lib/connectors/shopify/connector';
import { ShopifyConnectorError } from '../lib/connectors/shopify/errors';
import { processShopifyWebhookBatch } from '../lib/connectors/shopify/webhook-consumer';
import { receiveShopifyOrderWebhook } from '../lib/connectors/shopify/webhook';
import { shopifyOrderFixture } from './fixtures/shopify-order';

const tenantId = 'tenant_webhook_consumer_test';
const shopDomain = 'z6w01w-xs.myshopify.com';
const clientSecret = 'test_webhook_consumer_secret';
const config: ShopifyCredentialConfig = {
  key: 'bizfurniz', displayName: 'BizFurniz', domain: shopDomain, expectedDomain: shopDomain,
  acceptedDomains: [shopDomain], environmentPrefix: 'SHOPIFY_BIZFURNIZ', authMode: 'oauth',
  credentialRef: 'test:bizfurniz', adminAccessToken: 'test-only-token',
  clientId: 'test-client-id', clientSecret,
};
const context: ShopifyShopContext = {
  id: 'gid://shopify/Shop/1001', name: 'BizFurniz', domain: shopDomain,
  timezone: 'America/Los_Angeles', timezoneOffset: '-07:00', currency: 'USD',
  scopes: new Set(['read_orders']),
};

describe('Shopify webhook pending 消费者', () => {
  let mf: Miniflare;
  let db: D1Database;
  let now: Date;

  beforeEach(async () => {
    mf = new Miniflare({ modules: true, script: 'export default { fetch(){ return new Response("ok") } }', d1Databases: ['DB'] });
    db = await mf.getD1Database('DB');
    await applyMigrations(db);
    now = new Date('2026-11-02T02:00:00.000Z');
    await db.prepare('INSERT INTO tenants (id, name, created_at) VALUES (?, ?, ?)')
      .bind(tenantId, 'Webhook Consumer Test', now.toISOString()).run();
    await db.prepare(`
      INSERT INTO connector_credentials (
        id, tenant_id, platform, store_key, shop_domain, official_store_id,
        access_token_ciphertext, refresh_token_ciphertext, granted_scopes,
        access_token_expires_at, refresh_token_expires_at, refresh_started_at,
        key_version, created_by, created_at, updated_at
      ) VALUES (?, ?, 'shopify', 'bizfurniz', ?, ?, ?, NULL, 'read_orders',
        NULL, NULL, NULL, 1, 'test', ?, ?)
    `).bind('credential_consumer', tenantId, shopDomain, context.id, 'v1:test-only', now.toISOString(), now.toISOString()).run();
  });

  afterEach(async () => mf.dispose());

  it('抢占事件、完整读取并复用订单幂等落库', async () => {
    await enqueue('delivery-process-1');
    const first = await process(fakeLoader());
    expect(first.stats).toMatchObject({ claimed: 1, processed: 1, inserted: 1, retried: 0, failed: 0 });
    expect(await eventRow('delivery-process-1')).toMatchObject({ status: 'processed', attempts: 1 });
    expect(await count('platform_orders')).toBe(1);
    const snapshot = await db.prepare('SELECT sync_run_id FROM platform_order_snapshots LIMIT 1')
      .first<{ sync_run_id: string | null }>();
    expect(snapshot?.sync_run_id).toBeNull();

    await enqueue('delivery-process-2');
    const second = await process(fakeLoader());
    expect(second.stats).toMatchObject({ processed: 1, unchanged: 1 });
    expect(await count('platform_orders')).toBe(1);
    expect(await count('platform_order_snapshots')).toBe(1);
  });

  it('失败保留并在退避时间后重试', async () => {
    await enqueue('delivery-retry');
    let shouldFail = true;
    const loader = async () => {
      if (shouldFail) throw new ShopifyConnectorError('SHOPIFY_NETWORK_ERROR', 'temporary', true);
      return { config, context, graph: shopifyOrderFixture() };
    };
    const first = await process(loader);
    expect(first.stats).toMatchObject({ retried: 1, processed: 0 });
    expect(await eventRow('delivery-retry')).toMatchObject({
      status: 'pending', attempts: 1, last_error_code: 'SHOPIFY_NETWORK_ERROR',
      next_attempt_at: '2026-11-02T02:01:00.000Z',
    });
    expect((await process(loader)).stats.claimed).toBe(0);

    shouldFail = false;
    now = new Date('2026-11-02T02:01:01.000Z');
    const retried = await process(loader);
    expect(retried.stats).toMatchObject({ processed: 1, inserted: 1 });
    expect(await eventRow('delivery-retry')).toMatchObject({ status: 'processed', attempts: 2, last_error_code: null });
  });

  it('恢复过期租约，五次失败后保留终态', async () => {
    await enqueue('delivery-expired');
    await db.prepare(`
      UPDATE shopify_webhook_events SET status = 'processing', attempts = 4,
        lease_id = 'expired', lease_expires_at = '2026-11-02T01:59:00.000Z'
      WHERE webhook_id = 'delivery-expired'
    `).run();
    const result = await process(async () => {
      throw new ShopifyConnectorError('SHOPIFY_AUTH_FAILED', 'permanent');
    });
    expect(result.stats).toMatchObject({ claimed: 1, failed: 1, processed: 0 });
    expect(await eventRow('delivery-expired')).toMatchObject({
      status: 'failed', attempts: 5, last_error_code: 'SHOPIFY_AUTH_FAILED',
      next_attempt_at: null, lease_id: null, lease_expires_at: null,
    });
  });

  async function process(loadOrder: Parameters<typeof processShopifyWebhookBatch>[0]['loadOrder']) {
    return processShopifyWebhookBatch({
      db, tenantId, runtimeEnv: {}, requestUrl: 'https://erp.example/process',
      maxEvents: 1, now: () => now, loadOrder,
    });
  }

  function fakeLoader() {
    return async () => ({ config, context, graph: shopifyOrderFixture() });
  }

  async function enqueue(webhookId: string) {
    const rawBody = new TextEncoder().encode(JSON.stringify({ id: 1001, admin_graphql_api_id: 'gid://shopify/Order/1001' }));
    await receiveShopifyOrderWebhook({
      db, runtimeEnv: { SHOPIFY_BIZFURNIZ_CLIENT_SECRET: clientSecret }, storeKey: 'bizfurniz',
      headers: new Headers({
        'X-Shopify-Hmac-Sha256': await sign(rawBody, clientSecret),
        'X-Shopify-Webhook-Id': webhookId,
        'X-Shopify-Topic': 'orders/updated',
        'X-Shopify-Shop-Domain': shopDomain,
        'X-Shopify-API-Version': '2026-07',
        'X-Shopify-Triggered-At': now.toISOString(),
      }),
      rawBody, now,
    });
  }

  async function eventRow(webhookId: string) {
    return db.prepare(`SELECT status, attempts, last_error_code, next_attempt_at, lease_id, lease_expires_at
      FROM shopify_webhook_events WHERE webhook_id = ?`).bind(webhookId).first<Record<string, unknown>>();
  }

  async function count(table: string) {
    const row = await db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<{ count: number }>();
    return Number(row?.count ?? 0);
  }
});

async function sign(rawBody: Uint8Array, secret: string) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const body = new Uint8Array(rawBody.byteLength);
  body.set(rawBody);
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, body.buffer));
  return Buffer.from(signature).toString('base64');
}

async function applyMigrations(db: D1Database) {
  for (const migration of [
    '../drizzle/0000_wooden_deathstrike.sql', '../drizzle/0001_premium_the_stranger.sql',
    '../drizzle/0002_organic_titanium_man.sql', '../drizzle/0003_fancy_jane_foster.sql',
    '../drizzle/0004_illegal_black_panther.sql', '../drizzle/0005_chilly_obadiah_stane.sql',
    '../drizzle/0006_soft_wither.sql',
    '../drizzle/0007_worried_stone_men.sql',
    '../drizzle/0008_nifty_mimic.sql',
    '../drizzle/0009_shocking_iron_lad.sql',
  ]) {
    const sql = readFileSync(new URL(migration, import.meta.url), 'utf8');
    for (const statement of sql.split('--> statement-breakpoint').map((item) => item.trim()).filter(Boolean)) {
      await db.prepare(statement).run();
    }
  }
}
