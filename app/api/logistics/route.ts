import { z } from 'zod';
import { HttpError, jsonError, requestContext } from '../../../lib/db';
import { logisticsMaxPage, logisticsStatuses, trackingEventSchema } from '../../../lib/logistics-contracts';
import { appendTrackingEvent, getTrackingHistory, listInboundLogistics, listManualLogistics, listPlatformLogistics } from '../../../lib/logistics-service';

export const dynamic = 'force-dynamic';

const headers = { 'Cache-Control': 'private, no-store' };
const listSelection = z.strictObject({
  view: z.enum(['erp', 'platform', 'inbound']).default('erp'),
  q: z.string().trim().max(100).default(''),
  page: z.coerce.number().int().min(1).max(logisticsMaxPage).default(1),
  status: z.enum(['all', 'unregistered', ...logisticsStatuses]).default('all'),
});

export async function GET(request: Request) {
  try {
    const { db, user } = await requestContext(request);
    const search = new URL(request.url).searchParams;
    if (search.has('package')) {
      const id = z.uuid().safeParse(search.get('package'));
      if (!id.success || search.size !== 1) throw new HttpError(400, '包裹编号无效', 'INVALID_PACKAGE_ID');
      return Response.json({ ok: true, history: await getTrackingHistory(db, user, id.data) }, { headers });
    }
    const query = listSelection.safeParse(Object.fromEntries(search));
    if (!query.success) throw new HttpError(400, '查询条件无效', 'INVALID_LOGISTICS_FILTER');
    const { view, q, page, status } = query.data;
    const payload = await (view === 'platform' ? listPlatformLogistics(db, user, q, page)
      : view === 'inbound' ? listInboundLogistics(db, user, q, page) : listManualLogistics(db, user, q, page, status));
    return Response.json({ ok: true, ...payload }, { headers });
  } catch (error) {
    const response = jsonError(error);
    response.headers.set('Cache-Control', headers['Cache-Control']);
    return response;
  }
}

export async function POST(request: Request) {
  try {
    const { db, user } = await requestContext(request);
    const input = trackingEventSchema.safeParse(await request.json().catch(() => null));
    if (!input.success) throw new HttpError(400, input.error.issues[0]?.message ?? '运单信息不完整', 'INVALID_LOGISTICS_EVENT');
    const result = await appendTrackingEvent(db, user, input.data, request.headers.get('Idempotency-Key') ?? '');
    return Response.json({ ok: true, ...result }, { headers, status: result.replayed ? 200 : 201 });
  } catch (error) {
    const response = jsonError(error);
    response.headers.set('Cache-Control', headers['Cache-Control']);
    return response;
  }
}
