export class MukuConnectorError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable = false,
    public readonly status: number | null = null,
    public readonly diagnostic: string | null = null,
    public readonly requestId: string | null = null,
    public readonly retryAfterMilliseconds: number | null = null,
  ) {
    super(message);
    this.name = 'MukuConnectorError';
  }

  toJSON() {
    return sanitizedMukuConnectorError(this);
  }
}

export function sanitizedMukuConnectorError(error: unknown) {
  if (error instanceof MukuConnectorError) {
    return {
      code: error.code,
      message: sanitizeMessage(error.message),
      retryable: error.retryable,
      status: error.status,
      requestId: error.requestId,
    };
  }
  return {
    code: 'MUKU_SYNC_FAILED',
    message: 'MUKU 数据读取失败，敏感错误详情已隐藏',
    retryable: false,
    status: null,
    requestId: null,
  };
}

function sanitizeMessage(message: string) {
  if (/token|secret|cookie|authorization|password|bearer|api.?key/i.test(message)) {
    return 'MUKU 数据读取失败，敏感错误详情已隐藏';
  }
  return message.slice(0, 300);
}
