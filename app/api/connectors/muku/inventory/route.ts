import { requestContext } from '../../../../../lib/db';
import { getMukuInventory } from '../../../../../lib/muku-sync-service';
import { mukuErrorResponse, NO_STORE_HEADERS, parsePagination } from '../_shared';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const { db, user } = await requestContext(request);
    const result = await getMukuInventory(db, user, parsePagination(new URL(request.url), { warehouse: true }));
    return Response.json(result, { headers: NO_STORE_HEADERS });
  } catch (error) {
    return mukuErrorResponse(error);
  }
}
