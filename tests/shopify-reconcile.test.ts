import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({ env: {} }));

import { handleShopifyReconcileRequest } from '../app/api/connectors/shopify/reconcile/route';
import { openSqliteD1 } from '../lib/aws/sqlite-d1';
import {
  resolveShopifyStoreConfig,
  type ShopifyCredentialConfig,
  type ShopifyStoreKey,
} from '../lib/connectors/shopify/config';
import { saveShopifyOAuthCredential } from '../lib/connectors/shopify/credential-store';
import { ShopifyConnectorError } from '../lib/connectors/shopify/errors';
import { reconcileStoredShopifyOrders } from '../lib/connectors/shopify/reconcile';

const internalToken = 'test-internal-job-token-at-least-32-characters';

describe('Shopify 内部定时对账入口', () => {
  it('即使开放开发模式也强制独立 Bearer 密钥', async () => {
    const reconcile = vi.fn();
    const runtimeEnv = {
      DB: {} as D1Database,
      ERP_DEV_OPEN_ACCESS: 'true',
      ERP_INTERNAL_JOB_TOKEN: internalToken,
    };
    const missing = await handleShopifyReconcileRequest(
      new Request('https://erp.example/api/connectors/shopify/reconcile', { method: 'POST' }),
      runtimeEnv,
      { ensureDatabase: async () => {}, reconcile },
    );
    expect(missing.status).toBe(401);
    expect(await missing.json()).toMatchObject({ code: 'INTERNAL_JOB_UNAUTHORIZED' });

    const wrong = await handleShopifyReconcileRequest(
      new Request('https://erp.example/api/connectors/shopify/reconcile', {
        method: 'POST',
        headers: { Authorization: 'Bearer wrong-token' },
      }),
      runtimeEnv,
      { ensureDatabase: async () => {}, reconcile },
    );
    expect(wrong.status).toBe(401);
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('认证后接受店铺子集并返回无缓存的安全调度状态', async () => {
    const reconcile = vi.fn(async () => ({
      ok: true,
      noConfiguredStores: false,
      skipReason: null,
      storesChecked: 1,
      synced: [{
        storeKey: 'bizfurniz' as const,
        pagesCompleted: 1,
        ordersSeen: 1,
        ordersInserted: 0,
        ordersUpdated: 0,
        ordersUnchanged: 1,
        completedAt: '2026-11-02T10:00:00.000Z',
      }],
      skipped: [],
      failed: [],
    }));
    const response = await handleShopifyReconcileRequest(
      new Request('https://erp.example/api/connectors/shopify/reconcile', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${internalToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ storeKeys: ['bizfurniz'], maxPages: 20 }),
      }),
      { DB: {} as D1Database, ERP_INTERNAL_JOB_TOKEN: internalToken },
      { ensureDatabase: async () => {}, reconcile },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(reconcile).toHaveBeenCalledWith(expect.objectContaining({
      storeKeys: ['bizfurniz'], maxPages: 20,
    }));
    const payload = await response.json() as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: true,
      scheduling: { externalScheduleConfigured: false, recommendedIntervalMinutes: 15 },
    });
    expect(JSON.stringify(payload)).not.toContain(internalToken);
  });

  it('没有任何可用授权时明确返回未配置状态', async () => {
    const reconcile = vi.fn(async () => ({
      ok: false,
      noConfiguredStores: true,
      skipReason: 'SHOPIFY_NO_CONFIGURED_STORES' as const,
      storesChecked: 0,
      synced: [],
      skipped: [],
      failed: [],
    }));
    const response = await handleShopifyReconcileRequest(
      authorizedRequest({}),
      { DB: {} as D1Database, ERP_INTERNAL_JOB_TOKEN: internalToken },
      { ensureDatabase: async () => {}, reconcile },
    );
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({
      ok: false,
      noConfiguredStores: true,
      skipReason: 'SHOPIFY_NO_CONFIGURED_STORES',
      storesChecked: 0,
    });
  });

  it('拒绝未知店铺、额外参数和未配置内部密钥', async () => {
    const dependencies = { ensureDatabase: async () => {}, reconcile: vi.fn() };
    const unknownStore = await handleShopifyReconcileRequest(
      authorizedRequest({ storeKeys: ['unknown-store'] }),
      { DB: {} as D1Database, ERP_INTERNAL_JOB_TOKEN: internalToken },
      dependencies,
    );
    expect(unknownStore.status).toBe(400);
    expect(await unknownStore.json()).toMatchObject({ code: 'INVALID_SHOPIFY_RECONCILE_REQUEST' });

    const extra = await handleShopifyReconcileRequest(
      authorizedRequest({ force: true }),
      { DB: {} as D1Database, ERP_INTERNAL_JOB_TOKEN: internalToken },
      dependencies,
    );
    expect(extra.status).toBe(400);

    const missingConfig = await handleShopifyReconcileRequest(
      authorizedRequest({}),
      { DB: {} as D1Database },
      dependencies,
    );
    expect(missingConfig.status).toBe(503);
    expect(await missingConfig.json()).toMatchObject({ code: 'INTERNAL_JOB_TOKEN_MISSING' });
    expect(dependencies.reconcile).not.toHaveBeenCalled();
  });
});

