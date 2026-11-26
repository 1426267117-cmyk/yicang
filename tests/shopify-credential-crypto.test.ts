import { describe, expect, it } from 'vitest';
import {
  decryptShopifySecret,
  encryptShopifySecret,
} from '../lib/connectors/shopify/credential-store';

const key = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
const aad = 'tenant|shopify|bizfurniz|fixture-bizfurniz-canonical.myshopify.com|gid://shopify/Shop/1|v1';

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
    const [version, iv, cipher] = encrypted.split(':');
    const index = Math.floor(cipher.length / 2);
    const tamperedCipher = `${cipher.slice(0, index)}${cipher[index] === 'A' ? 'B' : 'A'}${cipher.slice(index + 1)}`;
    const tampered = `${version}:${iv}:${tamperedCipher}`;
    await expect(decryptShopifySecret(tampered, key, aad)).rejects.toThrow();
  });
});
