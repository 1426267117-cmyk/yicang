import { HttpError, jsonError, requestContext } from '../../../../lib/db';
import { addPurchaseInvoice, newInvoiceSchema, requireFinanceAccess } from '../../../../lib/finance';

export const dynamic = 'force-dynamic';

const headers = { 'Cache-Control': 'private, no-store' };

export async function POST(request: Request) {
  try {
    const { db, user } = await requestContext(request);
    requireFinanceAccess(user);
    const parsed = newInvoiceSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new HttpError(400, '请核对发票编号、金额、原币及发票日期', 'INVALID_PURCHASE_INVOICE');
    const result = await addPurchaseInvoice(db, user, parsed.data, request.headers.get('Idempotency-Key') ?? '');
    return Response.json({ ok: true, ...result }, { status: result.replayed ? 200 : 201, headers });
  } catch (error) {
    const response = jsonError(error);
    response.headers.set('Cache-Control', headers['Cache-Control']);
    return response;
  }
}
