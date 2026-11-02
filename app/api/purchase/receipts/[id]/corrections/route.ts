import { HttpError, jsonError, requestContext } from '../../../../../../lib/db';
import {
  createPurchaseReceiptCorrection,
  createPurchaseReceiptCorrectionSchema,
  listPurchaseReceiptCorrections,
} from '../../../../../../lib/purchase-receipt-correction-service';

export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { db, user } = await requestContext(request);
    const { id } = await context.params;
    const corrections = await listPurchaseReceiptCorrections(db, user, id);
    return Response.json({ ok: true, corrections }, {
      headers: { 'Cache-Control': 'private, no-store' },
    });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { db, user } = await requestContext(request);
    const parsed = createPurchaseReceiptCorrectionSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      throw new HttpError(
        400,
        parsed.error.issues[0]?.message ?? '收货冲正参数不完整',
        'INVALID_PURCHASE_RECEIPT_CORRECTION',
      );
    }
    const { id } = await context.params;
    const result = await createPurchaseReceiptCorrection(
      db,
      user,
      id,
      parsed.data,
      request.headers.get('Idempotency-Key') ?? '',
    );
    return Response.json({ ok: true, ...result }, {
      status: result.replayed ? 200 : 201,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    return jsonError(error);
  }
}
