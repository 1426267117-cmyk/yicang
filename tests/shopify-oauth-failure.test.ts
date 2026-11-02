import {
  CookieNotFound,
  HttpRequestError,
  HttpResponseError,
  InvalidOAuthError,
} from '@shopify/shopify-api';
import { describe, expect, it } from 'vitest';
import { classifyShopifyOAuthFailure } from '../lib/connectors/shopify/oauth-failure';

describe('Shopify OAuth failure classification', () => {
  it('turns a missing state cookie into a safe retryable error', () => {
    const result = classifyShopifyOAuthFailure(new CookieNotFound('sensitive shop detail'));
    expect(result).toMatchObject({ code: 'SHOPIFY_OAUTH_SESSION_MISSING', retryable: true });
    expect(result.message).not.toContain('sensitive shop detail');
  });

  it('does not expose invalid callback details', () => {
    const result = classifyShopifyOAuthFailure(new InvalidOAuthError('bad state value'));
    expect(result).toMatchObject({ code: 'SHOPIFY_OAUTH_CALLBACK_INVALID', retryable: true });
    expect(result.message).not.toContain('bad state value');
  });

  it('retains only the upstream status for a rejected token exchange', () => {
    const result = classifyShopifyOAuthFailure(new HttpResponseError({
      message: 'client_secret rejected',
      code: 401,
      statusText: 'Unauthorized',
      body: { access_token: 'must-not-leak' },
      headers: {},
    }));
    expect(result).toMatchObject({
      code: 'SHOPIFY_TOKEN_EXCHANGE_REJECTED',
      retryable: false,
      upstreamStatus: 401,
    });
    expect(JSON.stringify(result)).not.toContain('must-not-leak');
    expect(JSON.stringify(result)).not.toContain('client_secret');
  });

  it('marks Shopify network failures as retryable', () => {
    const result = classifyShopifyOAuthFailure(new HttpRequestError('network down'));
    expect(result).toMatchObject({ code: 'SHOPIFY_TOKEN_EXCHANGE_NETWORK_ERROR', retryable: true });
  });
});
