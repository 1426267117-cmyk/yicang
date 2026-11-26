import { env } from 'cloudflare:workers';
import { ensureDatabase } from '../../../../../db/initialize';
import { getAmazonStoreSettings, readAmazonStoreStatuses } from '../../../../../lib/connectors/amazon/store-settings';
import { amazonSyncFailure, runAmazonOrderSync } from '../../../../../lib/connectors/amazon/sync-service';
import { HttpError } from '../../../../../lib/db';
import { InternalJobAuthError, requireInternalJobToken } from '../../../../../lib/internal-job-auth';

export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'no-store' };

export function POST(request: Request) {
  return handleAmazonReconcile(request, env as unknown as Record<string, unknown> & { DB?: D1Database });
}

export async function handleAmazonReconcile(
  request: Request,
  runtimeEnv: Record<string, unknown> & { DB?: D1Database },
  sync = runAmazonOrderSync,
) {
  try {
    requireInternalJobToken(request.headers, runtimeEnv);
    if (runtimeEnv.ERP_AMAZON_RECONCILE_ENABLED !== 'true') {
      throw new HttpError(409, 'Amazon 后台增量同步尚未启用', 'AMAZON_RECONCILE_DISABLED');
    }
    const { DB: db, ERP_AMAZON_ORDERS_TENANT_ID: tenantId } = runtimeEnv;
    if (!db) throw new HttpError(503, '数据库尚未绑定，请稍后重试', 'DATABASE_UNAVAILABLE');
    if (typeof tenantId !== 'string' || !tenantId.trim()) {
      throw new HttpError(422, 'Amazon 后台同步尚未配置工作区', 'AMAZON_CONFIGURATION_REQUIRED');
    }
    await ensureDatabase(db);
    const settings = getAmazonStoreSettings(runtimeEnv, tenantId.trim());
    const configured = settings.flatMap((store) => store.config ?? []);
    if (!configured.length) throw new HttpError(422, '没有已配置的 Amazon 店铺', 'AMAZON_CONFIGURATION_REQUIRED');
    const states = await readAmazonStoreStatuses(db, tenantId.trim(), runtimeEnv);
    const results = [];
    for (const config of configured) {
      const status = states.find((store) => store.key === config.key);
      if (!status?.sourceVerified) {
        results.push({ storeKey: config.key, ok: false, code: 'AMAZON_INITIAL_RANGE_REQUIRED' });
        continue;
      }
      try {
        results.push(await sync({ db, tenantId: tenantId.trim(), config, request: { storeKey: config.key, maxPages: 2 } }));
      } catch (error) {
        const { code, retryable } = amazonSyncFailure(error);
        results.push({ storeKey: config.key, ok: false, code, retryable });
      }
    }
    const ok = results.every((result) => result.ok);
    return Response.json({ ok, results }, { headers, status: ok ? 200 : 207 });
  } catch (error) {
    if (error instanceof InternalJobAuthError) {
      return Response.json({ ok: false, code: error.code, message: error.message }, { headers, status: error.status });
    }
    const { status, ...failure } = amazonSyncFailure(error);
    return Response.json({ ok: false, ...failure }, { status, headers });
  }
}
