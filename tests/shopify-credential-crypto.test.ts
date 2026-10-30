import { describe, expect, it } from 'vitest';
import {
  decryptShopifySecret,
  encryptShopifySecret,
} from '../lib/connectors/shopify/credential-store';

const key = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
const aad = 'tenant|shopify|bizfurniz|z6w01w-xs.myshopify.com|gid://shopify/Shop/1|v1';

describe('Shopify 凭证加密', () => {
  it('使用 AES-GCM 往返保存且不在密文中暴露原值', async () => {
    const token = 'shpat_test_only_secret';
    const encrypted = await encryptShopifySecret(token, key, aad);
    expect(encrypted).toMatch(/^v1:/);
    expect(encrypted).not.toContain(token);
    await expect(decryptShopifySecret(encrypted, key, aad)).resolves.toBe(token);
  });

  it('AAD 不一致或密文被篡改时拒绝解密', async () => {
    const encrypted = await encryptShopifySecret('shpat_test_only_secret', key, aad);
    await expect(decryptShopifySecret(encrypted, key, `${aad}:other`)).rejects.toThrow();
    const tampered = `${encrypted.slice(0, -1)}${encrypted.endsWith('A') ? 'B' : 'A'}`;
    await expect(decryptShopifySecret(tampered, key, aad)).rejects.toThrow();
  });
});
