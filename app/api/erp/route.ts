import { jsonError, requestContext } from '../../../lib/db';
import { getErpPayload } from '../../../lib/erp-service';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const { db, user } = await requestContext(request);
    const includePlatformPreview = new URL(request.url).searchParams.get('compact') !== '1';
    return Response.json(await getErpPayload(db, user, { includePlatformPreview }), {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    return jsonError(error);
  }
}
