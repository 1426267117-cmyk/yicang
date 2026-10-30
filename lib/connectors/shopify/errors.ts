export class ShopifyConnectorError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable = false,
    public readonly status: number | null = null,
  ) {
    super(message);
  }
}

export function sanitizedConnectorError(error: unknown) {
  if (error instanceof ShopifyConnectorError) {
    return { code: error.code, message: error.message, retryable: error.retryable };
  }
  return {
    code: 'SHOPIFY_SYNC_FAILED',
    message: error instanceof Error ? sanitizeMessage(error.message) : 'Shopify 同步失败',
    retryable: false,
  };
}

function sanitizeMessage(message: string) {
  if (/token|secret|cookie|authorization|password/i.test(message)) return 'Shopify 同步失败，敏感错误详情已隐藏';
  return message.slice(0, 300);
}
