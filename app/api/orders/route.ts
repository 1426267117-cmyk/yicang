import { createOrderSchema } from '../../../lib/contracts';
import { HttpError, jsonError, requestContext } from '../../../lib/db';
import { createOrder, listOrders, orderListQuerySchema } from '../../../lib/erp-service';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const headers = { 'Cache-Control': 'private, no-store' };
  try {
    const { db, user } = await requestContext(request);
    const params = new URL(request.url).searchParams;
    const parsed = orderListQuerySchema.safeParse(Object.fromEntries(params));
    if (!parsed.success || new Set(params.keys()).size !== params.size) {
      throw new HttpError(400, '请检查订单状态、搜索内容或页码', 'INVALID_ORDER_LIST_FILTER');
    }
    return Response.json({ ok: true, ...await listOrders(db, user, parsed.data) }, { headers });
  } catch (error) {
    const response = jsonError(error);
    response.headers.set('Cache-Control', headers['Cache-Control']);
    return response;
  }
}

export async function POST(request: Request) {
  try {
    const { db, user } = await requestContext(request);
    const parsed = createOrderSchema.safeParse(await request.json());
    if (!parsed.success) {
      throw new HttpError(400, parsed.error.issues[0]?.message ?? '订单参数不完整', 'INVALID_ORDER');
    }
    const result = await createOrder(db, user, parsed.data, request.headers.get('Idempotency-Key') ?? '');
    return Response.json({ ok: true, ...result }, { status: result.replayed ? 200 : 201 });
  } catch (error) {
    return jsonError(error);
  }
}
