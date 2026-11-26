import { HttpError, jsonError, requestContext } from '../../../lib/db';
import { nineStoreOrderQuerySchema } from '../../../lib/nine-store-orders-contract';
import { readNineStoreOrders } from '../../../lib/nine-store-orders-service';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const headers = { 'Cache-Control': 'private, no-store' };
  try {
    const { db, user } = await requestContext(request);
    const params = new URL(request.url).searchParams;
    const parsed = nineStoreOrderQuerySchema.safeParse(Object.fromEntries(params));
    if (!parsed.success || new Set(params.keys()).size !== params.size) throw new HttpError(400, '订单筛选条件无效', 'NINE_STORE_FILTER_INVALID');
    return Response.json(await readNineStoreOrders(db, user, parsed.data), { headers });
  } catch (error) {
    const response = jsonError(error);
    response.headers.set('Cache-Control', headers['Cache-Control']);
    return response;
  }
}
