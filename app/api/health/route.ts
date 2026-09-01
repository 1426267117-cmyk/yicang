import { jsonError, requestContext } from '../../../lib/db';

export async function GET(request: Request) {
  try {
    const { db } = await requestContext(request);
    const result = await db.prepare('SELECT COUNT(*) AS count FROM orders').first<{ count: number }>();
    return Response.json({ ok: true, database: 'ready', orders: Number(result?.count ?? 0) });
  } catch (error) {
    return jsonError(error);
  }
}