describe('Shopify 已授权店铺定时对账编排', () => {
  it('逐店隔离失败且永不返回租户、Token、域名或客户数据', async () => {
    const resolveConfig = vi.fn(async (input: { storeKey: ShopifyStoreKey }) => config(input.storeKey));
    const runSync = vi.fn(async (input: { config: ShopifyCredentialConfig }) => {
      if (input.config.key === 'zimasya') {
        throw new ShopifyConnectorError('SHOPIFY_TEMPORARY_ERROR', '临时失败', true);
      }
      return syncResult(input.config.key, { ordersUpdated: 1 });
    });
    const result = await reconcileStoredShopifyOrders({
      db: {} as D1Database,
      runtimeEnv: {},
      requestUrl: 'https://erp.example/api/connectors/shopify/reconcile',
      maxPages: 100,
      dependencies: {
        loadTargets: async () => [
          { tenantId: 'tenant-private-a', storeKey: 'bizfurniz' },
          { tenantId: 'tenant-private-b', storeKey: 'zimasya' },
        ],
        resolveConfig,
        runSync: runSync as never,
      },
    });
    expect(result).toEqual({
      ok: false,
      noConfiguredStores: false,
      skipReason: null,
      storesChecked: 2,
      synced: [expect.objectContaining({ storeKey: 'bizfurniz', ordersUpdated: 1 })],
      skipped: [],
      failed: [{ storeKey: 'zimasya', code: 'SHOPIFY_TEMPORARY_ERROR', retryable: true }],
    });
    expect(resolveConfig).toHaveBeenCalledTimes(2);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('tenant-private');
    expect(serialized).not.toContain('secret-access-token');
    expect(serialized).not.toContain('myshopify.com');
    expect(serialized).not.toContain('customer');
  });

  it('默认把服务端 ADMIN_ACCESS_TOKEN 店铺纳入目标', async () => {
    const resolveConfig = vi.fn(async () => config('bizfurniz'));
    const runSync = vi.fn(async () => syncResult('bizfurniz'));
    const result = await reconcileStoredShopifyOrders({
      db: {} as D1Database,
      runtimeEnv: {
        SHOPIFY_BIZFURNIZ_SHOP_DOMAIN: config('bizfurniz').domain,
        SHOPIFY_BIZFURNIZ_ADMIN_ACCESS_TOKEN: 'secret-environment-access-token',
      },
      requestUrl: 'https://erp.example/api/connectors/shopify/reconcile',
      maxPages: 20,
      dependencies: {
        loadTargets: async () => [],
        resolveConfig,
        runSync: runSync as never,
      },
    });
    expect(result).toMatchObject({
      ok: true,
      noConfiguredStores: false,
      skipReason: null,
      storesChecked: 1,
    });
    expect(resolveConfig).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant_yicang_primary',
      storeKey: 'bizfurniz',
    }));
    expect(runSync).toHaveBeenCalledTimes(1);
  });

  it('同店同时有 D1 OAuth 和环境 Token 时只同步一次且 D1 租户优先', async () => {
    const resolveConfig = vi.fn(async () => config('bizfurniz'));
    const runSync = vi.fn(async () => syncResult('bizfurniz'));
    const result = await reconcileStoredShopifyOrders({
      db: {} as D1Database,
      runtimeEnv: {
        SHOPIFY_BIZFURNIZ_SHOP_DOMAIN: config('bizfurniz').domain,
        SHOPIFY_BIZFURNIZ_ADMIN_ACCESS_TOKEN: 'secret-environment-access-token',
      },
      requestUrl: 'https://erp.example/api/connectors/shopify/reconcile',
      maxPages: 20,
      dependencies: {
        loadTargets: async () => [{ tenantId: 'tenant-oauth-owner', storeKey: 'bizfurniz' }],
        resolveConfig,
        runSync: runSync as never,
      },
    });
    expect(result.storesChecked).toBe(1);
    expect(resolveConfig).toHaveBeenCalledTimes(1);
    expect(resolveConfig).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-oauth-owner',
      storeKey: 'bizfurniz',
    }));
    expect(runSync).toHaveBeenCalledTimes(1);
  });

  it('没有 D1 OAuth 或环境 Token 时不把空跑标记为成功', async () => {
    const resolveConfig = vi.fn();
    const runSync = vi.fn();
    const result = await reconcileStoredShopifyOrders({
      db: {} as D1Database,
      runtimeEnv: {},
      requestUrl: 'https://erp.example/api/connectors/shopify/reconcile',
      maxPages: 20,
      dependencies: {
        loadTargets: async () => [],
        resolveConfig,
        runSync: runSync as never,
      },
    });
    expect(result).toEqual({
      ok: false,
      noConfiguredStores: true,
      skipReason: 'SHOPIFY_NO_CONFIGURED_STORES',
      storesChecked: 0,
      synced: [],
      skipped: [],
      failed: [],
    });
    expect(resolveConfig).not.toHaveBeenCalled();
    expect(runSync).not.toHaveBeenCalled();
  });

  it('未授权候选即使 SHOP_DOMAIN 写错也不会拖垮目标发现', async () => {
    const resolveConfig = vi.fn();
    const runSync = vi.fn();
    const result = await reconcileStoredShopifyOrders({
      db: {} as D1Database,
      runtimeEnv: {
        SHOPIFY_ZIMASYA_SHOP_DOMAIN: 'not-a-shopify-domain.example',
      },
      requestUrl: 'https://erp.example/api/connectors/shopify/reconcile',
      maxPages: 20,
      dependencies: {
        loadTargets: async () => [],
        resolveConfig,
        runSync: runSync as never,
      },
    });

    expect(result).toEqual({
      ok: false,
      noConfiguredStores: true,
      skipReason: 'SHOPIFY_NO_CONFIGURED_STORES',
      storesChecked: 0,
      synced: [],
      skipped: [],
      failed: [],
    });
    expect(resolveConfig).not.toHaveBeenCalled();
    expect(runSync).not.toHaveBeenCalled();
  });

  it('单个已配置店铺域名错误时隔离失败并继续同步其他店铺', async () => {
    const runtimeEnv = {
      SHOPIFY_ZIMASYA_ADMIN_ACCESS_TOKEN: 'secret-bad-store-token',
      SHOPIFY_ZIMASYA_SHOP_DOMAIN: 'not-a-shopify-domain.example',
      SHOPIFY_BIZFURNIZ_SHOP_DOMAIN: config('bizfurniz').domain,
      SHOPIFY_BIZFURNIZ_ADMIN_ACCESS_TOKEN: 'secret-good-store-token',
    };
    const resolveConfig = vi.fn(async (input: { storeKey: ShopifyStoreKey }) => (
      resolveShopifyStoreConfig(runtimeEnv, input.storeKey)
    ));
    const runSync = vi.fn(async (input: { config: ShopifyCredentialConfig }) => (
      syncResult(input.config.key)
    ));
    const result = await reconcileStoredShopifyOrders({
      db: {} as D1Database,
      runtimeEnv,
      requestUrl: 'https://erp.example/api/connectors/shopify/reconcile',
      maxPages: 20,
      dependencies: {
        loadTargets: async () => [],
        resolveConfig,
        runSync: runSync as never,
      },
    });

    expect(result).toEqual({
      ok: false,
      noConfiguredStores: false,
      skipReason: null,
      storesChecked: 2,
      synced: [expect.objectContaining({ storeKey: 'bizfurniz' })],
      skipped: [],
      failed: [{ storeKey: 'zimasya', code: 'SHOPIFY_SYNC_FAILED', retryable: false }],
    });
    expect(runSync).toHaveBeenCalledTimes(1);
    expect(runSync).toHaveBeenCalledWith(expect.objectContaining({
      config: expect.objectContaining({ key: 'bizfurniz' }),
    }));
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('not-a-shopify-domain');
    expect(serialized).not.toContain('secret-');
  });

  it('每次运行都先解析运行时授权，使过期 Token 走统一刷新路径', async () => {
    const resolveConfig = vi.fn(async () => config('bizfurniz'));
    const runSync = vi.fn(async () => syncResult('bizfurniz'));
    await reconcileStoredShopifyOrders({
      db: {} as D1Database,
      runtimeEnv: { ERP_CONNECTOR_CREDENTIALS_KEY: 'encrypted-key' },
      requestUrl: 'https://erp.example/api/connectors/shopify/reconcile',
      storeKeys: ['bizfurniz'],
      maxPages: 20,
      dependencies: {
        loadTargets: async () => [{ tenantId: 'tenant-private', storeKey: 'bizfurniz' }],
        resolveConfig,
        runSync: runSync as never,
      },
    });
    expect(resolveConfig).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-private',
      storeKey: 'bizfurniz',
      requestUrl: 'https://erp.example/api/connectors/shopify/reconcile',
    }));
    expect(runSync).toHaveBeenCalledWith(expect.objectContaining({ maxPages: 20 }));
  });

  it('限定店铺且重复运行时透传 unchanged 结果，不重复制造订单', async () => {
    let run = 0;
    const runSync = vi.fn(async () => {
      run += 1;
      return syncResult('bizfurniz', run === 1
        ? { ordersInserted: 1, ordersUnchanged: 0 }
        : { ordersInserted: 0, ordersUnchanged: 1 });
    });
    const input = {
      db: {} as D1Database,
      runtimeEnv: {},
      requestUrl: 'https://erp.example/api/connectors/shopify/reconcile',
      storeKeys: ['bizfurniz'] as ShopifyStoreKey[],
      maxPages: 20,
      dependencies: {
        loadTargets: async () => [{ tenantId: 'tenant-private', storeKey: 'bizfurniz' }],
        resolveConfig: async () => config('bizfurniz'),
        runSync: runSync as never,
      },
    };
    const first = await reconcileStoredShopifyOrders(input);
    const repeated = await reconcileStoredShopifyOrders(input);
    expect(first.synced[0]).toMatchObject({ ordersInserted: 1, ordersUnchanged: 0 });
    expect(repeated.synced[0]).toMatchObject({ ordersInserted: 0, ordersUnchanged: 1 });
    expect(runSync).toHaveBeenCalledTimes(2);
  });

  it('明确请求尚未授权的店铺时安全跳过，默认不扫描未授权候选', async () => {
    const runSync = vi.fn();
    const result = await reconcileStoredShopifyOrders({
      db: {} as D1Database,
      runtimeEnv: {},
      requestUrl: 'https://erp.example/api/connectors/shopify/reconcile',
      storeKeys: ['bizfurniz', 'anzhap'],
      maxPages: 20,
      dependencies: {
        loadTargets: async () => [{ tenantId: 'tenant-private', storeKey: 'bizfurniz' }],
        resolveConfig: async () => config('bizfurniz'),
        runSync: runSync as never,
      },
    });
    expect(result.skipped).toEqual([{ storeKey: 'anzhap', code: 'SHOPIFY_AUTHORIZATION_REQUIRED' }]);
    expect(runSync).toHaveBeenCalledTimes(1);
  });

  it('可由托管任务限定到数据库选出的租户范围', async () => {
    const resolveConfig = vi.fn(async (input: { storeKey: ShopifyStoreKey }) => config(input.storeKey));
    const runSync = vi.fn(async () => syncResult('bizfurniz'));
    const result = await reconcileStoredShopifyOrders({
      db: {} as D1Database,
      runtimeEnv: {},
      requestUrl: 'https://erp.example',
      tenantIds: ['tenant-allowed'],
      maxPages: 20,
      dependencies: {
        loadTargets: async () => [
          { tenantId: 'tenant-allowed', storeKey: 'bizfurniz' },
          { tenantId: 'tenant-outside', storeKey: 'zimasya' },
        ],
        resolveConfig,
        runSync: runSync as never,
      },
    });
    expect(result.storesChecked).toBe(1);
    expect(resolveConfig).toHaveBeenCalledTimes(1);
    expect(resolveConfig).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-allowed',
      storeKey: 'bizfurniz',
    }));
  });
});

