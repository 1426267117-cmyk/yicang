import { env } from 'cloudflare:workers';
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
import { createShopifyOAuthApi, SHOPIFY_ORDER_READ_SCOPES } from '../../../../../../../lib/connectors/shopify/oauth';
import {
  HttpError,
  jsonError,
  requestContext,
  requirePermission,
  requireProductionAccessPolicy,
} from '../../../../../../../lib/db';

export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  routeContext: { params: Promise<{ storeKey: string }> },
) {
  try {
    const { db, user } = await requestContext(request);
    requirePermission(user, 'connectors:sync');
    const runtimeEnv = env as unknown as Record<string, unknown>;
    requireProductionAccessPolicy(runtimeEnv, user.email);
    const { storeKey } = await routeContext.params;
    if (!isShopifyStoreKey(storeKey)) {
      throw new HttpError(404, '未找到该 Shopify 店铺配置', 'UNKNOWN_SHOPIFY_STORE');
    }
    const config = resolveShopifyStoreConfig(runtimeEnv, storeKey);
    if (!hasShopifyAppCredentials(config)) {
      throw new HttpError(
        503,
        `${config.displayName} 尚未配置 ERP 独立 Shopify 应用参数`,
        'SHOPIFY_APP_CREDENTIALS_MISSING',
      );
    }
    const api = createShopifyOAuthApi(config, request.url);
    const callback = await api.auth.callback<Headers>({ rawRequest: request, expiring: true });
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
    const connector = new ShopifyOrderConnector(
      verifiedConfig,
      new ShopifyAdminClient(verifiedConfig),
    );
    const shop = await connector.getShopContext();
    const missingScopes = SHOPIFY_ORDER_READ_SCOPES.filter((scope) => !shop.scopes.has(scope));
    if (missingScopes.length) {
      throw new ShopifyConnectorError(
        'SHOPIFY_REQUIRED_SCOPE_MISSING',
        `${config.displayName} 缺少 ERP 订单只读所需权限，已停止保存`,
      );
    }
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
    const headers = new Headers(callback.headers);
    headers.set('Location', `/?shopify_oauth=${encodeURIComponent(storeKey)}&status=connected`);
    headers.set('Cache-Control', 'no-store');
    return new Response(null, { status: 303, headers });
  } catch (error) {
    if (error instanceof HttpError) return jsonError(error);
    if (error instanceof ShopifyConnectorError) {
      return Response.json({ ok: false, ...sanitizedConnectorError(error) }, {
        status: 422,
        headers: { 'Cache-Control': 'no-store' },
      });
    }
    return Response.json({
      ok: false,
      code: 'SHOPIFY_OAUTH_FAILED',
      message: 'Shopify 授权未完成，旧凭证和已同步数据均未改动',
    }, { status: 422, headers: { 'Cache-Control': 'no-store' } });
  }
}
