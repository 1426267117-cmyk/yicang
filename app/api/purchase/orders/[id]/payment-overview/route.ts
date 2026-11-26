import { HttpError, jsonError, requestContext } from '../../../../../../lib/db';
import { getPurchaseOrderPaymentOverview } from '../../../../../../lib/purchase-payment-requests';

export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store' };

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const [{ db, user }, { id }] = await Promise.all([requestContext(request), context.params]);
    if (!id || id.length > 160) throw new HttpError(400, '采购单编号无效', 'INVALID_PURCHASE_ORDER_ID');
    return Response.json({ ok: true, overview: await getPurchaseOrderPaymentOverview(db, user, id) }, { headers });
  } catch (error) {
    const response = jsonError(error);
    response.headers.set('Cache-Control', headers['Cache-Control']);
    return response;
  }
}
