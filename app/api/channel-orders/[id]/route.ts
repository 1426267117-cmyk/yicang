import { channelOrderIdSchema, getChannelOrder } from '../../../../lib/channel-orders';
import { HttpError, jsonError, requestContext } from '../../../../lib/db';

export const dynamic = 'force-dynamic';

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const headers = { 'Cache-Control': 'private, no-store' };
  try {
    const { db, user } = await requestContext(request);
    const parsed = channelOrderIdSchema.safeParse((await params).id);
    if (!parsed.success) throw new HttpError(404, '未找到渠道订单', 'CHANNEL_ORDER_NOT_FOUND');
    return Response.json({ ok: true, ...await getChannelOrder(db, user, parsed.data) }, { headers });
  } catch (error) {
    const response = jsonError(error);
    response.headers.set('Cache-Control', headers['Cache-Control']);
    return response;
  }
}
