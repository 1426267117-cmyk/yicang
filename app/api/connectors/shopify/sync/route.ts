import { env } from 'cloudflare:workers';
import { shopifyOrderSyncSchema } from '../../../../../lib/contracts';
import { PlatformOrderRepository } from '../../../../../lib/connectors/repository';
import { ShopifyAdminClient } from '../../../../../lib/connectors/shopify/client';
import {
  hasShopifyCredentials,
  hasShopifyAppCredentials,
  resolveShopifyStoreConfig,
} from '../../../../../lib/connectors/shopify/config';
import { ShopifyOrderConnector } from '../../../../../lib/connectors/shopify/connector';
import { resolveShopifyRuntimeConfig } from '../../../../../lib/connectors/shopify/credential-store';
import { sanitizedConnectorError, ShopifyConnectorError } from '../../../../../lib/connectors/shopify/errors';
import { runShopifyOrderSync } from '../../../../../lib/connectors/shopify/sync-service';
import {
  jsonError,
  requestContext,
  requirePermission,
  requireProductionAccessPolicy,
} from '../../../../../lib/db';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const { db, user } = await requestContext(request);
    requirePermission(user, 'connectors:sync');
    const parsed = shopifyOrderSyncSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return Response.json({
        ok: false,
        code: 'INVALID_SYNC_REQUEST',
        message: parsed.error.issues[0]?.message ?? '同步参数无效',
      }, { status: 400 });
    }
    const runtimeEnv = env as unknown as Record<string, unknown>;
    requireProductionAccessPolicy(runtimeEnv, user.email);
    const baseConfig = resolveShopifyStoreConfig(runtimeEnv, parsed.data.storeKey);
    const config = await resolveShopifyRuntimeConfig({
      db,
      tenantId: user.tenantId,
      runtimeEnv,
      storeKey: parsed.data.storeKey,
      requestUrl: request.url,
    });
    if (!hasShopifyCredentials(config)) {
      const appConfigured = hasShopifyAppCredentials(baseConfig);
      return Response.json({
        ok: false,
        code: appConfigured ? 'SHOPIFY_AUTHORIZATION_REQUIRED' : 'SHOPIFY_APP_CREDENTIALS_MISSING',
        message: appConfigured
          ? `${config.displayName} 尚未完成 ERP 独立 Shopify 只读授权`
          : `${config.displayName} 尚未配置 ERP 独立 Shopify 应用参数`,
        requiredEnvironment: [
          `${config.environmentPrefix}_CLIENT_ID`,
          `${config.environmentPrefix}_CLIENT_SECRET`,
          'ERP_CONNECTOR_CREDENTIALS_KEY',
        ],
      }, { status: 503 });
    }
    const client = new ShopifyAdminClient(config);
    const connector = new ShopifyOrderConnector(config, client);
    const repository = new PlatformOrderRepository(db, user.tenantId);
    const result = await runShopifyOrderSync({
      request: parsed.data,
      config,
      connector,
      repository,
    });
    return Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof ShopifyConnectorError) {
      const safe = sanitizedConnectorError(error);
      return Response.json({ ok: false, ...safe }, {
        status: error.code === 'SHOPIFY_SYNC_ALREADY_RUNNING' || error.code === 'SHOPIFY_SYNC_STATE_CHANGED'
          ? 409
          : error.code.includes('MISSING')
            ? 409
            : error.retryable
              ? 503
              : 422,
        headers: { 'Cache-Control': 'no-store' },
      });
    }
    return jsonError(error);
  }
}
