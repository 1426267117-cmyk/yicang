import { env } from 'cloudflare:workers';
import { ensureDatabase } from '../../../db/initialize';

export const dynamic = 'force-dynamic';

export async function GET() {
  const runtimeEnv = env as unknown as { ERP_HOST_RUNTIME?: string; DB?: D1Database };
  if (runtimeEnv.ERP_HOST_RUNTIME !== 'aws') return new Response(null, { status: 404 });
  try {
    const db = runtimeEnv.DB;
    if (!db) throw new Error('ERP database binding is missing');
    await ensureDatabase(db);
    await db.prepare('SELECT 1').first();
    return readyResponse(true);
  } catch (error) {
    console.error('ERP readiness check failed', error);
    return readyResponse(false);
  }
}

function readyResponse(ok: boolean) {
  return Response.json({ ok }, {
    status: ok ? 200 : 503,
    headers: { 'Cache-Control': 'no-store' },
  });
}
