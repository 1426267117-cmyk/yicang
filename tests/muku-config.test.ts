import { describe, expect, it } from 'vitest';
import {
  MUKU_DASHBOARD_DEFAULT_BASE_URL,
  resolveMukuConfig,
} from '../lib/connectors/muku/config';

const testKey = 'test-muku-read-only-key-with-more-than-32-characters';

describe('MUKU 只读连接配置', () => {
  it('只从服务端环境读取密钥并使用固定默认地址', () => {
    const config = resolveMukuConfig({ MUKU_DASHBOARD_API_KEY: testKey });

    expect(config.baseUrl).toBe(MUKU_DASHBOARD_DEFAULT_BASE_URL);
    expect(config.authorizationValue()).toBe(`Bearer ${testKey}`);
    expect(JSON.stringify(config)).not.toContain(testKey);
    expect(JSON.stringify(config)).toContain('configured');
  });

  it('拒绝缺失或过短的只读密钥', () => {
    expect(() => resolveMukuConfig({})).toThrowError(
      expect.objectContaining({ code: 'MUKU_CONFIG_MISSING' }),
    );
    expect(() => resolveMukuConfig({ MUKU_DASHBOARD_API_KEY: 'too-short' })).toThrowError(
      expect.objectContaining({ code: 'MUKU_CONFIG_MISSING' }),
    );
  });

  it.each([
    'http://muku.example.test',
    'https://user:password@muku.example.test',
    'https://muku.example.test?token=unsafe',
    'https://muku.example.test#unsafe',
    'not a url',
  ])('拒绝不安全的看板地址 %s', (baseUrl) => {
    expect(() => resolveMukuConfig({
      MUKU_DASHBOARD_BASE_URL: baseUrl,
      MUKU_DASHBOARD_API_KEY: testKey,
    })).toThrowError(expect.objectContaining({ code: 'MUKU_BASE_URL_INVALID' }));
  });
});