describe('Shopify 后台首次回补', () => {
  const tenantId = 'tenant_yicang_primary';
  const biz = config('bizfurniz');
  const zimasya = config('zimasya');
  const firstAt = '2026-11-26T00:03:00.000Z';
  const firstOrderId = 'gid://shopify/Order/1';
  const secondOrderId = 'gid://shopify/Order/2';
  const nextPage = 'checkpoint-from-shopify';
  const shopId = 'gid://shopify/Shop/7';
  let connection: ReturnType<typeof openSqliteD1>;
  let runtimeEnv: Record<string, unknown> & { DB: D1Database };

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(firstAt));
    connection = openSqliteD1(':memory:', fileURLToPath(new URL('../drizzle/', import.meta.url)));
    const db = connection.db;
    await db.prepare('INSERT INTO tenants (id, name, created_at) VALUES (?, ?, ?)').bind(tenantId, '测试公司', firstAt).run();
    runtimeEnv = {
      DB: db,
      ERP_INTERNAL_JOB_TOKEN: internalToken,
      ERP_CONNECTOR_CREDENTIALS_KEY: btoa('x'.repeat(32)),
      SHOPIFY_BIZFURNIZ_SHOP_DOMAIN: biz.domain,
      SHOPIFY_ZIMASYA_SHOP_DOMAIN: zimasya.domain,
    };
    await saveShopifyOAuthCredential({
      db, tenantId, runtimeEnv, storeKey: biz.key, shopDomain: biz.domain, officialStoreId: shopId,
      grantedScopes: 'read_orders', session: { accessToken: 'fixture-token' }, createdBy: 'fixture-operator',
    });
  });

  afterEach(() => {
    connection.close();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function scheduledRun(storeKeys: ShopifyStoreKey[], maxPages = 1) {
    return handleShopifyReconcileRequest(authorizedRequest({ storeKeys, maxPages }), runtimeEnv, { ensureDatabase: async () => {} });
  }

  function fixtureShop(domain = biz.domain, id = shopId, scopes = ['read_orders']) {
    return {
      shop: { id, myshopifyDomain: domain, name: 'Fixture', ianaTimezone: 'Asia/Shanghai', timezoneOffset: '+0800', currencyCode: 'USD' },
      currentAppInstallation: { accessScopes: scopes.map((handle) => ({ handle })) },
    };
  }

  function syncState() {
    return connection.db.prepare(`
      SELECT status, completed_watermark, active_window_start, active_window_end, next_page_cursor
      FROM connector_sync_state WHERE tenant_id = ? AND connector = 'shopify' AND resource = 'orders'
    `).bind(tenantId).first();
  }

  it('按店铺开启、固定七天窗口和断点，完成后按原水位增量去重', async () => {
    const searches: Array<{ fromAndTo: string; after: string | null }> = [];
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      expect(String(url)).toBe(`https://${biz.domain}/admin/api/2026-07/graphql.json`);
      const operation = JSON.parse(String(init?.body)) as {
        query: string;
        variables: { after: string | null; query: string; id: string };
      };
      expect(operation.query).toMatch(/^query /);
      if (operation.query.startsWith('query ErpShopContext')) return Response.json({ data: fixtureShop() });
      const updatedAt = '2026-11-25T22:00:00.000Z';
      const pageInfo = { hasNextPage: false, endCursor: null };
      if (operation.query.startsWith('query ErpOrdersPage')) {
        searches.push({ fromAndTo: operation.variables.query, after: operation.variables.after });
        const first = searches.length === 1;
        const nodes = [{ id: first ? firstOrderId : secondOrderId, updatedAt }];
        const pagination = first ? { hasNextPage: true, endCursor: nextPage } : pageInfo;
        return Response.json({ data: { orders: { nodes, pageInfo: pagination } } });
      }
      expect(operation.query).toMatch(/^query ErpOrderDetails/);
      const order = {
        id: operation.variables.id, name: '#QA', createdAt: updatedAt, updatedAt, currencyCode: 'USD',
        lineItems: { nodes: [], pageInfo }, refunds: [], fulfillments: [],
      };
      return Response.json({ data: { order } });
    });
    vi.stubGlobal('fetch', fetchMock);
    runtimeEnv.SHOPIFY_ZIMASYA_INITIAL_BACKFILL_ENABLED = 'true';
    const disabled = await scheduledRun(['bizfurniz']);
    expect(disabled.status).toBe(207);
    expect(await disabled.json()).toMatchObject({ failed: [{ storeKey: biz.key, code: 'SHOPIFY_INITIAL_RANGE_REQUIRED' }] });
    expect(searches).toEqual([]);
    expect(await syncState()).toBeNull();

    runtimeEnv.SHOPIFY_BIZFURNIZ_INITIAL_BACKFILL_ENABLED = 'true';
    const partial = await scheduledRun(['bizfurniz']);
    expect(partial.status).toBe(207);
    expect(await partial.json()).toMatchObject({ failed: [{ storeKey: biz.key, code: 'SHOPIFY_PAGE_LIMIT_REACHED', retryable: true }] });
    expect(await syncState()).toEqual({
      status: 'failed', completed_watermark: null, active_window_start: '2026-11-19T00:03:00.000Z',
      active_window_end: firstAt, next_page_cursor: nextPage,
    });

    vi.setSystemTime(new Date('2026-11-26T00:18:00.000Z'));
    const completed = await scheduledRun(['bizfurniz']);
    expect(completed.status).toBe(200);
    expect(await completed.json()).toMatchObject({ synced: [{ storeKey: biz.key, ordersInserted: 1 }] });
    expect(await syncState()).toEqual({
      status: 'idle', completed_watermark: firstAt, active_window_start: null, active_window_end: null, next_page_cursor: null,
    });

    vi.setSystemTime(new Date('2026-11-26T00:33:00.000Z'));
    const incremental = await scheduledRun(['bizfurniz']);
    expect(incremental.status).toBe(200);
    expect(await incremental.json()).toMatchObject({ synced: [{ storeKey: biz.key, ordersInserted: 0, ordersUnchanged: 1 }] });
    const firstWindow = "updated_at:>='2026-11-19T00:03:00Z' updated_at:<='2026-11-26T00:03:00Z'";
    expect(searches).toEqual([
      { fromAndTo: firstWindow, after: null },
      { fromAndTo: firstWindow, after: nextPage },
      { fromAndTo: "updated_at:>='2026-11-25T18:03:00Z' updated_at:<='2026-11-26T00:33:00Z'", after: null },
    ]);
    const runs = await connection.db.prepare('SELECT mode, status FROM connector_sync_runs ORDER BY started_at').all();
    expect(runs.results).toEqual([
      { mode: 'backfill', status: 'failed' }, { mode: 'backfill', status: 'succeeded' }, { mode: 'incremental', status: 'succeeded' },
    ]);
    expect(await connection.db.prepare('SELECT COUNT(*) AS total FROM platform_orders').first('total')).toBe(2);
  });

  it.each([
    ['gid://shopify/Shop/other', ['read_orders'], 'SHOPIFY_IDENTITY_MISMATCH'],
    [shopId, ['read_products'], 'SHOPIFY_READ_ORDERS_SCOPE_MISSING'],
  ] as const)('官方店铺或订单授权不符合时停止首次回补并隔离该店 %s', async (liveShopId, scopes, code) => {
    runtimeEnv.SHOPIFY_BIZFURNIZ_INITIAL_BACKFILL_ENABLED = 'true';
    runtimeEnv.SHOPIFY_ZIMASYA_INITIAL_BACKFILL_ENABLED = 'true';
    await saveShopifyOAuthCredential({
      db: connection.db, tenantId, runtimeEnv, storeKey: zimasya.key, shopDomain: zimasya.domain,
      officialStoreId: 'gid://shopify/Shop/8', grantedScopes: 'read_orders',
      session: { accessToken: 'fixture-second-token' }, createdBy: 'fixture-operator',
    });
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      const { query } = JSON.parse(String(init?.body)) as { query: string };
      const domain = new URL(String(url)).hostname;
      if (domain === biz.domain) {
        expect(query).toMatch(/^query ErpShopContext/);
        return Response.json({ data: fixtureShop(biz.domain, liveShopId, [...scopes]) });
      }
      expect(domain).toBe(zimasya.domain);
      if (query.startsWith('query ErpShopContext')) return Response.json({ data: fixtureShop(zimasya.domain, 'gid://shopify/Shop/8') });
      expect(query).toMatch(/^query ErpOrdersPage/);
      return Response.json({ data: { orders: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await scheduledRun(['bizfurniz', 'zimasya']);
    expect(result.status).toBe(207);
    expect(await result.json()).toMatchObject({
      failed: [{ storeKey: biz.key, code }], synced: [{ storeKey: zimasya.key, ordersInserted: 0 }],
    });
    const stores = await connection.db.prepare('SELECT connector_key FROM platform_stores').all();
    expect(stores.results).toEqual([{ connector_key: zimasya.key }]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('仅有旧环境令牌时忽略首次回补开关', async () => {
    runtimeEnv.SHOPIFY_ZIMASYA_ADMIN_ACCESS_TOKEN = 'fixture-legacy-token';
    runtimeEnv.SHOPIFY_ZIMASYA_INITIAL_BACKFILL_ENABLED = 'true';
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => Response.json({
      data: fixtureShop(zimasya.domain, 'gid://shopify/Shop/8'),
    })));
    const legacy = await scheduledRun(['zimasya']);
    expect(legacy.status).toBe(207);
    expect(await legacy.json()).toMatchObject({ failed: [{ storeKey: zimasya.key, code: 'SHOPIFY_INITIAL_RANGE_REQUIRED' }] });
    expect(await syncState()).toBeNull();
  });
});

function authorizedRequest(body: unknown) {
  return new Request('https://erp.example/api/connectors/shopify/reconcile', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${internalToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

function config(storeKey: ShopifyStoreKey): ShopifyCredentialConfig {
  const domains: Record<ShopifyStoreKey, string> = {
    zimasya: 'fixture-zimasya.myshopify.com',
    kaguyasu: 'fixture-kaguyasu.myshopify.com',
    anzhap: 'fixture-independent-retail-shop.myshopify.com',
    bizfurniz: 'fixture-bizfurniz-canonical.myshopify.com',
  };
  return {
    key: storeKey,
    displayName: storeKey,
    domain: domains[storeKey],
    expectedDomain: domains[storeKey],
    acceptedDomains: [domains[storeKey]],
    environmentPrefix: `SHOPIFY_${storeKey.toUpperCase()}`,
    authMode: 'oauth',
    credentialRef: `d1:shopify:${storeKey}`,
    adminAccessToken: 'secret-access-token',
    clientId: 'client-id',
    clientSecret: 'client-secret',
  };
}

function syncResult(
  storeKey: ShopifyStoreKey,
  overrides: Partial<{
    ordersInserted: number;
    ordersUpdated: number;
    ordersUnchanged: number;
  }> = {},
) {
  return {
    ok: true as const,
    runId: 'run-safe',
    store: {
      key: storeKey,
      name: storeKey,
      officialStoreId: 'gid://shopify/Shop/1',
      domain: `${storeKey}.myshopify.com`,
    },
    apiVersion: '2026-07',
    mode: 'incremental' as const,
    window: {
      from: '2026-11-01T00:00:00.000Z',
      to: '2026-11-02T00:00:00.000Z',
      overlapSeconds: 21600,
    },
    stats: {
      pagesCompleted: 1,
      ordersSeen: 1,
      ordersInserted: 0,
      ordersUpdated: 0,
      ordersUnchanged: 1,
      ...overrides,
    },
    completedAt: '2026-11-02T00:00:00.000Z',
  };
}
