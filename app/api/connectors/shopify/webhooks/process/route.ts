import { env } from 'cloudflare:workers';
import { ensureDatabase } from '../../../../../../db/initialize';
import { shopifyWebhookProcessSchema } from '../../../../../../lib/contracts';
import { processShopifyWebhookBatch } from '../../../../../../lib/connectors/shopify/webhook-consumer';
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
    const parsed = shopifyWebhookProcessSchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) {
      return Response.json({
        ok: false,
        code: 'INVALID_WEBHOOK_PROCESS_REQUEST',
        message: parsed.error.issues[0]?.message ?? 'Webhook 批处理参数无效',
      }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
    }
    const tenants = await db.prepare(`
      SELECT DISTINCT tenant_id
      FROM shopify_webhook_events
      WHERE status IN ('pending', 'processing')
      ORDER BY tenant_id
      LIMIT 20
    `).all<{ tenant_id: string }>();
    const totals = {
      claimed: 0, processed: 0, inserted: 0, updated: 0, unchanged: 0,
      retried: 0, failed: 0, leaseLost: 0,
    };
    for (const tenant of tenants.results) {
      const result = await processShopifyWebhookBatch({
        db,
        tenantId: tenant.tenant_id,
        runtimeEnv,
        requestUrl: request.url,
        maxEvents: parsed.data.maxEvents,
      });
      for (const key of Object.keys(totals) as Array<keyof typeof totals>) {
        totals[key] += result.stats[key];
      }
    }
    return Response.json({ ok: true, tenantsChecked: tenants.results.length, stats: totals }, {
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
