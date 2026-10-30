import { readFileSync } from 'node:fs';
import { Miniflare } from 'miniflare';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  loadShopifyOAuthCredential,
  resolveShopifyRuntimeConfig,
  saveShopifyOAuthCredential,
} from '../lib/connectors/shopify/credential-store';

const tenantId = 'tenant_credential_test';
const encryptionKey = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
const otherKey = 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';

describe('Shopify OAuth 凭证 D1 存储', () => {
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
      .bind(tenantId, 'Test', '2026-10-31T00:00:00.000Z')
      .run();
  });

  afterEach(async () => mf.dispose());

  it('只落密文并能按租户和店铺安全读取', async () => {
    await saveShopifyOAuthCredential({
      db,
      tenantId,
      runtimeEnv: { ERP_CONNECTOR_CREDENTIALS_KEY: encryptionKey },
      storeKey: 'bizfurniz',
      shopDomain: 'z6w01w-xs.myshopify.com',
      officialStoreId: 'gid://shopify/Shop/100191109201',
      grantedScopes: 'read_orders',
      session: {
        accessToken: 'shpat_test_access_token',
        refreshToken: 'shprt_test_refresh_token',
        expires: new Date('2026-10-31T02:00:00.000Z'),
        refreshTokenExpires: new Date('2027-01-29T00:00:00.000Z'),
      },
      createdBy: 'user_test',
      now: new Date('2026-10-31T00:00:00.000Z'),
    });
    const raw = await db.prepare(`
      SELECT access_token_ciphertext, refresh_token_ciphertext
      FROM connector_credentials WHERE tenant_id = ? AND store_key = ?
    `).bind(tenantId, 'bizfurniz').first<{
      access_token_ciphertext: string;
      refresh_token_ciphertext: string;
    }>();
    expect(raw?.access_token_ciphertext).not.toContain('shpat_test_access_token');
    expect(raw?.refresh_token_ciphertext).not.toContain('shprt_test_refresh_token');

    const stored = await loadShopifyOAuthCredential(
      db,
      tenantId,
      'bizfurniz',
      { ERP_CONNECTOR_CREDENTIALS_KEY: encryptionKey },
    );
    expect(stored).toMatchObject({
      shopDomain: 'z6w01w-xs.myshopify.com',
      officialStoreId: 'gid://shopify/Shop/100191109201',
      accessToken: 'shpat_test_access_token',
      refreshToken: 'shprt_test_refresh_token',
    });
  });

  it('OAuth D1 凭证优先于遗留环境 Token，错误密钥拒绝解密', async () => {
    await saveShopifyOAuthCredential({
      db,
      tenantId,
      runtimeEnv: { ERP_CONNECTOR_CREDENTIALS_KEY: encryptionKey },
      storeKey: 'bizfurniz',
      shopDomain: 'z6w01w-xs.myshopify.com',
      officialStoreId: 'gid://shopify/Shop/100191109201',
      grantedScopes: 'read_orders',
      session: { accessToken: 'shpat_oauth_token' },
      createdBy: 'user_test',
    });
    const resolved = await resolveShopifyRuntimeConfig({
      db,
      tenantId,
      runtimeEnv: {
        ERP_CONNECTOR_CREDENTIALS_KEY: encryptionKey,
        SHOPIFY_BIZFURNIZ_ADMIN_ACCESS_TOKEN: 'shpat_legacy_env_token',
      },
      storeKey: 'bizfurniz',
      requestUrl: 'https://yicang-erp.example/api/connectors/shopify/sync',
    });
    expect(resolved.adminAccessToken).toBe('shpat_oauth_token');
    await expect(loadShopifyOAuthCredential(
      db,
      tenantId,
      'bizfurniz',
      { ERP_CONNECTOR_CREDENTIALS_KEY: otherKey },
    )).rejects.toMatchObject({ code: 'SHOPIFY_CREDENTIAL_DECRYPT_FAILED' });
  });
});

async function applyMigrations(db: D1Database) {
  for (const migration of [
    '../drizzle/0000_wooden_deathstrike.sql',
    '../drizzle/0001_premium_the_stranger.sql',
    '../drizzle/0002_organic_titanium_man.sql',
    '../drizzle/0003_fancy_jane_foster.sql',
  ]) {
    const sql = readFileSync(new URL(migration, import.meta.url), 'utf8');
    for (const statement of sql.split('--> statement-breakpoint').map((item) => item.trim()).filter(Boolean)) {
      await db.prepare(statement).run();
    }
  }
}
