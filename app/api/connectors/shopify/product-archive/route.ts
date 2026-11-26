import { env } from 'cloudflare:workers';
import { SHOPIFY_API_VERSION } from '../../../../../lib/connectors/shopify/config';
import { sanitizedConnectorError, ShopifyConnectorError } from '../../../../../lib/connectors/shopify/errors';
import { lookupShopifyProductArchive, shopifyProductArchiveLookupSchema } from '../../../../../lib/connectors/shopify/product-archive-read';
import { getVerifiedShopifyProductArchiveStore } from '../../../../../lib/connectors/shopify/product-archive-store';
import { HttpError, jsonError, requestContext, requireShopifyConnectorOperator } from '../../../../../lib/db';

export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store' };

export async function POST(request: Request) {
  try {
    const { db, user } = await requestContext(request);
    const runtimeEnv = env as unknown as Record<string, unknown>;
    requireShopifyConnectorOperator(runtimeEnv, user);
    const parsed = shopifyProductArchiveLookupSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new HttpError(400, '请选择 Shopify 店铺并填写完整 SKU', 'SHOPIFY_PRODUCT_INVALID_QUERY');
    const { storeKey, sku } = parsed.data;
    const { client, context } = await getVerifiedShopifyProductArchiveStore({ db, tenantId: user.tenantId, runtimeEnv, storeKey });
    const product = await lookupShopifyProductArchive({ client, context, sku });
    return Response.json({ ok: true, apiVersion: SHOPIFY_API_VERSION, readOnly: true, queriedAt: new Date().toISOString(),
      store: { key: storeKey, name: context.name, domain: context.domain }, sku, product }, { headers });
  } catch (error) {
    if (error instanceof ShopifyConnectorError) {
      const invalid = error.code === 'SHOPIFY_PRODUCT_INVALID_RESPONSE' || error.code === 'SHOPIFY_PRODUCT_LOOKUP_LIMIT';
      return Response.json({ ok: false, ...sanitizedConnectorError(error) }, { status: error.retryable ? 503 : invalid ? 422 : 409, headers });
    }
    const response = jsonError(error);
    response.headers.set('Cache-Control', headers['Cache-Control']);
    return response;
  }
}
