import { env } from 'cloudflare:workers';
import { chooseAmazonStore } from '../../../../../lib/connectors/amazon/store-settings';
import { amazonOrderSyncRequestSchema, amazonSyncFailure, runAmazonOrderSync } from '../../../../../lib/connectors/amazon/sync-service';
import { HttpError, requestContext, requirePermission } from '../../../../../lib/db';

export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store' };

export async function POST(request: Request) {
  try {
    const { db, user } = await requestContext(request);
    requirePermission(user, 'connectors:sync');
    const parsed = amazonOrderSyncRequestSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) throw new HttpError(400, '请选择 Amazon 店铺及有效的同步时间范围', 'AMAZON_INVALID_SYNC_REQUEST');
    const config = chooseAmazonStore(env as unknown as Record<string, unknown>, user.tenantId, parsed.data.storeKey);
    const sync = await runAmazonOrderSync({ db, tenantId: user.tenantId, config, request: parsed.data });
    return Response.json(sync, { headers, status: sync.complete ? 200 : 202 });
  } catch (error) {
    const { status, ...failure } = amazonSyncFailure(error);
    return Response.json({ ok: false, ...failure }, { status, headers });
  }
}
