import { jsonError, requestContext } from '../../../../lib/db';
import { getWarehouseWorkspaceData } from '../../../../lib/purchase-order-service';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const { db, user } = await requestContext(request);
    return Response.json({ ok: true, ...await getWarehouseWorkspaceData(db, user) }, {
      headers: { 'Cache-Control': 'private, no-store' },
    });
  } catch (error) {
    return jsonError(error);
  }
}
