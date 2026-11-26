import { env } from 'cloudflare:workers';
import { HttpError, requestContext, requirePermission } from '../../../../lib/db';
import { feishuPreviewError, feishuPreviewHeaders, readFeishuPreviewJson, requireFeishuImportOrigin } from '../../../../lib/feishu-procurement-preview-http';
import { getOpeningStock, openingStockPostSchema, openingStockQuerySchema, postOpeningStock } from '../../../../lib/opening-stock';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const { db, user } = await requestContext(request);
    const params = new URL(request.url).searchParams;
    const query = openingStockQuerySchema.safeParse(Object.fromEntries(params));
    if (!query.success || new Set(params.keys()).size !== params.size) {
      throw new HttpError(400, '请核对仓库和 SKU 筛选。', 'INVALID_OPENING_STOCK_QUERY');
    }
    return Response.json(await getOpeningStock(db, user, query.data), { headers: feishuPreviewHeaders });
  } catch (error) {
    return feishuPreviewError(error);
  }
}

export async function POST(request: Request) {
  try {
    const { db, user } = await requestContext(request);
    requirePermission(user, 'members:manage');
    requireFeishuImportOrigin(request, env as unknown as Record<string, unknown>);
    const input = openingStockPostSchema.safeParse(await readFeishuPreviewJson(request, 8_192));
    if (!input.success) throw new HttpError(400, '请核对期初批次、库存归属、仓库和数量后确认。', 'INVALID_OPENING_STOCK');
    const result = await postOpeningStock(db, user, input.data, request.headers.get('Idempotency-Key') ?? '');
    return Response.json({ ok: true, ...result }, { headers: feishuPreviewHeaders, status: result.replayed ? 200 : 201 });
  } catch (error) {
    return feishuPreviewError(error);
  }
}
