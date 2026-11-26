import { readFileSync } from 'node:fs';
import { Miniflare } from 'miniflare';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const oauthMocks = vi.hoisted(() => ({
  refreshToken: vi.fn(),
}));

vi.mock('../lib/connectors/shopify/oauth', () => ({
  createShopifyOAuthApi: () => ({
    auth: { refreshToken: oauthMocks.refreshToken },
  }),
}));

import {
  loadShopifyOAuthCredential,
  resolveShopifyRuntimeConfig,
  saveShopifyOAuthCredential,
} from '../lib/connectors/shopify/credential-store';

const tenantId = 'tenant_refresh_test';
const encryptionKey = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';

describe('Shopify 过期访问令牌自动刷新', () => {
  let mf: Miniflare;
  let db: D1Database;

  beforeEach(async () => {
    oauthMocks.refreshToken.mockReset();
    mf = new Miniflare({
      modules: true,
      script: 'export default { fetch(){ return new Response("ok") } }',
      d1Databases: ['DB'],
    });
    db = await mf.getD1Database('DB');
    await applyMigrations(db);
    await db.prepare('INSERT INTO tenants (id, name, created_at) VALUES (?, ?, ?)')
      .bind(tenantId, 'Refresh test', new Date().toISOString())
      .run();
  });

  afterEach(async () => mf.dispose());

  it('定时任务解析授权时刷新过期令牌、轮换密文并释放刷新租约', async () => {
    const now = new Date();
    const oldAccessToken = 'shpat_expired_test_token';
    const oldRefreshToken = 'shprt_rotating_test_token';
    const newAccessToken = 'shpat_refreshed_test_token';
    const newRefreshToken = 'shprt_refreshed_test_token';
    await saveShopifyOAuthCredential({
      db,
      tenantId,
      runtimeEnv: { ERP_CONNECTOR_CREDENTIALS_KEY: encryptionKey },
      storeKey: 'bizfurniz',
      shopDomain: 'fixture-bizfurniz-canonical.myshopify.com',
      officialStoreId: 'gid://shopify/Shop/12345678901',
      grantedScopes: 'read_orders',
      session: {
        accessToken: oldAccessToken,
        refreshToken: oldRefreshToken,
        expires: new Date(now.getTime() - 60_000),
        refreshTokenExpires: new Date(now.getTime() + 86_400_000),
      },
      createdBy: 'user_refresh_test',
      now: new Date(now.getTime() - 120_000),
    });
    oauthMocks.refreshToken.mockResolvedValue({
      session: {
        accessToken: newAccessToken,
        refreshToken: newRefreshToken,
        expires: new Date(now.getTime() + 3_600_000),
        refreshTokenExpires: new Date(now.getTime() + 172_800_000),
        scope: 'read_orders',
      },
    });

    const resolved = await resolveShopifyRuntimeConfig({
      db,
      tenantId,
      runtimeEnv: {
        ERP_CONNECTOR_CREDENTIALS_KEY: encryptionKey,
        SHOPIFY_BIZFURNIZ_SHOP_DOMAIN: 'fixture-bizfurniz-canonical.myshopify.com',
        SHOPIFY_BIZFURNIZ_CLIENT_ID: 'test-client-id',
        SHOPIFY_BIZFURNIZ_CLIENT_SECRET: 'test-client-secret',
      },
      storeKey: 'bizfurniz',
      requestUrl: 'https://erp.example/api/connectors/shopify/reconcile',
      now,
    });

    expect(oauthMocks.refreshToken).toHaveBeenCalledWith({
      shop: 'fixture-bizfurniz-canonical.myshopify.com',
      refreshToken: oldRefreshToken,
    });
    expect(resolved.adminAccessToken).toBe(newAccessToken);
    const stored = await loadShopifyOAuthCredential(
      db,
      tenantId,
      'bizfurniz',
      { ERP_CONNECTOR_CREDENTIALS_KEY: encryptionKey },
    );
    expect(stored).toMatchObject({
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
      grantedScopes: 'read_orders',
    });
    const raw = await db.prepare(`
      SELECT access_token_ciphertext, refresh_token_ciphertext, refresh_started_at
      FROM connector_credentials WHERE tenant_id = ? AND store_key = ?
    `).bind(tenantId, 'bizfurniz').first<{
      access_token_ciphertext: string;
      refresh_token_ciphertext: string;
      refresh_started_at: string | null;
    }>();
    expect(raw?.access_token_ciphertext).not.toContain(newAccessToken);
    expect(raw?.refresh_token_ciphertext).not.toContain(newRefreshToken);
    expect(raw?.refresh_started_at).toBeNull();
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
    const statements = sql.split('--> statement-breakpoint')
      .map((item) => item.trim())
      .filter(Boolean);
    for (const statement of statements) await db.prepare(statement).run();
  }
}
