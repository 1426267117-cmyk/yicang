import { env } from 'cloudflare:workers';
import { getWayfairStoreSettings } from '../../../../../lib/connectors/wayfair/store-settings';
import { jsonError, requestContext, requirePermission } from '../../../../../lib/db';

export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store' };

export async function GET(request: Request) {
  try {
    const { user } = await requestContext(request);
    requirePermission(user, 'connectors:read');
    const { status } = getWayfairStoreSettings(env as unknown as Record<string, unknown>, user.tenantId);
    return Response.json({ ok: true, ...status }, { headers });
  } catch (error) {
    const response = jsonError(error);
    response.headers.set('Cache-Control', headers['Cache-Control']);
    return response;
  }
}
