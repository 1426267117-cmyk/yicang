import { describe, expect, it } from 'vitest';
import {
  inspectShopifyStoreConfiguration,
  SHOPIFY_STORE_CANDIDATES,
} from '../lib/connectors/shopify/config';
import { shopifyOrderSyncSchema } from '../lib/contracts';

describe('Shopify 四店配置隔离', () => {
  it('四家候选店都使用独立固定键、域名和环境变量前缀', () => {
    expect(SHOPIFY_STORE_CANDIDATES.map((store) => ({
      key: store.key,
      domain: store.expectedDomain,
      prefix: store.environmentPrefix,
    }))).toEqual([
      { key: 'zimasya', domain: '346c85.myshopify.com', prefix: 'SHOPIFY_ZIMASYA' },
      { key: 'kaguyasu', domain: 'officebaseca.myshopify.com', prefix: 'SHOPIFY_KAGUYASU' },
      { key: 'anzhap', domain: 'anzhap.myshopify.com', prefix: 'SHOPIFY_ANZ' },
      { key: 'bizfurniz', domain: 'z6w01w-xs.myshopify.com', prefix: 'SHOPIFY_BIZFURNIZ' },
    ]);
  });

  it('一个未启用店铺的错误域名不会使其他三家状态解析失败', () => {
    const runtimeEnv = { SHOPIFY_ZIMASYA_SHOP_DOMAIN: 'not-a-shopify-domain' };
    const results = Object.fromEntries(SHOPIFY_STORE_CANDIDATES.map((candidate) => [
      candidate.key,
      inspectShopifyStoreConfiguration(runtimeEnv, candidate.key),
    ]));

    expect(results.zimasya).toMatchObject({ ok: false, errorCode: 'INVALID_SHOPIFY_DOMAIN' });
    expect(results.kaguyasu).toMatchObject({ ok: true, errorCode: null });
    expect(results.anzhap).toMatchObject({ ok: true, errorCode: null });
    expect(results.bizfurniz).toMatchObject({ ok: true, errorCode: null });
    expect(JSON.stringify(results)).not.toContain('not-a-shopify-domain');
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
