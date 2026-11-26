import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET as completeAuthorization } from '../app/api/connectors/shopify/oauth/[storeKey]/callback/route';
import { GET as startAuthorization } from '../app/api/connectors/shopify/oauth/[storeKey]/start/route';
import { GET as getStatus } from '../app/api/connectors/shopify/status/route';
import { openSqliteD1 } from '../lib/aws/sqlite-d1';
import { ShopifyOrderConnector } from '../lib/connectors/shopify/connector';
import { loadShopifyOAuthCredential, saveShopifyOAuthCredential } from '../lib/connectors/shopify/credential-store';
import type { UserContext } from '../lib/db';
import type { Permission } from '../lib/domain';

const { requestContext, runtime, oauthCallback, registerWebhooks } = vi.hoisted(() => ({
  requestContext: vi.fn(),
  runtime: {} as Record<string, unknown>,
  oauthCallback: vi.fn(),
  registerWebhooks: vi.fn(),
}));
vi.mock('cloudflare:workers', () => ({ env: runtime, waitUntil: () => {} }));
vi.mock('../lib/db', async (original) => ({
  ...await original<typeof import('../lib/db')>(),
  requestContext,
}));
vi.mock('../lib/connectors/shopify/oauth', async (original) => {
  const oauth = await original<typeof import('../lib/connectors/shopify/oauth')>();
  return {
    ...oauth,
    createShopifyOAuthApi(...args: Parameters<typeof oauth.createShopifyOAuthApi>) {
      const api = oauth.createShopifyOAuthApi(...args);
      return { ...api, auth: { ...api.auth, callback: oauthCallback } };
    },
  };
});
vi.mock('../lib/connectors/shopify/webhook-registration', () => ({
  ensureShopifyOrderWebhookSubscriptions: registerWebhooks,
}));

const tenantId = 'shopify-scope-fixture';
const otherTenantId = 'shopify-other-tenant-fixture';
const operatorEmail = 'operator@example.test';
const origin = 'https://erp.example.test';
const storePath = '/api/connectors/shopify/oauth/bizfurniz';
const shop = {
  id: 'gid://shopify/Shop/100',
  name: 'BizFurniz fixture',
  domain: 'fixture-bizfurniz-canonical.myshopify.com',
  timezone: 'Asia/Shanghai',
  timezoneOffset: '+0800',
  currency: 'USD',
};

