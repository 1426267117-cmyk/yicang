import { z } from 'zod';
import { HttpError, jsonError, requestContext, requirePermission } from '../../../../../lib/db';
import { skuCatalogFilters, skuCatalogPageSize } from '../../../../../lib/purchase-sku-catalog';
import { writeSkuCompletionWorkbook } from '../../../../../lib/purchase-sku-catalog-workbook';
import { listPurchaseSkuCatalog } from '../../../../../lib/purchase-sku-service';

export const dynamic = 'force-dynamic';

const catalogQuerySchema = z.object({
  q: z.string().trim().max(160, 'SKU 搜索内容不能超过 160 个字符').default(''),
  filter: z.enum(skuCatalogFilters).default('all'),
  page: z.coerce.number().int().positive().max(Math.floor(Number.MAX_SAFE_INTEGER / skuCatalogPageSize)).default(1),
  format: z.enum(['json', 'xlsx']).default('json'),
});

export async function GET(request: Request) {
  try {
    const { db, user } = await requestContext(request);
    const parsed = catalogQuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!parsed.success) throw new HttpError(400, parsed.error.issues[0]?.message ?? '商品档案筛选条件无效', 'INVALID_SKU_CATALOG_QUERY');
    const { q, filter, page, format } = parsed.data;
    if (format === 'xlsx') requirePermission(user, 'purchase:mapping');
    const result = await listPurchaseSkuCatalog(db, user, { query: q, filter, page });
    if (format === 'json') return Response.json({ ok: true, ...result }, { headers: { 'Cache-Control': 'no-store' } });
    if (!result.skus.length) throw new HttpError(404, '当前页没有可导出的商品', 'SKU_CATALOG_EMPTY');
    return new Response(new Uint8Array(writeSkuCompletionWorkbook(result.skus)), {
      headers: {
        'Cache-Control': 'no-store',
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="sku-completion-page-${page}.xlsx"`,
      },
    });
  } catch (error) {
    return jsonError(error);
  }
}
