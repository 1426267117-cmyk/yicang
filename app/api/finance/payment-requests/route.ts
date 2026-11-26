import { HttpError, jsonError, requestContext } from '../../../../lib/db';
import {
  changePaymentRequest, getPaymentRequestCapacity, getPaymentRequestDetails, listPaymentRequestOrders, listPaymentRequests,
  paymentRequestActionSchema, paymentRequestQuerySchema,
} from '../../../../lib/purchase-payment-requests';

export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store' };

export async function GET(request: Request) {
  try {
    const { db, user } = await requestContext(request);
    const params = new URL(request.url).searchParams;
    const query = paymentRequestQuerySchema.safeParse({ view: 'requests', ...Object.fromEntries(params) });
    if (!query.success || new Set(params.keys()).size !== [...params.keys()].length) {
      throw new HttpError(400, '请核对请款查询参数', 'INVALID_PAYMENT_REQUEST_QUERY');
    }
    const input = query.data;
    let data;
    switch (input.view) {
      case 'requests': data = await listPaymentRequests(db, user, input); break;
      case 'orders': data = await listPaymentRequestOrders(db, user, input); break;
      case 'capacity': data = await getPaymentRequestCapacity(db, user, input.orderId); break;
      case 'detail': data = await getPaymentRequestDetails(db, user, input.requestId); break;
    }
    return Response.json({ ok: true, ...data }, { headers });
  } catch (error) {
    const response = jsonError(error);
    response.headers.set('Cache-Control', headers['Cache-Control']);
    return response;
  }
}

export async function POST(request: Request) {
  try {
    const { db, user } = await requestContext(request);
    const parsed = paymentRequestActionSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new HttpError(400, '请核对请款单据、金额、币种、日期和用途', 'INVALID_PAYMENT_REQUEST');
    const result = await changePaymentRequest(db, user, parsed.data, request.headers.get('Idempotency-Key') ?? '');
    return Response.json({ ok: true, ...result }, { status: parsed.data.action === 'create' && !result.replayed ? 201 : 200, headers });
  } catch (error) {
    const response = jsonError(error);
    response.headers.set('Cache-Control', headers['Cache-Control']);
    return response;
  }
}
