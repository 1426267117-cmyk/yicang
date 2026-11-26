import { describe, expect, it } from 'vitest';
import { shopifyPublicOrigin } from '../lib/connectors/shopify/public-origin';

describe('Shopify connector public origin', () => {
  it('uses the deployed HTTPS origin for both proxied browser and loopback job requests', () => {
    const runtime = { ERP_HOST_RUNTIME: 'aws', ERP_PUBLIC_ORIGIN: 'https://erp.example.test/' };
    expect(shopifyPublicOrigin(runtime, 'http://erp.example.test/api/connectors/shopify/oauth/zimasya/start')).toBe('https://erp.example.test');
    expect(shopifyPublicOrigin(runtime, 'http://127.0.0.1:3000/api/connectors/shopify/webhooks/register')).toBe('https://erp.example.test');
  });

  it.each([undefined, 'http://erp.example.test', 'https://erp.example.test/path', 'https://user@erp.example.test/'])(
    'rejects an unsafe or missing AWS public origin %s',
    (origin) => {
      expect(() => shopifyPublicOrigin({ ERP_HOST_RUNTIME: 'aws', ERP_PUBLIC_ORIGIN: origin }, 'http://127.0.0.1:3000'))
        .toThrow(expect.objectContaining({ code: 'SHOPIFY_PUBLIC_ORIGIN_INVALID' }));
    },
  );

  it('preserves the request origin for local and Sites development', () => {
    expect(shopifyPublicOrigin({}, 'http://localhost:3000/path')).toBe('http://localhost:3000');
    expect(shopifyPublicOrigin({}, 'https://erp.example.test/api?token=private')).toBe('https://erp.example.test');
  });
});
