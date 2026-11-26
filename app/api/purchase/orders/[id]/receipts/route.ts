import { createPurchaseReceiptSchema } from '../../../../../../lib/contracts';
import { HttpError, jsonError, requestContext } from '../../../../../../lib/db';
import { createPurchaseReceipt, toWarehousePurchaseOrder } from '../../../../../../lib/purchase-order-service';

export const dynamic = 'force-dynamic';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { db, user } = await requestContext(request);
    const parsed = createPurchaseReceiptSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      throw new HttpError(
        400,
        parsed.error.issues[0]?.message ?? '收货参数不完整',
        'INVALID_PURCHASE_RECEIPT',
      );
    }
    const { id } = await context.params;
    const result = await createPurchaseReceipt(
      db,
      user,
      id,
      parsed.data,
      request.headers.get('Idempotency-Key') ?? '',
    );
    const purchaseOrder = user.permissions.includes('purchase:read') || !result.purchaseOrder
      ? result.purchaseOrder : toWarehousePurchaseOrder(result.purchaseOrder);
    return Response.json({ ok: true, ...result, purchaseOrder }, {
      status: result.replayed ? 200 : 201,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    return jsonError(error);
  }
}
