import { env, waitUntil } from 'cloudflare:workers';
import { ShopifyAdminClient } from '../../../../../../../lib/connectors/shopify/client';
import {
  hasShopifyAppCredentials,
  isShopifyStoreKey,
  resolveShopifyStoreConfig,
  shopifyDomainAccepted,
  withShopifyAdminAccessToken,
} from '../../../../../../../lib/connectors/shopify/config';
import { ShopifyOrderConnector } from '../../../../../../../lib/connectors/shopify/connector';
import { saveShopifyOAuthCredential } from '../../../../../../../lib/connectors/shopify/credential-store';
import { sanitizedConnectorError, ShopifyConnectorError } from '../../../../../../../lib/connectors/shopify/errors';
import { ensureShopifyOrderWebhookSubscriptions } from '../../../../../../../lib/connectors/shopify/webhook-registration';
import {
  classifyShopifyOAuthFailure,
  type ShopifyOAuthStage,
} from '../../../../../../../lib/connectors/shopify/oauth-failure';
import {
  createShopifyOAuthApi,
  SHOPIFY_REQUIRED_ORDER_READ_SCOPES,
} from '../../../../../../../lib/connectors/shopify/oauth';
import {
  HttpError,
  requestContext,
  requirePermission,
  requireProductionAccessPolicy,
} from '../../../../../../../lib/db';

export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  routeContext: { params: Promise<{ storeKey: string }> },
) {
  let callbackStoreKey = 'shopify';
  let stage: ShopifyOAuthStage = 'route';
  try {
    const { storeKey } = await routeContext.params;
    callbackStoreKey = storeKey;
    stage = 'request_context';
    const { db, user } = await requestContext(request);
    requirePermission(user, 'connectors:sync');
    const runtimeEnv = env as unknown as Record<string, unknown>;
    requireProductionAccessPolicy(runtimeEnv, user.email);
    if (!isShopifyStoreKey(storeKey)) {
      throw new HttpError(404, '未找到该 Shopify 店铺配置', 'UNKNOWN_SHOPIFY_STORE');
    }
    stage = 'configuration';
    const config = resolveShopifyStoreConfig(runtimeEnv, storeKey);
    if (!hasShopifyAppCredentials(config)) {
      throw new HttpError(
        503,
        `${config.displayName} 尚未配置 ERP 独立 Shopify 应用参数`,
        'SHOPIFY_APP_CREDENTIALS_MISSING',
      );
    }
    const api = createShopifyOAuthApi(config, request.url);
    stage = 'token_exchange';
    const callback = await api.auth.callback<Headers>({ rawRequest: request, expiring: true });
    stage = 'identity';
    if (!callback.session.accessToken) {
      throw new ShopifyConnectorError('SHOPIFY_AUTH_INVALID_RESPONSE', 'Shopify 授权响应缺少访问令牌');
    }
    if (!shopifyDomainAccepted(config, callback.session.shop)) {
      throw new ShopifyConnectorError(
        'SHOPIFY_IDENTITY_MISMATCH',
        `${config.displayName} 返回的授权店铺域名与 ERP 配置不一致，已停止保存`,
      );
    }
    const verifiedConfig = withShopifyAdminAccessToken(config, {
      token: callback.session.accessToken,
      domain: callback.session.shop,
      credentialRef: `d1:shopify:${storeKey}`,
    });
    const client = new ShopifyAdminClient(verifiedConfig);
    const connector = new ShopifyOrderConnector(verifiedConfig, client);
    stage = 'shop_context';
    const shop = await connector.getShopContext();
    stage = 'scope_check';
    const missingScopes = SHOPIFY_REQUIRED_ORDER_READ_SCOPES.filter((scope) => !shop.scopes.has(scope));
    if (missingScopes.length) {
      throw new ShopifyConnectorError(
        'SHOPIFY_REQUIRED_SCOPE_MISSING',
        `${config.displayName} 缺少 ERP 订单只读所需权限，已停止保存`,
      );
    }
    stage = 'credential_save';
    await saveShopifyOAuthCredential({
      db,
      tenantId: user.tenantId,
      runtimeEnv,
      storeKey,
      shopDomain: shop.domain,
      officialStoreId: shop.id,
      grantedScopes: [...shop.scopes].sort().join(','),
      session: callback.session,
      createdBy: user.id,
    });
    waitUntil(ensureShopifyOrderWebhookSubscriptions({
        client,
        storeKey,
        requestUrl: request.url,
      }).then((registration) => {
        console.info('shopify_webhook_subscriptions_ready', JSON.stringify({
          storeKey,
          created: registration.created,
          updated: registration.updated,
          unchanged: registration.unchanged,
        }));
      }).catch((registrationError) => {
        const registrationFailure = sanitizedConnectorError(registrationError);
        console.error('shopify_webhook_subscription_failed', JSON.stringify({
          storeKey,
          code: registrationFailure.code,
          retryable: registrationFailure.retryable,
        }));
      }));
    const headers = new Headers(callback.headers);
    headers.set('Location', `/?shopify_oauth=${encodeURIComponent(storeKey)}&status=connected`);
    headers.set('Cache-Control', 'no-store');
    headers.set('Referrer-Policy', 'no-referrer');
    return new Response(null, { status: 303, headers });
  } catch (error) {
    let failure: {
      code: string;
      message: string;
      retryable: boolean;
      errorName: string;
      upstreamStatus: number | null;
      diagnostic: string | null;
      shopifyRequestId: string | null;
    };
    if (error instanceof HttpError) {
      failure = {
        code: error.code,
        message: error.message,
        retryable: error.status >= 500,
        errorName: error.constructor.name || error.name,
        upstreamStatus: null,
        diagnostic: null,
        shopifyRequestId: null,
      };
    } else if (error instanceof ShopifyConnectorError) {
      const sanitized = sanitizedConnectorError(error);
      failure = {
        ...sanitized,
        errorName: error.constructor.name || error.name,
        upstreamStatus: error.status,
        diagnostic: error.diagnostic,
        shopifyRequestId: error.requestId,
      };
    } else {
      failure = {
        ...classifyShopifyOAuthFailure(error),
        diagnostic: null,
        shopifyRequestId: null,
      };
    }

    console.error('shopify_oauth_callback_failed', JSON.stringify({
      storeKey: callbackStoreKey,
      stage,
      code: failure.code,
      errorName: failure.errorName,
      upstreamStatus: failure.upstreamStatus,
      retryable: failure.retryable,
      diagnostic: failure.diagnostic,
      shopifyRequestId: failure.shopifyRequestId,
    }));

    const redirect = new URL('/', request.url);
    redirect.searchParams.set('shopify_oauth', callbackStoreKey);
    redirect.searchParams.set('status', 'error');
    redirect.searchParams.set('code', failure.code);
    redirect.searchParams.set('stage', stage);
    return new Response(null, {
      status: 303,
      headers: {
        Location: redirect.toString(),
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
      },
    });
  }
}
