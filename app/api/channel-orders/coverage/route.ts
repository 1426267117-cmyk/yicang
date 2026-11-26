import { jsonError, requestContext } from '../../../../lib/db';
import { readStoreCoverage } from '../../../../lib/store-coverage';

export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store' };

export async function GET(request: Request) {
  try {
    const { db, user } = await requestContext(request);
    return Response.json({ ok: true, ...await readStoreCoverage(db, user) }, { headers });
  } catch (error) {
    const response = jsonError(error);
    response.headers.set('Cache-Control', headers['Cache-Control']);
    return response;
  }
}
