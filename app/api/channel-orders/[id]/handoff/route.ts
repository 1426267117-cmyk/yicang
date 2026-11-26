import { channelOrderIdSchema } from '../../../../../lib/channel-orders';
import { HttpError, jsonError, requestContext } from '../../../../../lib/db';
import { createNativeChannelHandoff, getNativeChannelHandoff, nativeChannelHandoffPostSchema } from '../../../../../lib/native-channel-handoff';

export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store' };
type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: RouteContext) {
  try {
    const { db, user } = await requestContext(request);
    const id = checkId((await context.params).id);
    return Response.json({ ok: true, ...await getNativeChannelHandoff(db, user, id) }, { headers });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const { db, user } = await requestContext(request);
    const id = checkId((await context.params).id);
    const input = nativeChannelHandoffPostSchema.safeParse(await request.json().catch(() => null));
    if (!input.success) throw new HttpError(400, '请核对店铺原单、确认付款和卖家发货、并填写收件信息', 'NATIVE_HANDOFF_INVALID_INPUT');
    const result = await createNativeChannelHandoff(db, user, id, input.data);
    return Response.json({ ok: true, ...result }, { headers, status: result.replayed ? 200 : 201 });
  } catch (error) {
    return errorResponse(error);
  }
}

function checkId(id: string) {
  const result = channelOrderIdSchema.safeParse(id);
  if (!result.success) throw new HttpError(400, '渠道订单编号无效', 'NATIVE_HANDOFF_INVALID_ID');
  return result.data;
}

function errorResponse(error: unknown) {
  const response = jsonError(error);
  response.headers.set('Cache-Control', headers['Cache-Control']);
  return response;
}
