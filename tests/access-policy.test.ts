import { describe, expect, it } from 'vitest';
import {
  developmentOpenAccessEnabled,
  identityAllowed,
  identityExplicitlyListed,
  readProductionAccessPolicy,
} from '../lib/access-policy';

describe('ERP 生产访问名单', () => {
  it('支持精确邮箱和公司域名，比较时忽略大小写', () => {
    const policy = readProductionAccessPolicy({
      ERP_ALLOWED_EMAILS: 'owner@example.com, finance@partner.test',
      ERP_ALLOWED_EMAIL_DOMAINS: '@muku.example; COMPANY.TEST',
    });

    expect(policy.configured).toBe(true);
    expect(identityAllowed('OWNER@example.com', policy)).toBe(true);
    expect(identityAllowed('staff@muku.example', policy)).toBe(true);
    expect(identityAllowed('staff@company.test', policy)).toBe(true);
    expect(identityAllowed('outsider@example.net', policy)).toBe(false);
    expect(identityExplicitlyListed('OWNER@example.com', policy)).toBe(true);
    expect(identityExplicitlyListed('staff@muku.example', policy)).toBe(false);
  });

  it('空配置不会伪装成已启用生产访问控制', () => {
    const policy = readProductionAccessPolicy({
      ERP_ALLOWED_EMAILS: ' ',
      ERP_ALLOWED_EMAIL_DOMAINS: '',
    });
    expect(policy.configured).toBe(false);
  });

  it('开放开发模式只接受明确的 true 开关', () => {
    expect(developmentOpenAccessEnabled({ ERP_DEV_OPEN_ACCESS: 'true' })).toBe(true);
    expect(developmentOpenAccessEnabled({ ERP_DEV_OPEN_ACCESS: ' TRUE ' })).toBe(true);
    expect(developmentOpenAccessEnabled({ ERP_DEV_OPEN_ACCESS: true })).toBe(true);
    expect(developmentOpenAccessEnabled({ ERP_DEV_OPEN_ACCESS: 'false' })).toBe(false);
    expect(developmentOpenAccessEnabled({ ERP_DEV_OPEN_ACCESS: '1' })).toBe(false);
    expect(developmentOpenAccessEnabled({})).toBe(false);
  });
});
