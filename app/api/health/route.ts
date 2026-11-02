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
    const { db } = await getContext(request);
    const result = await db.prepare('SELECT COUNT(*) AS count FROM orders').first<{ count: number }>();
    return Response.json({
      ok: true,
      database: 'ready',
      schemaReadiness: DATABASE_SCHEMA_READINESS,
      orders: Number(result?.count ?? 0),
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
