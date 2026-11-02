import { HttpError, requestContext } from '../../../../../lib/db';
import { getMukuRuns, MUKU_SYNC_DATASETS } from '../../../../../lib/muku-sync-service';
import { mukuErrorResponse, NO_STORE_HEADERS, parsePagination } from '../_shared';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const { db, user } = await requestContext(request);
    const url = new URL(request.url);
    const dataset = url.searchParams.get('dataset')?.trim() || undefined;
    if (dataset && !(MUKU_SYNC_DATASETS as readonly string[]).includes(dataset)) {
      throw new HttpError(400, 'dataset 尚未支持', 'INVALID_MUKU_DATASET');
    }
    const { page, pageSize } = parsePagination(url);
    return Response.json(await getMukuRuns(db, user, { dataset, page, pageSize }), {
      headers: NO_STORE_HEADERS,
    });
  } catch (error) {
    return mukuErrorResponse(error);
  }
}
