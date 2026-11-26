import { HttpError, jsonError, requestContext } from '../../../lib/db';
import { addPurchasePayment, financeQuerySchema, getFinanceLedger, listFinanceOrders, newPaymentSchema, requireFinanceAccess } from '../../../lib/finance';

export const dynamic = 'force-dynamic';

const headers = { 'Cache-Control': 'private, no-store' };

export async function GET(request: Request) {
  try {
    const { db, user } = await requestContext(request);
    requireFinanceAccess(user);
    const search = new URL(request.url).searchParams;
    if (new Set(search.keys()).size !== [...search.keys()].length) {
      throw new HttpError(400, '财务查询参数不能重复', 'INVALID_FINANCE_QUERY');
    }
    const result = financeQuerySchema.safeParse(Object.fromEntries(search));
    if (!result.success) throw new HttpError(400, '财务查询参数不正确', 'INVALID_FINANCE_QUERY');
    const data = 'orderId' in result.data
      ? await getFinanceLedger(db, user, result.data.orderId, result.data.ledger, result.data.page)
      : await listFinanceOrders(db, user, result.data);
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
    requireFinanceAccess(user);
    const parsed = newPaymentSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new HttpError(400, '请核对金额、原币、实际发生时间及凭证编号', 'INVALID_PURCHASE_PAYMENT');
    const result = await addPurchasePayment(db, user, parsed.data, request.headers.get('Idempotency-Key') ?? '');
    return Response.json({ ok: true, ...result }, { status: result.replayed ? 200 : 201, headers });
  } catch (error) {
    const response = jsonError(error);
    response.headers.set('Cache-Control', headers['Cache-Control']);
    return response;
  }
}
