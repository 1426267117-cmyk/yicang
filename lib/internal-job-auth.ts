export class InternalJobAuthError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'InternalJobAuthError';
  }
}

export function requireInternalJobToken(headers: Headers, runtimeEnv: Record<string, unknown>) {
  const configured = runtimeEnv.ERP_INTERNAL_JOB_TOKEN;
  if (typeof configured !== 'string' || configured.trim().length < 32) {
    throw new InternalJobAuthError(503, '内部任务密钥尚未安全配置', 'INTERNAL_JOB_TOKEN_MISSING');
  }
  const authorization = headers.get('authorization')?.trim() ?? '';
  const provided = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
  if (!constantTimeTextEqual(configured.trim(), provided)) {
    throw new InternalJobAuthError(401, '内部任务认证失败', 'INTERNAL_JOB_UNAUTHORIZED');
  }
}

function constantTimeTextEqual(left: string, right: string) {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const length = Math.max(leftBytes.length, rightBytes.length);
  let mismatch = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < length; index += 1) {
    mismatch |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return mismatch === 0;
}
