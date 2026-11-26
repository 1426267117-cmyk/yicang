import { z } from 'zod';
import { purchaseProductDetailsSchema } from '../../../../../lib/contracts';
import { HttpError, jsonError, requestContext } from '../../../../../lib/db';
import { updatePurchaseSku } from '../../../../../lib/purchase-sku-service';

export const dynamic = 'force-dynamic';

const updatePurchaseSkuSchema = z.strictObject({
  productDetails: purchaseProductDetailsSchema.extend({
    name: z.string().trim().min(1, '请输入商品名称').max(160).optional(),
  }).refine((fields) => Object.keys(fields).length > 0, '请选择要修改的商品资料'),
  expectedRevision: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
});

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const [{ db, user }, { id }] = await Promise.all([requestContext(request), context.params]);
    const parsed = updatePurchaseSkuSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      throw new HttpError(400, parsed.error.issues[0]?.message ?? 'SKU 参数不完整', 'INVALID_PURCHASE_SKU');
    }
    const result = await updatePurchaseSku(db, user, id, parsed.data.productDetails, parsed.data.expectedRevision);
    return Response.json({ ok: true, ...result }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return jsonError(error);
  }
}
