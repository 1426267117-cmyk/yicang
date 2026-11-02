import { z } from 'zod';
import { HttpError, jsonError, requestContext } from '../../../../lib/db';
import { mapPurchaseSku } from '../../../../lib/purchase-mapping-service';

export const dynamic = 'force-dynamic';

const purchaseMappingSchema = z.object({
  demandId: z.string().trim().min(1).max(160),
  skuId: z.string().trim().min(1).max(160).optional(),
  newSku: z.object({
    code: z.string().trim().min(1).max(80),
    name: z.string().trim().min(1).max(160),
  }).optional(),
}).superRefine((value, context) => {
  if (Boolean(value.skuId) === Boolean(value.newSku)) {
    context.addIssue({
      code: 'custom',
      message: '请选择已有 ERP SKU，或填写一个新 SKU',
      path: ['skuId'],
    });
  }
});

export async function POST(request: Request) {
  try {
    const { db, user } = await requestContext(request);
    const parsed = purchaseMappingSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      throw new HttpError(
        400,
        parsed.error.issues[0]?.message ?? 'SKU 映射参数不完整',
        'INVALID_PURCHASE_SKU_MAPPING',
      );
    }
    const result = await mapPurchaseSku(
      db,
      user,
      parsed.data,
      request.headers.get('Idempotency-Key') ?? '',
    );
    return Response.json({ ok: true, ...result }, { status: result.replayed ? 200 : 201 });
  } catch (error) {
    return jsonError(error);
  }
}
