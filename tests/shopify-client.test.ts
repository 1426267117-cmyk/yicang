import { afterEach, describe, expect, it, vi } from 'vitest';
import { ShopifyAdminClient } from '../lib/connectors/shopify/client';
import type { ShopifyCredentialConfig } from '../lib/connectors/shopify/config';

const config: ShopifyCredentialConfig = {
  key: 'bizfurniz',
  displayName: 'BizFurniz',
  domain: 'z6w01w-xs.myshopify.com',
  expectedDomain: 'z6w01w-xs.myshopify.com',
  acceptedDomains: ['z6w01w-xs.myshopify.com'],
  environmentPrefix: 'SHOPIFY_BIZFURNIZ',
  authMode: 'oauth',
  credentialRef: 'test:shopify',
  adminAccessToken: 'test-only-token',
  clientId: null,
  clientSecret: null,
};

describe('ShopifyAdminClient', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('调用 fetch 时不绑定 ShopifyAdminClient 作为 receiver', async () => {
    const receiver = { value: 'not-called' as unknown };
    const receiverAwareFetch = async function (this: unknown) {
      receiver.value = this;
      return new Response(JSON.stringify({ data: { shop: { id: 'gid://shopify/Shop/1' } } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    } as typeof fetch;

    const client = new ShopifyAdminClient(config, receiverAwareFetch);
    await client.graphql('query ReceiverTest { shop { id } }');

    expect(receiver.value).toBeUndefined();
  });

  it('默认请求通过 globalThis fetch 边界调用', async () => {
    const receiver = { value: 'not-called' as unknown };
    vi.stubGlobal('fetch', async function (this: unknown) {
      receiver.value = this;
      return new Response(JSON.stringify({ data: { shop: { id: 'gid://shopify/Shop/1' } } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const client = new ShopifyAdminClient(config);
    await client.graphql('query ReceiverTest { shop { id } }');

    expect(receiver.value).toBe(globalThis);
  });

  it('不跟随 API 重定向，避免把访问令牌发送到其他地址', async () => {
    const fakeFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.redirect).toBe('manual');
      return new Response(null, {
        status: 302,
        headers: { Location: 'https://example.invalid/collect' },
      });
    }) as typeof fetch;
    const client = new ShopifyAdminClient(config, fakeFetch, async () => undefined, () => 0);

    await expect(client.graphql('query RedirectTest { shop { id } }')).rejects.toMatchObject({
      code: 'SHOPIFY_REDIRECT_REJECTED',
      diagnostic: 'redirect_rejected',
      status: 302,
    });
    expect(fakeFetch).toHaveBeenCalledTimes(1);
  });

  it('网络异常重试五次后保留安全诊断分类', async () => {
    const fakeFetch = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    const client = new ShopifyAdminClient(config, fakeFetch, async () => undefined, () => 0);

    await expect(client.graphql('query NetworkTest { shop { id } }')).rejects.toMatchObject({
      code: 'SHOPIFY_NETWORK_ERROR',
      retryable: true,
      diagnostic: 'connection_failure',
    });
    expect(fakeFetch).toHaveBeenCalledTimes(5);
  });

  it('把 401 明确识别为授权失败而不是网络失败', async () => {
    const fakeFetch = vi.fn(async () => new Response(null, {
      status: 401,
      headers: { 'x-request-id': 'safe-request-id' },
    })) as typeof fetch;
    const client = new ShopifyAdminClient(config, fakeFetch, async () => undefined, () => 0);

    await expect(client.graphql('query AuthTest { shop { id } }')).rejects.toMatchObject({
      code: 'SHOPIFY_AUTH_FAILED',
      status: 401,
      requestId: 'safe-request-id',
    });
    expect(fakeFetch).toHaveBeenCalledTimes(1);
  });
});
