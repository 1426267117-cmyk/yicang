import { readShopifyInventoryMirror } from '../../../../../lib/connectors/shopify/inventory-mirror';
import { shopifyInventoryLookupSchema } from '../../../../../lib/connectors/shopify/inventory-read';
import { HttpError, jsonError, requestContext, requirePermission } from '../../../../../lib/db';

export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store' };

export async function GET(request: Request) {
  try {
    const { db, user } = await requestContext(request);
    if (user.channelScope && user.channelScope !== 'shopify') throw new HttpError(403, '当前账号仅能查看所属渠道', 'PERMISSION_DENIED');
    requirePermission(user, user.channelScope === 'shopify' ? 'channels:read' : 'connectors:read');
    const params = new URL(request.url).searchParams;
    const input = shopifyInventoryLookupSchema.safeParse(Object.fromEntries(params));
    if (!input.success || new Set(params.keys()).size !== params.size) {
      throw new HttpError(400, '请选择 Shopify 店铺并填写完整 SKU', 'SHOPIFY_MIRROR_QUERY_INVALID');
    }
    const result = await readShopifyInventoryMirror({ ...input.data, db, tenantId: user.tenantId });
    return Response.json({ ok: true, readOnly: true, ...result }, { headers });
  } catch (error) {
    const response = jsonError(error);
    response.headers.set('Cache-Control', headers['Cache-Control']);
    return response;
  }
}
