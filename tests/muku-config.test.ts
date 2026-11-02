import { describe, expect, it } from 'vitest';
import {
  MukuDashboardConfig,
  MUKU_DASHBOARD_DEFAULT_BASE_URL,
  MUKU_LOCAL_EGRESS_PATH,
  resolveMukuConfig,
} from '../lib/connectors/muku/config';

const testKey = 'test-muku-read-only-key-with-more-than-32-characters';

describe('MUKU 只读连接配置', () => {
  it('只从服务端环境读取密钥并使用固定默认地址', () => {
    const config = resolveMukuConfig({ MUKU_DASHBOARD_API_KEY: testKey });

    expect(config.baseUrl).toBe(MUKU_DASHBOARD_DEFAULT_BASE_URL);
    expect(config.localEgressUrl).toBeNull();
    expect(config.authorizationValue()).toBe(`Bearer ${testKey}`);
    expect(JSON.stringify(config)).not.toContain(testKey);
    expect(JSON.stringify(config)).toContain('configured');
  });

  it.each([
    `http://127.0.0.1:3000${MUKU_LOCAL_EGRESS_PATH}`,
    `http://localhost:3000${MUKU_LOCAL_EGRESS_PATH}`,
    `http://[::1]:3000${MUKU_LOCAL_EGRESS_PATH}`,
  ])('仅允许固定路径的本机 HTTP 开发出口 %s', (localEgressUrl) => {
    const config = resolveMukuConfig({
      MUKU_DASHBOARD_API_KEY: testKey,
      MUKU_LOCAL_EGRESS_URL: localEgressUrl,
    });

    expect(config.localEgressUrl).toBe(new URL(localEgressUrl).toString());
    expect(config.toJSON()).toMatchObject({ localEgressConfigured: true });
    expect(JSON.stringify(config)).not.toContain(localEgressUrl);
    expect(JSON.stringify(config)).not.toContain(testKey);
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

  it.each([
    `https://127.0.0.1:3000${MUKU_LOCAL_EGRESS_PATH}`,
    `http://0.0.0.0:3000${MUKU_LOCAL_EGRESS_PATH}`,
    `http://example.test:3000${MUKU_LOCAL_EGRESS_PATH}`,
    'http://127.0.0.1:3000/wrong-path',
    `http://user:password@127.0.0.1:3000${MUKU_LOCAL_EGRESS_PATH}`,
    `http://127.0.0.1:3000${MUKU_LOCAL_EGRESS_PATH}?target=unsafe`,
    `http://127.0.0.1:3000${MUKU_LOCAL_EGRESS_PATH}#unsafe`,
    'not a url',
  ])('拒绝非 loopback 或非固定路径的开发出口 %s', (localEgressUrl) => {
    expect(() => resolveMukuConfig({
      MUKU_DASHBOARD_API_KEY: testKey,
      MUKU_LOCAL_EGRESS_URL: localEgressUrl,
    })).toThrowError(expect.objectContaining({ code: 'MUKU_LOCAL_EGRESS_INVALID' }));
  });

  it('开启本地出口时仍锁定 MUKU 上游域名', () => {
    expect(() => resolveMukuConfig({
      MUKU_DASHBOARD_BASE_URL: 'https://muku.example.test',
      MUKU_DASHBOARD_API_KEY: testKey,
      MUKU_LOCAL_EGRESS_URL: `http://127.0.0.1:3000${MUKU_LOCAL_EGRESS_PATH}`,
    })).toThrowError(expect.objectContaining({ code: 'MUKU_LOCAL_EGRESS_INVALID' }));
  });

  it('直接构造配置时也不能绕过本场出口白名单', () => {
    expect(() => new MukuDashboardConfig(
      MUKU_DASHBOARD_DEFAULT_BASE_URL,
      testKey,
      `http://example.invalid:3000${MUKU_LOCAL_EGRESS_PATH}`,
    )).toThrowError(expect.objectContaining({ code: 'MUKU_LOCAL_EGRESS_INVALID' }));
  });
});
