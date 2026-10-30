import { env } from 'cloudflare:workers';
import {
  hasShopifyAppCredentials,
  isShopifyStoreKey,
  resolveShopifyStoreConfig,
} from '../../../../../../../lib/connectors/shopify/config';
import { assertCredentialEncryptionKey } from '../../../../../../../lib/connectors/shopify/credential-store';
import { createShopifyOAuthApi } from '../../../../../../../lib/connectors/shopify/oauth';
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
  context: { params: Promise<{ storeKey: string }> },
) {
  try {
    const { user } = await requestContext(request);
    requirePermission(user, 'connectors:sync');
    const runtimeEnv = env as unknown as Record<string, unknown>;
    requireProductionAccessPolicy(runtimeEnv, user.email);
    const { storeKey } = await context.params;
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
    assertCredentialEncryptionKey(runtimeEnv);
    const api = createShopifyOAuthApi(config, request.url);
    return api.auth.begin({
      shop: config.domain,
      callbackPath: `/api/connectors/shopify/oauth/${storeKey}/callback`,
      isOnline: false,
      rawRequest: request,
    });
  } catch (error) {
    return jsonError(error);
  }
}
