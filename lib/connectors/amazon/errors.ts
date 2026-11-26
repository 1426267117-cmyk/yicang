const messages = {
  AMAZON_CONFIGURATION_INVALID: 'Amazon 店铺凭证或站点配置不完整',
  AMAZON_WINDOW_INVALID: 'Amazon 订单更新时间范围无效，结束时间须至少早于当前两分钟',
  AMAZON_AUTH_FAILED: 'Amazon 店铺授权失效或缺少读取订单的权限',
  AMAZON_STORE_IDENTITY_UNVERIFIED: 'Amazon 店铺授权尚未通过指定订单核验',
  AMAZON_ORDER_MARKETPLACE_MISMATCH: 'Amazon 返回了其他站点或站点不明的订单，已停止读取',
  AMAZON_RATE_LIMITED: 'Amazon 订单读取达到调用限额',
  AMAZON_PAGE_TOKEN_REJECTED: 'Amazon 分页令牌无效，请从原时间窗口重新读取',
  AMAZON_REDIRECT_REJECTED: 'Amazon 请求发生非预期重定向，已停止读取',
  AMAZON_TIMEOUT: 'Amazon 未在限定时间内返回数据',
  AMAZON_NETWORK_ERROR: '暂时无法连接 Amazon',
  AMAZON_HTTP_ERROR: 'Amazon 暂时无法返回订单数据',
  AMAZON_INVALID_RESPONSE: 'Amazon 返回的订单数据格式无效',
} as const;

export class AmazonConnectorError extends Error {
  constructor(
    readonly code: keyof typeof messages,
    readonly retryable = false,
    readonly httpStatus: number | null = null,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(messages[code]);
    this.name = 'AmazonConnectorError';
  }
}
