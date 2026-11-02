import { jsonError, requestContext } from '../../../../lib/db';
import { getPurchasePlanning } from '../../../../lib/purchase-planning-service';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const { db, user } = await requestContext(request);
    const result = await getPurchasePlanning(db, user);
    return Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return jsonError(error);
  }
}
