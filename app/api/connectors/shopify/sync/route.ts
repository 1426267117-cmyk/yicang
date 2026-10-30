import { env } from 'cloudflare:workers';
import { shopifyOrderSyncSchema } from '../../../../../lib/contracts';
import { PlatformOrderRepository } from '../../../../../lib/connectors/repository';
import { ShopifyAdminClient } from '../../../../../lib/connectors/shopify/client';
import {
  hasShopifyCredentials,
  resolveShopifyStoreConfig,
} from '../../../../../lib/connectors/shopify/config';
import { ShopifyOrderConnector } from '../../../../../lib/connectors/shopify/connector';
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
    const config = resolveShopifyStoreConfig(runtimeEnv, parsed.data.storeKey);
    if (!hasShopifyCredentials(config)) {
      return Response.json({
        ok: false,
        code: 'SHOPIFY_CREDENTIALS_MISSING',
        message: `${config.displayName} 尚未配置 ERP 独立 Shopify 只读凭证`,
        requiredEnvironment: [
          `${config.environmentPrefix}_ADMIN_ACCESS_TOKEN`,
          `或 ${config.environmentPrefix}_CLIENT_ID + ${config.environmentPrefix}_CLIENT_SECRET`,
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
