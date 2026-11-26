import { HttpError, jsonError, requestContext } from '../../../../lib/db';
import { getSupplierQuoteBook, quoteQuerySchema, quoteWriteSchema, writeSupplierQuote } from '../../../../lib/supplier-quotes';

export const dynamic = 'force-dynamic';

const headers = { 'Cache-Control': 'private, no-store' };

export async function GET(request: Request) {
  try {
    const { db, user } = await requestContext(request);
    const parameters = [...new URL(request.url).searchParams.entries()];
    if (new Set(parameters.map(([key]) => key)).size !== parameters.length) {
      throw new HttpError(400, '报价查询参数不能重复', 'INVALID_SUPPLIER_QUOTE_QUERY');
    }
    const parsed = quoteQuerySchema.safeParse(Object.fromEntries(parameters));
    if (!parsed.success) throw new HttpError(400, '请核对 SKU、比价数量和币种', 'INVALID_SUPPLIER_QUOTE_QUERY');
    return Response.json({ ok: true, ...await getSupplierQuoteBook(db, user, parsed.data) }, { headers });
  } catch (error) {
    const response = jsonError(error);
    response.headers.set('Cache-Control', headers['Cache-Control']);
    return response;
  }
}

export async function POST(request: Request) {
  try {
    const { db, user } = await requestContext(request);
    const parsed = quoteWriteSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      throw new HttpError(400, parsed.error.issues[0]?.message || '请核对报价内容', 'INVALID_SUPPLIER_QUOTE');
    }
    const result = await writeSupplierQuote(db, user, parsed.data, request.headers.get('Idempotency-Key') ?? '');
    return Response.json({ ok: true, ...result }, { status: result.replayed ? 200 : 201, headers });
  } catch (error) {
    const response = jsonError(error);
    response.headers.set('Cache-Control', headers['Cache-Control']);
    return response;
  }
}
