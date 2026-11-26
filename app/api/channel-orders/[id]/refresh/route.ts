import { env } from 'cloudflare:workers';
import { channelOrderIdSchema } from '../../../../../lib/channel-orders';
import { refreshChannelOrder } from '../../../../../lib/channel-order-refresh';
import { AmazonConnectorError } from '../../../../../lib/connectors/amazon/orders';
import { amazonSyncFailure } from '../../../../../lib/connectors/amazon/sync-service';
import { ShopifyConnectorError } from '../../../../../lib/connectors/shopify/errors';
import { HttpError, requestContext } from '../../../../../lib/db';

export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store' };

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { db, user } = await requestContext(request);
    const parsed = channelOrderIdSchema.safeParse((await params).id);
    if (!parsed.success) throw new HttpError(404, '未找到渠道订单', 'CHANNEL_ORDER_NOT_FOUND');
    const result = await refreshChannelOrder({
      db, user, requestUrl: request.url, runtimeEnv: env as unknown as Record<string, unknown>,
    }, parsed.data);
    return Response.json({ ok: true, ...result }, { headers });
  } catch (error) {
    if (error instanceof AmazonConnectorError) {
      const { status, ...failure } = amazonSyncFailure(error);
      return Response.json({ ok: false, ...failure }, { status, headers });
    }
    if (error instanceof HttpError || error instanceof ShopifyConnectorError) {
      return Response.json({ ok: false, code: error.code, message: error.message }, { status: error.status ?? 422, headers });
    }
    return Response.json({ ok: false, code: 'CHANNEL_ORDER_REFRESH_FAILED', message: '暂时无法刷新此订单的渠道来源' }, { status: 503, headers });
  }
}
