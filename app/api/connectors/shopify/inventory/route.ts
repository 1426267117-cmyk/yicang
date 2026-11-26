import { env } from 'cloudflare:workers';
import { ShopifyAdminClient } from '../../../../../lib/connectors/shopify/client';
import { hasShopifyCredentials, SHOPIFY_API_VERSION } from '../../../../../lib/connectors/shopify/config';
import { ShopifyOrderConnector } from '../../../../../lib/connectors/shopify/connector';
import { resolveShopifyRuntimeConfig } from '../../../../../lib/connectors/shopify/credential-store';
import { sanitizedConnectorError, ShopifyConnectorError } from '../../../../../lib/connectors/shopify/errors';
import { lookupShopifyInventory, shopifyInventoryLookupSchema } from '../../../../../lib/connectors/shopify/inventory-read';
import { HttpError, jsonError, requestContext, requireShopifyConnectorOperator } from '../../../../../lib/db';

export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store' };

export async function POST(request: Request) {
  try {
    const { db, user } = await requestContext(request);
    const runtimeEnv = env as unknown as Record<string, unknown>;
    requireShopifyConnectorOperator(runtimeEnv, user);
    const parsed = shopifyInventoryLookupSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new HttpError(400, '请选择 Shopify 店铺并填写完整 SKU', 'SHOPIFY_INVENTORY_INVALID_QUERY');
    const { storeKey, sku } = parsed.data;
    const config = await resolveShopifyRuntimeConfig({ db, tenantId: user.tenantId, runtimeEnv, storeKey, requestUrl: request.url });
    if (!hasShopifyCredentials(config)) {
      throw new HttpError(409, `${config.displayName} 尚未在易仓配置 Shopify 授权`, 'SHOPIFY_AUTHORIZATION_REQUIRED');
    }
    const client = new ShopifyAdminClient(config);
    const connector = new ShopifyOrderConnector(config, client);
    const context = await connector.getShopContext();
    const { results } = await db.prepare(`
      SELECT official_store_id FROM connector_credentials
      WHERE tenant_id = ? AND platform = 'shopify' AND store_key = ?
      UNION
      SELECT official_store_id FROM platform_stores
      WHERE tenant_id = ? AND platform = 'shopify' AND connector_key = ?
    `).bind(user.tenantId, storeKey, user.tenantId, storeKey).all<{ official_store_id: string }>();
    if (results.some(({ official_store_id }) => official_store_id !== context.id)) {
      throw new HttpError(409, 'Shopify 返回的店铺身份与易仓已有记录不一致', 'SHOPIFY_IDENTITY_MISMATCH');
    }
    const items = await lookupShopifyInventory({ client, context, sku });
    return Response.json({ ok: true, apiVersion: SHOPIFY_API_VERSION, readOnly: true, queriedAt: new Date().toISOString(),
      store: { key: storeKey, name: context.name, domain: context.domain }, sku, items }, { headers });
  } catch (error) {
    if (error instanceof ShopifyConnectorError) {
      return Response.json({ ok: false, ...sanitizedConnectorError(error) }, {
        status: error.retryable ? 503 : error.code.includes('MISSING') ? 409 : 422,
        headers,
      });
    }
    const response = jsonError(error);
    response.headers.set('Cache-Control', headers['Cache-Control']);
    return response;
  }
}
