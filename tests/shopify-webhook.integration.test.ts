import { readFileSync } from 'node:fs';
import { Miniflare } from 'miniflare';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  extractShopifyOrderId,
  receiveShopifyOrderWebhook,
  verifyShopifyWebhookHmac,
} from '../lib/connectors/shopify/webhook';

const tenantId = 'tenant_webhook_test';
const shopDomain = 'z6w01w-xs.myshopify.com';
const clientSecret = 'test_webhook_client_secret';

describe('Shopify webhook 安全接收', () => {
  let mf: Miniflare;
  let db: D1Database;

  beforeEach(async () => {
    mf = new Miniflare({
      modules: true,
      script: 'export default { fetch(){ return new Response("ok") } }',
      d1Databases: ['DB'],
    });
    db = await mf.getD1Database('DB');
    await applyMigrations(db);
    await db.prepare('INSERT INTO tenants (id, name, created_at) VALUES (?, ?, ?)')
      .bind(tenantId, 'Webhook Test', '2026-11-02T00:00:00.000Z')
      .run();
    await db.prepare(`
      INSERT INTO connector_credentials (
        id, tenant_id, platform, store_key, shop_domain, official_store_id,
        access_token_ciphertext, refresh_token_ciphertext, granted_scopes,
        access_token_expires_at, refresh_token_expires_at, refresh_started_at,
        key_version, created_by, created_at, updated_at
      ) VALUES (?, ?, 'shopify', 'bizfurniz', ?, ?, ?, NULL, 'read_orders',
        NULL, NULL, NULL, 1, 'test', ?, ?)
    `).bind(
      'credential_webhook_test',
      tenantId,
      shopDomain,
      'gid://shopify/Shop/1001',
      'v1:test-only-ciphertext',
      '2026-11-02T00:00:00.000Z',
      '2026-11-02T00:00:00.000Z',
    ).run();
  });

  afterEach(async () => mf.dispose());

  it('验签后只保存无敏感原文的事件元数据，并对重复投递幂等', async () => {
    const rawBody = new TextEncoder().encode(JSON.stringify({
      id: 9001,
      admin_graphql_api_id: 'gid://shopify/Order/9001',
      email: 'customer@example.com',
      shipping_address: { address1: 'Sensitive address' },
    }));
    const headers = await signedHeaders(rawBody, {
      topic: 'orders/create',
      webhookId: 'webhook-delivery-1',
    });

    const first = await receiveShopifyOrderWebhook({
      db,
      runtimeEnv: { SHOPIFY_BIZFURNIZ_CLIENT_SECRET: clientSecret },
      storeKey: 'bizfurniz',
      headers,
      rawBody,
      now: new Date('2026-11-02T01:00:00.000Z'),
    });
    const duplicate = await receiveShopifyOrderWebhook({
      db,
      runtimeEnv: { SHOPIFY_BIZFURNIZ_CLIENT_SECRET: clientSecret },
      storeKey: 'bizfurniz',
      headers,
      rawBody,
      now: new Date('2026-11-02T01:00:01.000Z'),
    });

    expect(first).toMatchObject({
      accepted: true,
      duplicate: false,
      queued: true,
      sourceOrderId: 'gid://shopify/Order/9001',
    });
    expect(duplicate).toMatchObject({ accepted: true, duplicate: true });

    const rows = await db.prepare('SELECT * FROM shopify_webhook_events').all<Record<string, unknown>>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]).toMatchObject({
      tenant_id: tenantId,
      store_key: 'bizfurniz',
      webhook_id: 'webhook-delivery-1',
      topic: 'orders/create',
      source_order_id: 'gid://shopify/Order/9001',
      status: 'pending',
    });
    expect(JSON.stringify(rows.results[0])).not.toContain('customer@example.com');
    expect(JSON.stringify(rows.results[0])).not.toContain('Sensitive address');
  });

  it('请求体被篡改时拒绝入队', async () => {
    const original = new TextEncoder().encode(JSON.stringify({ id: 9001 }));
    const tampered = new TextEncoder().encode(JSON.stringify({ id: 9002 }));
    const headers = await signedHeaders(original, {
      topic: 'orders/updated',
      webhookId: 'webhook-delivery-2',
    });

    await expect(receiveShopifyOrderWebhook({
      db,
      runtimeEnv: { SHOPIFY_BIZFURNIZ_CLIENT_SECRET: clientSecret },
      storeKey: 'bizfurniz',
      headers,
      rawBody: tampered,
    })).rejects.toMatchObject({ code: 'SHOPIFY_WEBHOOK_HMAC_INVALID', status: 401 });

    const count = await db.prepare('SELECT COUNT(*) AS count FROM shopify_webhook_events')
      .first<{ count: number }>();
    expect(count?.count).toBe(0);
  });

  it('退款和履约事件可还原对应的 Shopify Order GID', () => {
    expect(extractShopifyOrderId('refunds/create', { order_id: 7001 }))
      .toBe('gid://shopify/Order/7001');
    expect(extractShopifyOrderId('fulfillments/update', { order_id: '7002' }))
      .toBe('gid://shopify/Order/7002');
    expect(extractShopifyOrderId('orders/updated', {
      admin_graphql_api_id: 'gid://shopify/Order/7003',
    })).toBe('gid://shopify/Order/7003');
  });

  it('HMAC 辅助函数只接受原始请求体的有效签名', async () => {
    const body = new TextEncoder().encode('{"id":1}');
    const signature = await sign(body, clientSecret);
    await expect(verifyShopifyWebhookHmac(body, signature, clientSecret)).resolves.toBe(true);
    await expect(verifyShopifyWebhookHmac(body, `${signature.slice(0, -1)}A`, clientSecret)).resolves.toBe(false);
  });
});

async function signedHeaders(
  rawBody: Uint8Array,
  input: { topic: string; webhookId: string },
) {
  return new Headers({
    'X-Shopify-Hmac-Sha256': await sign(rawBody, clientSecret),
    'X-Shopify-Webhook-Id': input.webhookId,
    'X-Shopify-Topic': input.topic,
    'X-Shopify-Shop-Domain': shopDomain,
    'X-Shopify-API-Version': '2026-07',
    'X-Shopify-Triggered-At': '2026-11-02T01:00:00.000Z',
  });
}

async function sign(rawBody: Uint8Array, secret: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const bodyCopy = new Uint8Array(rawBody.byteLength);
  bodyCopy.set(rawBody);
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, bodyCopy.buffer));
  return Buffer.from(signature).toString('base64');
}

async function applyMigrations(db: D1Database) {
  for (const migration of [
    '../drizzle/0000_wooden_deathstrike.sql',
    '../drizzle/0001_premium_the_stranger.sql',
    '../drizzle/0002_organic_titanium_man.sql',
    '../drizzle/0003_fancy_jane_foster.sql',
    '../drizzle/0004_illegal_black_panther.sql',
  ]) {
    const sql = readFileSync(new URL(migration, import.meta.url), 'utf8');
    for (const statement of sql.split('--> statement-breakpoint').map((item) => item.trim()).filter(Boolean)) {
      await db.prepare(statement).run();
    }
  }
}