describe('Shopify 店铺只读授权', () => {
  let connection: ReturnType<typeof openSqliteD1>;
  let db: D1Database;

  async function saveOrdersCredential() {
    await saveShopifyOAuthCredential({
      db, tenantId, runtimeEnv: runtime, storeKey: 'bizfurniz', shopDomain: shop.domain, officialStoreId: shop.id,
      grantedScopes: 'read_orders', session: { accessToken: 'fixture-orders-token' }, createdBy: 'fixture-user',
    });
  }

  function signIn(permissions: Permission[], email = operatorEmail, workspace = tenantId) {
    requestContext.mockResolvedValue({ db, user: { id: 'fixture-user', tenantId: workspace, email, permissions } });
  }

  function begin(storeKey: string) {
    return startAuthorization(new Request(`${origin}/api/connectors/shopify/oauth/${storeKey}/start`), {
      params: Promise.resolve({ storeKey }),
    });
  }

  function complete() {
    return completeAuthorization(new Request(`${origin}${storePath}/callback`), { params: Promise.resolve({ storeKey: 'bizfurniz' }) });
  }

  async function status() {
    const response = await getStatus(new Request(`${origin}/api/connectors/shopify/status`));
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const payload = await response.json() as { stores: { key: string }[] };
    return Object.fromEntries(payload.stores.map((store) => [store.key, store]));
  }

  beforeEach(async () => {
    connection = openSqliteD1(':memory:', fileURLToPath(new URL('../drizzle/', import.meta.url)));
    db = connection.db;
    for (const workspace of [tenantId, otherTenantId]) {
      await db.prepare('INSERT INTO tenants (id, name, created_at) VALUES (?, ?, ?)')
        .bind(workspace, '测试公司', '2026-11-25T00:00:00.000Z').run();
    }
    for (const key of Object.keys(runtime)) delete runtime[key];
    Object.assign(runtime, {
      ERP_ALLOWED_EMAILS: operatorEmail,
      ERP_ALLOWED_EMAIL_DOMAINS: 'example.test',
      ERP_CONNECTOR_CREDENTIALS_KEY: btoa('x'.repeat(32)),
      SHOPIFY_ZIMASYA_SHOP_DOMAIN: 'fixture-zimasya.myshopify.com',
      SHOPIFY_ZIMASYA_CLIENT_ID: 'fixture-zimasya-app',
      SHOPIFY_ZIMASYA_CLIENT_SECRET: 'fixture-zimasya-secret',
      SHOPIFY_BIZFURNIZ_SHOP_DOMAIN: shop.domain,
      SHOPIFY_BIZFURNIZ_CLIENT_ID: 'fixture-bizfurniz-app',
      SHOPIFY_BIZFURNIZ_CLIENT_SECRET: 'fixture-bizfurniz-secret',
    });
    signIn(['connectors:read', 'connectors:sync']);
    oauthCallback.mockReset().mockResolvedValue({
      session: { shop: shop.domain, accessToken: 'fixture-catalog-token' }, headers: new Headers(),
    });
    registerWebhooks.mockReset().mockResolvedValue({ created: 0, updated: 0, unchanged: 0 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    connection.close();
  });

  it('OAuth URL 仅向已启用的店铺请求商品和库存，只发送一次每项读取权限', async () => {
    runtime.SHOPIFY_BIZFURNIZ_CATALOG_READ_ENABLED = 'true';
    const defaultRedirect = await begin('zimasya');
    const catalogRedirect = await begin('bizfurniz');
    expect(defaultRedirect.status).toBe(302);
    expect(catalogRedirect.status).toBe(302);
    expect(new URL(defaultRedirect.headers.get('Location')!).searchParams.get('scope')).toBe('read_orders');
    expect(new URL(catalogRedirect.headers.get('Location')!).searchParams.get('scope')?.split(',').sort()).toEqual([
      'read_inventory', 'read_orders', 'read_products',
    ]);
  });

  it('保留原订单权限，显示缺口且仅向允许的同步操作员提供补授权入口', async () => {
    await saveOrdersCredential();
    const defaultStatus = (await status()).bizfurniz;
    expect(defaultStatus).toMatchObject({
      accessCapabilities: { orders: 'granted', products: 'missing', inventory: 'missing' },
      authorizationStartUrl: null, reauthorizationRequired: false,
    });
    runtime.SHOPIFY_BIZFURNIZ_CATALOG_READ_ENABLED = 'true';
    runtime.SHOPIFY_KAGUYASU_SHOP_DOMAIN = 'fixture-kaguyasu.myshopify.com';
    runtime.SHOPIFY_KAGUYASU_ADMIN_ACCESS_TOKEN = 'fixture-env-token';
    const currentStatus = await status();
    expect(currentStatus.bizfurniz).toMatchObject({
      credentialsConfigured: true, catalogReadEnabled: true, authorizationRequired: false, reauthorizationRequired: true,
      authorizationStartUrl: `${storePath}/start`, missingRequestedScopes: ['read_products', 'read_inventory'],
      accessCapabilities: { orders: 'granted', products: 'missing', inventory: 'missing' },
    });
    expect(currentStatus.kaguyasu).toMatchObject({ accessCapabilities: { orders: 'unknown', products: 'unknown', inventory: 'unknown' } });
    expect(JSON.stringify(currentStatus)).not.toMatch(/fixture-(?:orders-token|env-token|bizfurniz-secret)/);

    signIn(['connectors:read']);
    expect((await status()).bizfurniz).toMatchObject({ reauthorizationRequired: true, authorizationStartUrl: null });
    expect((await begin('bizfurniz')).status).toBe(403);

    signIn(['connectors:read', 'connectors:sync'], 'different@example.test');
    expect((await status()).bizfurniz).toMatchObject({ authorizationStartUrl: null });
    const denied = await begin('bizfurniz');
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ code: 'ERP_SYNC_OPERATOR_EMAIL_REQUIRED' });

    signIn(['connectors:read'], operatorEmail, otherTenantId);
    expect((await status()).bizfurniz).toMatchObject({
      credentialsConfigured: false, authorizationStartUrl: null,
      accessCapabilities: { orders: 'unconfigured', products: 'unconfigured', inventory: 'unconfigured' },
    });
    signIn([]);
    expect((await getStatus(new Request(`${origin}/api/connectors/shopify/status`))).status).toBe(403);
  });

  it('保留旧授权直到获得新的订单只读权限，商品库存授权可单独补齐', async () => {
    await saveOrdersCredential();
    runtime.SHOPIFY_BIZFURNIZ_CATALOG_READ_ENABLED = 'true';
    const shopContext = vi.spyOn(ShopifyOrderConnector.prototype, 'getShopContext').mockResolvedValue({
      ...shop, scopes: new Set(['read_products']),
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});

    const incomplete = await complete();
    const incompleteLocation = new URL(incomplete.headers.get('Location')!, origin);
    expect(incompleteLocation.searchParams.get('code')).toBe('SHOPIFY_REQUIRED_SCOPE_MISSING');
    expect(await loadShopifyOAuthCredential(db, tenantId, 'bizfurniz', runtime)).toMatchObject({
      accessToken: 'fixture-orders-token', grantedScopes: 'read_orders',
    });
    expect(registerWebhooks).not.toHaveBeenCalled();

    shopContext.mockResolvedValue({ ...shop, scopes: new Set(['read_orders', 'read_products', 'read_inventory', 'write_inventory']) });
    const writable = await complete();
    expect(new URL(writable.headers.get('Location')!, origin).searchParams.get('code')).toBe('SHOPIFY_AUTH_WRITABLE_SCOPE');
    expect(await loadShopifyOAuthCredential(db, tenantId, 'bizfurniz', runtime)).toMatchObject({ accessToken: 'fixture-orders-token' });
    expect(registerWebhooks).not.toHaveBeenCalled();

    shopContext.mockResolvedValue({ ...shop, scopes: new Set(['read_orders', 'read_products']) });
    const partial = await complete();
    const partialStatus = new URL(partial.headers.get('Location')!, origin).searchParams;
    expect(partialStatus.get('status')).toBe('connected');
    expect(partialStatus.get('catalog')).toBe('pending');
    expect(await loadShopifyOAuthCredential(db, tenantId, 'bizfurniz', runtime)).toMatchObject({
      accessToken: 'fixture-catalog-token', grantedScopes: 'read_orders,read_products',
    });
    expect((await status()).bizfurniz).toMatchObject({ reauthorizationRequired: true, missingRequestedScopes: ['read_inventory'] });

    shopContext.mockResolvedValue({ ...shop, scopes: new Set(['read_orders', 'read_products', 'read_inventory']) });
    const upgraded = await complete();
    expect(new URL(upgraded.headers.get('Location')!, origin).searchParams.get('status')).toBe('connected');
    expect(registerWebhooks).toHaveBeenCalledTimes(2);
    expect((await status()).bizfurniz).toMatchObject({
      accessCapabilities: { orders: 'granted', products: 'granted', inventory: 'granted' },
      authorizationStartUrl: null, missingRequestedScopes: [], reauthorizationRequired: false,
    });
  });

  it('仅 AWS 中已验证且不限店铺的飞书管理员可在已配置访问规则时授权', async () => {
    await saveOrdersCredential();
    runtime.ERP_HOST_RUNTIME = 'aws';
    runtime.ERP_PUBLIC_ORIGIN = origin;
    runtime.SHOPIFY_BIZFURNIZ_CATALOG_READ_ENABLED = 'true';
    const feishuAdministrator: UserContext = {
      id: 'feishu:fixture-operator', email: 'unlisted@example.test', displayName: '飞书测试管理员',
      role: 'admin', authProvider: 'feishu', permissions: ['connectors:read', 'connectors:sync'],
      tenantId, tenantName: '测试公司',
    };
    requestContext.mockResolvedValue({ db, user: feishuAdministrator });
    expect((await status()).bizfurniz).toMatchObject({ authorizationStartUrl: `${storePath}/start` });
    expect((await begin('bizfurniz')).status).toBe(302);

    for (const restrictions of [
      { authProvider: 'existing' }, { id: 'unverified-fixture' }, { role: 'operator' }, { accessProfile: 'independent_site' },
    ] as const) {
      requestContext.mockResolvedValue({ db, user: { ...feishuAdministrator, ...restrictions } });
      expect((await status()).bizfurniz).toMatchObject({ authorizationStartUrl: null });
      expect((await begin('bizfurniz')).status).toBe(403);
    }

    requestContext.mockResolvedValue({ db, user: feishuAdministrator });
    delete runtime.ERP_ALLOWED_EMAILS;
    delete runtime.ERP_ALLOWED_EMAIL_DOMAINS;
    expect((await status()).bizfurniz).toMatchObject({ authorizationStartUrl: null });
    expect((await begin('bizfurniz')).status).toBe(503);
  });
});
