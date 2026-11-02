import { env } from 'cloudflare:workers';
import { ensureDatabase } from '../../../../../db/initialize';
import { HttpError } from '../../../../../lib/db';
import {
  evaluateMukuFreshness,
  refreshMukuIfDue,
} from '../../../../../lib/muku-freshness-service';
import {
  InternalJobAuthError,
  requireInternalJobToken,
} from '../../../../../lib/internal-job-auth';
import {
  createMukuClient,
  mukuErrorResponse,
  NO_STORE_HEADERS,
} from '../_shared';

export const dynamic = 'force-dynamic';

type TenantRow = { id: string; name: string };

export async function POST(request: Request) {
  try {
    const runtimeEnv = env as unknown as Record<string, unknown> & { DB?: D1Database };
    requireInternalJobToken(request.headers, runtimeEnv);
    const db = runtimeEnv.DB;
    if (!db) throw new HttpError(503, '数据库尚未绑定，请稍后重试', 'DATABASE_UNAVAILABLE');
    await ensureDatabase(db);
    const { force } = await parseRefreshRequest(request);
    const tenants = await db.prepare(`
      SELECT id, name FROM tenants ORDER BY created_at LIMIT 20
    `).all<TenantRow>();
    const client = createMukuClient();
    const results = [];

    for (const tenant of tenants.results) {
      const refreshed = await refreshMukuIfDue({
        db,
        tenantId: tenant.id,
        tenantName: tenant.name,
        client,
        runtimeEnv,
        force,
      });
      const current = 'after' in refreshed && refreshed.after
        ? refreshed.after
        : await evaluateMukuFreshness(db, tenant.id, { runtimeEnv });
      results.push({
        tenantId: tenant.id,
        ok: refreshed.ok,
        attempted: refreshed.attempted,
        skipReason: refreshed.skipReason,
        freshness: {
          status: current.status,
          readyForProcurement: current.readyForProcurement,
          checkedAt: current.checkedAt,
          blockingReasons: current.blockingReasons,
        },
      });
    }

    return Response.json({
      ok: results.every((result) => result.ok),
      tenantsChecked: results.length,
      attempted: results.filter((result) => result.attempted).length,
      results,
      scheduling: {
        externalScheduleConfigured: false,
        note: '此接口仅提供受保护的任务入口；生产调度需由部署环境单独配置。',
      },
    }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    if (error instanceof InternalJobAuthError) {
      return Response.json({ ok: false, code: error.code, message: error.message }, {
        status: error.status,
        headers: NO_STORE_HEADERS,
      });
    }
    return mukuErrorResponse(error);
  }
}

async function parseRefreshRequest(request: Request) {
  const text = await request.text();
  if (!text.trim()) return { force: false };
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new HttpError(400, '刷新参数必须是 JSON 对象', 'INVALID_MUKU_REFRESH_REQUEST');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, '刷新参数必须是 JSON 对象', 'INVALID_MUKU_REFRESH_REQUEST');
  }
  const record = body as Record<string, unknown>;
  if (Object.keys(record).some((key) => key !== 'force')
    || (record.force !== undefined && typeof record.force !== 'boolean')) {
    throw new HttpError(400, 'force 必须是布尔值', 'INVALID_MUKU_REFRESH_REQUEST');
  }
  return { force: record.force === true };
}
