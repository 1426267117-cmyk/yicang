import { HttpError, jsonError, requestContext } from '../../../lib/db';
import { getWarehousePage, recordWarehouseStockCount, warehouseQuerySchema, warehouseStockCountSchema } from '../../../lib/warehouse-service';

export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store' };

export async function GET(request: Request) {
  try {
    const { db, user } = await requestContext(request);
    const query = warehouseQuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!query.success) throw new HttpError(400, '仓库查询条件不正确', 'INVALID_WAREHOUSE_QUERY');
    return Response.json(await getWarehousePage(db, user, query.data), { headers });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: Request) {
  try {
    const { db, user } = await requestContext(request);
    const input = warehouseStockCountSchema.safeParse(await request.json().catch(() => null));
    if (!input.success) throw new HttpError(400, '请填写仓库、SKU、有效的实盘数量和原因', 'INVALID_WAREHOUSE_STOCK_COUNT');
    const result = await recordWarehouseStockCount(db, user, input.data, request.headers.get('Idempotency-Key') ?? '');
    return Response.json({ ok: true, ...result }, { headers, status: result.replayed ? 200 : 201 });
  } catch (error) {
    return jsonError(error);
  }
}
