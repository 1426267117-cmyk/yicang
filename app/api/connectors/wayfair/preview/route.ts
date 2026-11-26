import { env } from 'cloudflare:workers';
import { previewWayfairOrders, wayfairPreviewSchema } from '../../../../../lib/connectors/wayfair/order-preview';
import { getWayfairStoreSettings } from '../../../../../lib/connectors/wayfair/store-settings';
import { HttpError, jsonError, requestContext, requirePermission, requireProductionAccessPolicy } from '../../../../../lib/db';

export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store' };

export async function POST(request: Request) {
  try {
    const { user } = await requestContext(request);
    requirePermission(user, 'connectors:sync');
    const parsed = wayfairPreviewSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new HttpError(400, '请选择 Wayfair 采购单确认状态', 'WAYFAIR_QUERY_INVALID');
    const runtimeEnv = env as unknown as Record<string, unknown>;
    const { config } = getWayfairStoreSettings(runtimeEnv, user.tenantId);
    if (!config) throw new HttpError(409, 'Wayfair 林和尚未配置完整授权和核验订单', 'WAYFAIR_CONFIGURATION_REQUIRED');
    if (config.environment === 'production') requireProductionAccessPolicy(runtimeEnv, user.email);
    const result = await previewWayfairOrders(config, parsed.data);
    return Response.json({ ok: true, ...result }, { headers });
  } catch (error) {
    const response = jsonError(error);
    response.headers.set('Cache-Control', headers['Cache-Control']);
    return response;
  }
}
