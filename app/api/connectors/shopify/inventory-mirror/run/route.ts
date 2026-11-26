import { env } from 'cloudflare:workers';
import { z } from 'zod';
import { ensureDatabase } from '../../../../../../db/initialize';
import { SHOPIFY_STORE_CANDIDATES } from '../../../../../../lib/connectors/shopify/config';
import { ShopifyConnectorError } from '../../../../../../lib/connectors/shopify/errors';
import { runShopifyInventoryMirror, shopifyMirrorDefaultBatchSize, shopifyMirrorMaximumBatchSize, shopifyMirrorWorkspace } from '../../../../../../lib/connectors/shopify/inventory-mirror';
import { HttpError, jsonError } from '../../../../../../lib/db';
import { InternalJobAuthError, requireInternalJobToken } from '../../../../../../lib/internal-job-auth';

export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store' };
const jobSchema = z.strictObject({
  storeKey: z.enum(SHOPIFY_STORE_CANDIDATES.map(({ key }) => key)),
  maxSkus: z.number().int().min(1).max(shopifyMirrorMaximumBatchSize).default(shopifyMirrorDefaultBatchSize),
});

export async function POST(request: Request) {
  return handleShopifyInventoryMirrorJob(request, env as unknown as Record<string, unknown> & { DB?: D1Database });
}

export async function handleShopifyInventoryMirrorJob(
  request: Request,
  runtimeEnv: Record<string, unknown> & { DB?: D1Database },
  run: typeof runShopifyInventoryMirror = runShopifyInventoryMirror,
) {
  try {
    const url = new URL(request.url);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || request.headers.has('origin')
      || [...request.headers.keys()].some(name => name === 'forwarded' || name.startsWith('x-forwarded-'))) {
      return Response.json({ ok: false, code: 'NOT_FOUND' }, { status: 404, headers });
    }
    requireInternalJobToken(request.headers, runtimeEnv);
    const parsed = jobSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new HttpError(400, '请选择 Shopify 店铺，批次最多读取 8 个 SKU', 'SHOPIFY_MIRROR_BATCH_INVALID');
    const db = runtimeEnv.DB;
    if (!db) throw new HttpError(503, '数据库尚未绑定，请稍后重试', 'DATABASE_UNAVAILABLE');
    await ensureDatabase(db);
    const result = await run({ db, tenantId: shopifyMirrorWorkspace, runtimeEnv, requestUrl: url.href, ...parsed.data });
    const status = result.ok ? 200 : result.lookedUp > 0 ? 207 : 409;
    return Response.json(result, { status, headers });
  } catch (error) {
    if (error instanceof InternalJobAuthError || error instanceof ShopifyConnectorError) {
      return Response.json({ ok: false, code: error.code }, { status: error.status ?? 409, headers });
    }
    const response = jsonError(error);
    response.headers.set('Cache-Control', headers['Cache-Control']);
    return response;
  }
}
