import {
  CookieNotFound,
  HttpRequestError,
  HttpResponseError,
  InvalidHmacError,
  InvalidOAuthError,
} from '@shopify/shopify-api';

export type ShopifyOAuthStage =
  | 'route'
  | 'request_context'
  | 'configuration'
  | 'token_exchange'
  | 'identity'
  | 'shop_context'
  | 'scope_check'
  | 'credential_save';

export type ShopifyOAuthFailure = {
  code: string;
  message: string;
  retryable: boolean;
  errorName: string;
  upstreamStatus: number | null;
};

export function classifyShopifyOAuthFailure(error: unknown): ShopifyOAuthFailure {
  const errorName = error instanceof Error ? error.constructor.name || error.name : typeof error;

  if (error instanceof CookieNotFound) {
    return {
      code: 'SHOPIFY_OAUTH_SESSION_MISSING',
      message: 'Shopify 授权会话已失效，请从 ERP 重新发起授权并尽快完成',
      retryable: true,
      errorName,
      upstreamStatus: null,
    };
  }

  if (error instanceof InvalidOAuthError || error instanceof InvalidHmacError) {
    return {
      code: 'SHOPIFY_OAUTH_CALLBACK_INVALID',
      message: 'Shopify 授权校验未通过，请从 ERP 重新发起授权',
      retryable: true,
      errorName,
      upstreamStatus: null,
    };
  }

  if (error instanceof HttpResponseError) {
    return {
      code: 'SHOPIFY_TOKEN_EXCHANGE_REJECTED',
      message: 'Shopify 拒绝了访问令牌交换，请核对应用客户端密钥后重新授权',
      retryable: false,
      errorName,
      upstreamStatus: error.response.code,
    };
  }

  if (error instanceof HttpRequestError) {
    return {
      code: 'SHOPIFY_TOKEN_EXCHANGE_NETWORK_ERROR',
      message: 'ERP 暂时无法连接 Shopify 授权服务，请稍后重新授权',
      retryable: true,
      errorName,
      upstreamStatus: null,
    };
  }

  return {
    code: 'SHOPIFY_OAUTH_FAILED',
    message: 'Shopify 授权未完成，旧凭证和已同步数据均未改动',
    retryable: false,
    errorName,
    upstreamStatus: null,
  };
}
