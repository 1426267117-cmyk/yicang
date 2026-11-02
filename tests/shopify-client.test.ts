import { describe, expect, it } from 'vitest';
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
  it('调用 fetch 时不绑定 ShopifyAdminClient 作为 receiver', async () => {
    let receiver: unknown = 'not-called';
    const receiverAwareFetch = async function (this: unknown) {
      receiver = this;
      return new Response(JSON.stringify({ data: { shop: { id: 'gid://shopify/Shop/1' } } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    } as typeof fetch;

    const client = new ShopifyAdminClient(config, receiverAwareFetch);
    await client.graphql('query ReceiverTest { shop { id } }');

    expect(receiver).toBeUndefined();
  });
});
