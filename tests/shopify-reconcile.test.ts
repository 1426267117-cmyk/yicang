import { describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({ env: {} }));

import { handleShopifyReconcileRequest } from '../app/api/connectors/shopify/reconcile/route';
import type { ShopifyCredentialConfig, ShopifyStoreKey } from '../lib/connectors/shopify/config';
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
    zimasya: '346c85.myshopify.com',
    kaguyasu: 'officebaseca.myshopify.com',
    anzhap: 'anzhap.myshopify.com',
    bizfurniz: 'z6w01w-xs.myshopify.com',
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
