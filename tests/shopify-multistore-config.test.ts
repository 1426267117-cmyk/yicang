import { describe, expect, it } from 'vitest';
import {
  inspectShopifyStoreConfiguration,
  resolveShopifyStoreConfig,
  shopifyDomainAccepted,
  SHOPIFY_STORE_CANDIDATES,
} from '../lib/connectors/shopify/config';
import { shopifyOrderSyncSchema } from '../lib/contracts';

describe('Shopify 四店配置隔离', () => {
  it('四家候选店使用独立固定键和环境变量前缀', () => {
    expect(SHOPIFY_STORE_CANDIDATES.map((store) => ({
      key: store.key,
      prefix: store.environmentPrefix,
    }))).toEqual([
      { key: 'zimasya', prefix: 'SHOPIFY_ZIMASYA' },
      { key: 'kaguyasu', prefix: 'SHOPIFY_KAGUYASU' },
      { key: 'anzhap', prefix: 'SHOPIFY_ANZ' },
      { key: 'bizfurniz', prefix: 'SHOPIFY_BIZFURNIZ' },
    ]);
  });

  it('域名缺失、错误和已配置的店铺各自解析', () => {
    const runtimeEnv = {
      SHOPIFY_ZIMASYA_SHOP_DOMAIN: 'not-a-shopify-domain',
      SHOPIFY_KAGUYASU_SHOP_DOMAIN: 'fixture-kaguyasu.myshopify.com',
    };
    const results = Object.fromEntries(SHOPIFY_STORE_CANDIDATES.map((candidate) => [
      candidate.key,
      inspectShopifyStoreConfiguration(runtimeEnv, candidate.key),
    ]));

    expect(results.zimasya).toMatchObject({ ok: false, errorCode: 'INVALID_SHOPIFY_DOMAIN' });
    expect(results.kaguyasu).toMatchObject({ ok: true, errorCode: null });
    expect(results.anzhap).toMatchObject({ ok: false, errorCode: 'SHOPIFY_DOMAIN_UNCONFIGURED' });
    expect(results.bizfurniz).toMatchObject({ ok: false, errorCode: 'SHOPIFY_DOMAIN_UNCONFIGURED' });
    expect(JSON.stringify(results)).not.toContain('not-a-shopify-domain');
  });

  it('只接受私有配置中的主域名和备用域名', () => {
    const canonical = 'fixture-bizfurniz-canonical.myshopify.com';
    const alias = 'fixture-bizfurniz-alias.myshopify.com';
    const runtimeEnv = {
      SHOPIFY_BIZFURNIZ_SHOP_DOMAIN: canonical,
      SHOPIFY_BIZFURNIZ_ACCEPTED_DOMAINS: `https://${alias.toUpperCase()}/, ${canonical}`,
    };
    const config = resolveShopifyStoreConfig(runtimeEnv, 'bizfurniz');

    expect(config.acceptedDomains).toEqual([canonical, alias]);
    expect(shopifyDomainAccepted(config, alias)).toBe(true);
    expect(shopifyDomainAccepted(config, 'fixture-kaguyasu.myshopify.com')).toBe(false);
    expect(inspectShopifyStoreConfiguration({ ...runtimeEnv, SHOPIFY_BIZFURNIZ_ACCEPTED_DOMAINS: 'invalid.example.com' }, 'bizfurniz'))
      .toMatchObject({ ok: false, errorCode: 'INVALID_SHOPIFY_DOMAIN' });
  });

  it('同步请求契约接受四家固定店铺并拒绝未知店铺', () => {
    for (const candidate of SHOPIFY_STORE_CANDIDATES) {
      expect(shopifyOrderSyncSchema.safeParse({
        storeKey: candidate.key,
        mode: 'incremental',
        maxPages: 20,
      }).success).toBe(true);
    }
    expect(shopifyOrderSyncSchema.safeParse({
      storeKey: 'unverified-store',
      mode: 'incremental',
      maxPages: 20,
    }).success).toBe(false);
  });
});
