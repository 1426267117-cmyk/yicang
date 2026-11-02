import { requestContext, requirePermission } from '../../../../../lib/db';
import { testMukuConnection } from '../../../../../lib/muku-sync-service';
import { createMukuClient, mukuErrorResponse, NO_STORE_HEADERS } from '../_shared';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const { user } = await requestContext(request);
    requirePermission(user, 'connectors:sync');
    const result = await testMukuConnection(createMukuClient());
    return Response.json(result, { headers: NO_STORE_HEADERS });
  } catch (error) {
    return mukuErrorResponse(error);
  }
}
