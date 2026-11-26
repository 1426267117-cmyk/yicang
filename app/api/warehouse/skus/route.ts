import { HttpError, jsonError, requestContext } from '../../../../lib/db';
import { findWarehouseSkus } from '../../../../lib/purchase-sku-service';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const { db, user } = await requestContext(request);
    const query = new URL(request.url).searchParams.get('q')?.trim() ?? '';
    if (query.length > 160) throw new HttpError(400, 'SKU 搜索内容不能超过 160 个字符', 'INVALID_WAREHOUSE_SKU_QUERY');
    return Response.json({ ok: true, skus: await findWarehouseSkus(db, user, query) }, {
      headers: { 'Cache-Control': 'private, no-store' },
    });
  } catch (error) {
    return jsonError(error);
  }
}
