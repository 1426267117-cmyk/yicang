import { env } from 'cloudflare:workers';
import { amazonOrdersApiVersion, readAmazonStoreStatuses } from '../../../../../lib/connectors/amazon/store-settings';
import { jsonError, requestContext, requirePermission } from '../../../../../lib/db';

export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store' };

export async function GET(request: Request) {
  try {
    const { db, user } = await requestContext(request);
    requirePermission(user, 'connectors:read');
    const runtimeEnv = env as unknown as Record<string, unknown>;
    const stores = await readAmazonStoreStatuses(db, user.tenantId, runtimeEnv);
    return Response.json({ ok: true, apiVersion: amazonOrdersApiVersion, stores }, { headers });
  } catch (error) {
    const response = jsonError(error);
    response.headers.set('Cache-Control', headers['Cache-Control']);
    return response;
  }
}
