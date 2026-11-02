import { requestContext } from '../../../../../lib/db';
import { getMukuStatus } from '../../../../../lib/muku-sync-service';
import { mukuErrorResponse, NO_STORE_HEADERS } from '../_shared';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const { db, user } = await requestContext(request);
    return Response.json(await getMukuStatus(db, user), { headers: NO_STORE_HEADERS });
  } catch (error) {
    return mukuErrorResponse(error);
  }
}
