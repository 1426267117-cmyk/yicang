import { describe, expect, it, vi } from 'vitest';
import type { ShopifyCredentialConfig } from '../lib/connectors/shopify/config';
import { registerStoredShopifyWebhooks } from '../lib/connectors/shopify/webhook-maintenance';

const config: ShopifyCredentialConfig = {
  key: 'bizfurniz',
  displayName: 'BizFurniz',
  domain: 'bizfurniz.myshopify.com',
  expectedDomain: 'bizfurniz.myshopify.com',
  acceptedDomains: ['bizfurniz.myshopify.com'],
  environmentPrefix: 'SHOPIFY_BIZFURNIZ',
  authMode: 'oauth',
  credentialRef: 'd1:shopify:bizfurniz',
  adminAccessToken: 'secret-token-that-must-never-be-returned',
  clientId: 'client-id',
  clientSecret: 'client-secret',
};

const context = {
  id: 'gid://shopify/Shop/100',
  name: 'BizFurniz',
  domain: 'bizfurniz.myshopify.com',
  timezone: 'America/Los_Angeles',
  timezoneOffset: '-0700',
  currency: 'USD',
  scopes: new Set(['read_orders']),
};

describe('已保存授权的 Shopify webhook 维护注册', () => {
  it('使用现有授权幂等注册，结果不返回 token、租户或客户数据', async () => {
    const resolveConfig = vi.fn(async () => config);
    const ensureSubscriptions = vi.fn(async () => ({
      callbackUri: 'https://erp.example/api/connectors/shopify/webhooks/bizfurniz',
      created: 4,
      updated: 0,
      unchanged: 0,
    }));
    const result = await registerStoredShopifyWebhooks({
      db: {} as D1Database,
      runtimeEnv: {},
      requestUrl: 'https://erp.example/api/connectors/shopify/webhooks/register',
      dependencies: {
        loadTargets: async () => [{
          tenantId: 'tenant-private',
          storeKey: 'bizfurniz',
          shopDomain: context.domain,
          officialStoreId: context.id,
        }],
        resolveConfig,
        createVerifiedRuntime: async () => ({ client: {} as never, context }),
        ensureSubscriptions,
      },
    });

    expect(result).toEqual({
      ok: true,
      storesChecked: 1,
      registered: [{ storeKey: 'bizfurniz', created: 4, updated: 0, unchanged: 0 }],
      failed: [],
    });
    expect(resolveConfig).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-private', storeKey: 'bizfurniz',
    }));
    expect(ensureSubscriptions).toHaveBeenCalledWith(expect.objectContaining({
      storeKey: 'bizfurniz',
      requestUrl: 'https://erp.example/api/connectors/shopify/webhooks/register',
    }));
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('secret-token');
    expect(serialized).not.toContain('tenant-private');
    expect(serialized).not.toContain('customer');
  });

  it('同一 storeKey 存在多个租户归属时，在任何外部写入前停止', async () => {
    const ensureSubscriptions = vi.fn();
    await expect(registerStoredShopifyWebhooks({
      db: {} as D1Database,
      runtimeEnv: {},
      requestUrl: 'https://erp.example/api/connectors/shopify/webhooks/register',
      dependencies: {
        loadTargets: async () => [
          {
            tenantId: 'tenant-a', storeKey: 'bizfurniz',
            shopDomain: 'bizfurniz.myshopify.com', officialStoreId: 'gid://shopify/Shop/100',
          },
          {
            tenantId: 'tenant-b', storeKey: 'bizfurniz',
            shopDomain: 'other.myshopify.com', officialStoreId: 'gid://shopify/Shop/200',
          },
        ],
        ensureSubscriptions,
      },
    })).rejects.toMatchObject({ code: 'SHOPIFY_WEBHOOK_OWNER_AMBIGUOUS' });
    expect(ensureSubscriptions).not.toHaveBeenCalled();
  });

  it('授权身份不匹配时只返回脱敏错误码，不注册订阅', async () => {
    const ensureSubscriptions = vi.fn();
    const result = await registerStoredShopifyWebhooks({
      db: {} as D1Database,
      runtimeEnv: {},
      requestUrl: 'https://erp.example/api/connectors/shopify/webhooks/register',
      dependencies: {
        loadTargets: async () => [{
          tenantId: 'tenant-private', storeKey: 'bizfurniz',
          shopDomain: context.domain, officialStoreId: 'gid://shopify/Shop/different',
        }],
        resolveConfig: async () => config,
        createVerifiedRuntime: async () => ({ client: {} as never, context }),
        ensureSubscriptions,
      },
    });

    expect(result).toEqual({
      ok: false,
      storesChecked: 1,
      registered: [],
      failed: [{ storeKey: 'bizfurniz', code: 'SHOPIFY_IDENTITY_MISMATCH', retryable: false }],
    });
    expect(ensureSubscriptions).not.toHaveBeenCalled();
  });
});
