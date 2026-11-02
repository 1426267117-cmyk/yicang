import { describe, expect, it } from 'vitest';
import { requireInternalJobToken } from '../lib/internal-job-auth';

const token = 'test-internal-job-token-32-characters-long';

describe('内部任务认证', () => {
  it('未配置任务密钥时拒绝', () => {
    expect(() => requireInternalJobToken(new Headers(), {})).toThrowError(
      expect.objectContaining({ code: 'INTERNAL_JOB_TOKEN_MISSING', status: 503 }),
    );
  });

  it('无 Token 或错误 Token 时拒绝', () => {
    expect(() => requireInternalJobToken(new Headers(), {
      ERP_INTERNAL_JOB_TOKEN: token,
      ERP_DEV_OPEN_ACCESS: 'true',
    })).toThrowError(
      expect.objectContaining({ code: 'INTERNAL_JOB_UNAUTHORIZED', status: 401 }),
    );
    expect(() => requireInternalJobToken(
      new Headers({ Authorization: 'Bearer wrong-token' }),
      { ERP_INTERNAL_JOB_TOKEN: token },
    )).toThrowError(expect.objectContaining({ code: 'INTERNAL_JOB_UNAUTHORIZED', status: 401 }));
  });

  it('只接受完整 Bearer 内部密钥', () => {
    expect(() => requireInternalJobToken(
      new Headers({ Authorization: `Bearer ${token}` }),
      { ERP_INTERNAL_JOB_TOKEN: token },
    )).not.toThrow();
  });
});
