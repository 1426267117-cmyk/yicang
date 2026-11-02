import { requestContext } from '../../../../../lib/db';
import { getMukuStatus } from '../../../../../lib/muku-sync-service';
import { hasMukuConfiguration, mukuErrorResponse, NO_STORE_HEADERS } from '../_shared';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const { db, user } = await requestContext(request);
    const status = await getMukuStatus(db, user);
    return Response.json({ ...status, configured: hasMukuConfiguration() }, { headers: NO_STORE_HEADERS });
  } catch (error) {
    return mukuErrorResponse(error);
  }
}
