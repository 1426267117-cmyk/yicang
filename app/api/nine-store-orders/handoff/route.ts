import { env } from 'cloudflare:workers';
import { HttpError, jsonError, requestContext, requirePermission } from '../../../../lib/db';
import { isContinuousFeishuMode } from '../../../../lib/feishu-procurement-sync';
import {
  createNineStoreHandoff, getNineStoreHandoff, nineStoreHandoffPostSchema, nineStoreHandoffQuerySchema,
} from '../../../../lib/nine-store-handoff';

export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store' };

export async function GET(request: Request) {
  try {
    const { db, user } = await requestContext(request);
    requirePermission(user, 'orders:read');
    const params = new URL(request.url).searchParams;
    const parsed = nineStoreHandoffQuerySchema.safeParse(Object.fromEntries(params));
    if (!parsed.success || new Set(params.keys()).size !== params.size) {
      throw new HttpError(400, '请核对店铺和平台订单号', 'NINE_STORE_HANDOFF_INVALID_SELECTOR');
    }
    return Response.json({ ok: true, ...await getNineStoreHandoff(db, user, parsed.data) }, { headers });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const { db, user } = await requestContext(request);
    requirePermission(user, 'orders:create');
    if (!isContinuousFeishuMode(env as unknown as Record<string, unknown>)) {
      throw new HttpError(409, '期初归档供查阅。请通过店铺连接或运营订单办理后续订单。', 'NINE_STORE_ARCHIVE_READ_ONLY');
    }
    const parsed = nineStoreHandoffPostSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new HttpError(400, '请核对订单来源、SKU、确认数量和原币金额', 'NINE_STORE_HANDOFF_INVALID_ORDER');
    const result = await createNineStoreHandoff(db, user, parsed.data);
    return Response.json({ ok: true, ...result }, { status: result.replayed ? 200 : 201, headers });
  } catch (error) {
    return errorResponse(error);
  }
}

function errorResponse(error: unknown) {
  const response = jsonError(error);
  response.headers.set('Cache-Control', headers['Cache-Control']);
  return response;
}
