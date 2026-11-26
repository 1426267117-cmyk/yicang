import { z } from 'zod';
import { purchaseProductDetailsSchema } from '../../../../lib/contracts';
import { HttpError, jsonError, requestContext } from '../../../../lib/db';
import { createPurchaseSku, findPurchaseSkus } from '../../../../lib/purchase-sku-service';

export const dynamic = 'force-dynamic';

const createPurchaseSkuSchema = z.object({
  code: z.string().trim().min(1, '请输入 SKU 编码').max(80, 'SKU 编码不能超过 80 个字符'),
  name: z.string().trim().min(1, '请输入商品名称').max(160, '商品名称不能超过 160 个字符'),
  productDetails: purchaseProductDetailsSchema.omit({ name: true }).optional(),
});

export async function GET(request: Request) {
  try {
    const { db, user } = await requestContext(request);
    const query = new URL(request.url).searchParams.get('q')?.trim() ?? '';
    if (query.length > 160) {
      throw new HttpError(400, 'SKU 搜索内容不能超过 160 个字符', 'INVALID_PURCHASE_SKU_QUERY');
    }
    return Response.json({ ok: true, skus: await findPurchaseSkus(db, user, query) }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: Request) {
  try {
    const { db, user } = await requestContext(request);
    const parsed = createPurchaseSkuSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      throw new HttpError(400, parsed.error.issues[0]?.message ?? 'SKU 参数不完整', 'INVALID_PURCHASE_SKU');
    }
    const result = await createPurchaseSku(db, user, parsed.data, request.headers.get('Idempotency-Key') ?? '');
    return Response.json({ ok: true, ...result }, {
      status: result.replayed ? 200 : 201,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    return jsonError(error);
  }
}
