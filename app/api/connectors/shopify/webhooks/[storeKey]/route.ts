import { env } from 'cloudflare:workers';
import { ensureDatabase } from '../../../../../../db/initialize';
import { isShopifyStoreKey } from '../../../../../../lib/connectors/shopify/config';
import {
  receiveShopifyOrderWebhook,
  SHOPIFY_WEBHOOK_MAX_BODY_BYTES,
  ShopifyWebhookError,
} from '../../../../../../lib/connectors/shopify/webhook';

export const dynamic = 'force-dynamic';

export async function POST(
  request: Request,
  routeContext: { params: Promise<{ storeKey: string }> },
) {
  try {
    const { storeKey } = await routeContext.params;
    if (!isShopifyStoreKey(storeKey)) {
      return webhookError('UNKNOWN_SHOPIFY_STORE', '未找到该 Shopify 店铺配置', 404);
    }

    const contentLength = Number(request.headers.get('content-length') ?? '0');
    if (Number.isFinite(contentLength) && contentLength > SHOPIFY_WEBHOOK_MAX_BODY_BYTES) {
      return webhookError('SHOPIFY_WEBHOOK_TOO_LARGE', 'Shopify webhook 请求体超过安全上限', 413);
    }

    const runtimeEnv = env as unknown as Record<string, unknown> & { DB?: D1Database };
    if (!runtimeEnv.DB) {
      return webhookError('DATABASE_UNAVAILABLE', '数据库尚未绑定，请稍后重试', 503);
    }
    await ensureDatabase(runtimeEnv.DB);

    const result = await receiveShopifyOrderWebhook({
      db: runtimeEnv.DB,
      runtimeEnv,
      storeKey,
      headers: request.headers,
      rawBody: await readRequestBody(request),
    });
    return Response.json({
      ok: true,
      accepted: result.accepted,
      duplicate: result.duplicate,
      queued: result.queued,
      ignored: result.ignored,
    }, {
      status: result.duplicate ? 200 : 202,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    if (error instanceof ShopifyWebhookError) {
      return webhookError(error.code, error.message, error.status);
    }
    console.error('shopify_webhook_receive_failed', JSON.stringify({
      errorName: error instanceof Error ? error.name : 'UnknownError',
    }));
    return webhookError('SHOPIFY_WEBHOOK_RECEIVE_FAILED', 'Shopify webhook 暂时无法接收', 503);
  }
}

function webhookError(code: string, message: string, status: number) {
  return Response.json({ ok: false, code, message }, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
}

async function readRequestBody(request: Request) {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > SHOPIFY_WEBHOOK_MAX_BODY_BYTES) {
        await reader.cancel('body_limit_exceeded');
        throw new ShopifyWebhookError(
          'SHOPIFY_WEBHOOK_TOO_LARGE',
          'Shopify webhook 请求体超过安全上限',
          413,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}
