import { channelOrderListQuerySchema, listChannelOrders } from '../../../lib/channel-orders';
import { HttpError, jsonError, requestContext } from '../../../lib/db';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const headers = { 'Cache-Control': 'private, no-store' };
  try {
    const { db, user } = await requestContext(request);
    const params = new URL(request.url).searchParams;
    const parsed = channelOrderListQuerySchema.safeParse(Object.fromEntries(params));
    if (!parsed.success || new Set(params.keys()).size !== params.size) {
      throw new HttpError(400, '请检查渠道订单的筛选条件、日期或页码', 'INVALID_CHANNEL_ORDER_FILTER');
    }
    return Response.json({ ok: true, ...await listChannelOrders(db, user, parsed.data) }, { headers });
  } catch (error) {
    const response = jsonError(error);
    response.headers.set('Cache-Control', headers['Cache-Control']);
    return response;
  }
}
