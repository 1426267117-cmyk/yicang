import { DATABASE_SCHEMA_READINESS } from '../../../db/initialize';
import { jsonError, requestContext } from '../../../lib/db';

export async function GET(request: Request) {
  return handleHealthRequest(request);
}

export async function handleHealthRequest(
  request: Request,
  getContext: typeof requestContext = requestContext,
) {
  try {
    const { db, user } = await getContext(request);
    const canReadOrders = !user.channelScope && user.permissions.includes('orders:read');
    const result = canReadOrders
      ? await db.prepare('SELECT COUNT(*) AS count FROM orders WHERE tenant_id = ?').bind(user.tenantId).first<{ count: number }>()
      : null;
    return Response.json({
      ok: true,
      database: 'ready',
      schemaReadiness: DATABASE_SCHEMA_READINESS,
      ...(canReadOrders ? { orders: Number(result?.count ?? 0) } : {}),
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const response = jsonError(error);
    const headers = new Headers(response.headers);
    headers.set('Cache-Control', 'no-store');
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
}
