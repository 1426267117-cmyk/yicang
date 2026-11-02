import { env } from 'cloudflare:workers';
import { ensureDatabase } from '../../../../../../db/initialize';
import { registerStoredShopifyWebhooks } from '../../../../../../lib/connectors/shopify/webhook-maintenance';
import { HttpError, jsonError } from '../../../../../../lib/db';
import {
  InternalJobAuthError,
  requireInternalJobToken,
} from '../../../../../../lib/internal-job-auth';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const runtimeEnv = env as unknown as Record<string, unknown> & { DB?: D1Database };
    requireInternalJobToken(request.headers, runtimeEnv);
    const db = runtimeEnv.DB;
    if (!db) throw new HttpError(503, '数据库尚未绑定，请稍后重试', 'DATABASE_UNAVAILABLE');
    await ensureDatabase(db);
    const result = await registerStoredShopifyWebhooks({
      db,
      runtimeEnv,
      requestUrl: request.url,
    });
    return Response.json(result, {
      status: result.ok ? 200 : 207,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    if (error instanceof InternalJobAuthError) {
      return Response.json({ ok: false, code: error.code, message: error.message }, {
        status: error.status,
        headers: { 'Cache-Control': 'no-store' },
      });
    }
    return jsonError(error);
  }
}
