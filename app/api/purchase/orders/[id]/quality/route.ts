import { HttpError, jsonError, requestContext } from '../../../../../../lib/db';
import { purchaseQualityMutationSchema, readPurchaseQuality, writePurchaseQuality } from '../../../../../../lib/purchase-quality-service';

export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store' };
type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
  try {
    const { db, user } = await requestContext(request);
    const { id } = await context.params;
    const includeHistory = new URL(request.url).searchParams.get('view') !== 'limits';
    return Response.json({ ok: true, state: await readPurchaseQuality(db, user, id, includeHistory) }, { headers });
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: Request, context: Context) {
  try {
    const { db, user } = await requestContext(request);
    const { id } = await context.params;
    const parsed = purchaseQualityMutationSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? '质检内容无效', 'PURCHASE_QUALITY_INVALID');
    const saved = await writePurchaseQuality(db, user, id, parsed.data, request.headers.get('Idempotency-Key') ?? '');
    return Response.json({ ok: true, ...saved, state: await readPurchaseQuality(db, user, id) }, {
      headers, status: saved.replayed ? 200 : 201,
    });
  } catch (error) {
    return failure(error);
  }
}

function failure(error: unknown) {
  const response = jsonError(error);
  response.headers.set('Cache-Control', headers['Cache-Control']);
  return response;
}
