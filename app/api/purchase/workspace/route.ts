import { jsonError, requestContext } from '../../../../lib/db';
import { getPurchaseWorkspace } from '../../../../lib/purchase-workflow-service';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const { db, user } = await requestContext(request);
    const workspace = await getPurchaseWorkspace(db, user);
    return Response.json(workspace, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return jsonError(error);
  }
}
