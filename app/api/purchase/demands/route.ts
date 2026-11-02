import { jsonError, requestContext } from '../../../../lib/db';
import { getPurchaseDemands } from '../../../../lib/purchase-demand-service';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const { db, user } = await requestContext(request);
    return Response.json(await getPurchaseDemands(db, user), {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    return jsonError(error);
  }
}
