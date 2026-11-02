import { requestContext } from '../../../../../lib/db';
import { getMukuInventoryRisk } from '../../../../../lib/muku-sync-service';
import { mukuErrorResponse, NO_STORE_HEADERS, parsePagination } from '../_shared';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const { db, user } = await requestContext(request);
    const { sku, page, pageSize } = parsePagination(new URL(request.url));
    return Response.json(await getMukuInventoryRisk(db, user, { sku, page, pageSize }), {
      headers: NO_STORE_HEADERS,
    });
  } catch (error) {
    return mukuErrorResponse(error);
  }
}
