import { HttpError, requestContext } from '../../../../../lib/db';
import { syncMukuDatasets } from '../../../../../lib/muku-sync-service';
import {
  createMukuClient,
  mukuErrorResponse,
  NO_STORE_HEADERS,
  parseMukuDatasets,
} from '../_shared';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const { db, user } = await requestContext(request);
    const rawBody = await request.text();
    let body: unknown = null;
    if (rawBody.trim()) {
      try {
        body = JSON.parse(rawBody);
      } catch {
        throw new HttpError(400, '请求体不是有效 JSON', 'INVALID_MUKU_SYNC_REQUEST');
      }
    }
    const result = await syncMukuDatasets({
      db,
      user,
      client: createMukuClient(),
      datasets: parseMukuDatasets(body),
      idempotencyKey: request.headers.get('idempotency-key')?.trim() ?? '',
    });
    return Response.json(result, { headers: NO_STORE_HEADERS });
  } catch (error) {
    return mukuErrorResponse(error);
  }
}
