import {
  normalizeShopifyDomain,
  resolveShopifyStoreConfig,
  shopifyDomainAccepted,
  type ShopifyStoreKey,
} from './config';

export const SHOPIFY_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;

export const SHOPIFY_ORDER_WEBHOOK_TOPICS = new Set([
  'orders/create',
  'orders/updated',
  'orders/cancelled',
  'orders/edited',
  'orders/paid',
  'orders/fulfilled',
  'orders/partially_fulfilled',
  'refunds/create',
  'fulfillments/create',
  'fulfillments/update',
]);

type WebhookHeaders = {
  hmac: string;
  webhookId: string;
  topic: string;
  shopDomain: string;
  apiVersion: string | null;
  triggeredAt: string | null;
};

type WebhookCredentialOwner = {
  tenant_id: string;
};

export class ShopifyWebhookError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'ShopifyWebhookError';
  }
}

export async function receiveShopifyOrderWebhook(input: {
  db: D1Database;
  runtimeEnv: Record<string, unknown>;
  storeKey: ShopifyStoreKey;
  headers: Headers;
  rawBody: Uint8Array;
  now?: Date;
}) {
  if (input.rawBody.byteLength > SHOPIFY_WEBHOOK_MAX_BODY_BYTES) {
    throw new ShopifyWebhookError('SHOPIFY_WEBHOOK_TOO_LARGE', 'Shopify webhook 请求体超过安全上限', 413);
  }

  const config = resolveShopifyStoreConfig(input.runtimeEnv, input.storeKey);
  if (!config.clientSecret) {
    throw new ShopifyWebhookError(
      'SHOPIFY_WEBHOOK_SECRET_MISSING',
      'Shopify webhook 验签配置尚未完成',
      503,
    );
  }

  const webhook = readWebhookHeaders(input.headers);
  const verified = await verifyShopifyWebhookHmac(input.rawBody, webhook.hmac, config.clientSecret);
  if (!verified) {
    throw new ShopifyWebhookError('SHOPIFY_WEBHOOK_HMAC_INVALID', 'Shopify webhook 验签失败', 401);
  }

  let shopDomain: string;
  try {
    shopDomain = normalizeShopifyDomain(webhook.shopDomain);
  } catch {
    throw new ShopifyWebhookError('SHOPIFY_WEBHOOK_SHOP_INVALID', 'Shopify webhook 店铺域名无效', 401);
  }
  if (!shopifyDomainAccepted(config, shopDomain)) {
    throw new ShopifyWebhookError('SHOPIFY_WEBHOOK_SHOP_MISMATCH', 'Shopify webhook 店铺与连接器不匹配', 401);
  }

  const owner = await input.db.prepare(`
    SELECT tenant_id
    FROM connector_credentials
    WHERE platform = 'shopify' AND store_key = ? AND shop_domain = ?
    LIMIT 1
  `).bind(input.storeKey, shopDomain).first<WebhookCredentialOwner>();
  if (!owner) {
    throw new ShopifyWebhookError('SHOPIFY_WEBHOOK_STORE_UNAUTHORIZED', 'Shopify 店铺尚未完成 ERP 授权', 401);
  }

  const payload = parseWebhookPayload(input.rawBody);
  const sourceOrderId = extractShopifyOrderId(webhook.topic, payload);
  const supported = SHOPIFY_ORDER_WEBHOOK_TOPICS.has(webhook.topic);
  const status = supported && sourceOrderId ? 'pending' : 'ignored';
  const lastErrorCode = supported && !sourceOrderId ? 'SHOPIFY_WEBHOOK_ORDER_ID_MISSING' : null;
  const now = (input.now ?? new Date()).toISOString();
  const result = await input.db.prepare(`
    INSERT INTO shopify_webhook_events (
      id, tenant_id, store_key, webhook_id, topic, shop_domain, source_order_id,
      api_version, triggered_at, payload_hash, status, attempts, last_error_code,
      created_at, updated_at, processed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
    ON CONFLICT(tenant_id, store_key, webhook_id) DO NOTHING
  `).bind(
    crypto.randomUUID(),
    owner.tenant_id,
    input.storeKey,
    webhook.webhookId,
    webhook.topic,
    shopDomain,
    sourceOrderId,
    webhook.apiVersion,
    webhook.triggeredAt,
    await sha256Hex(input.rawBody),
    status,
    lastErrorCode,
    now,
    now,
    status === 'ignored' ? now : null,
  ).run();

  return {
    accepted: true,
    duplicate: Number(result.meta.changes ?? 0) === 0,
    queued: status === 'pending',
    ignored: status === 'ignored',
    topic: webhook.topic,
    sourceOrderId,
  };
}

export async function verifyShopifyWebhookHmac(
  rawBody: Uint8Array,
  receivedHmac: string,
  clientSecret: string,
) {
  if (!receivedHmac.trim() || !clientSecret) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(clientSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, copyArrayBuffer(rawBody)));
  return constantTimeTextEqual(toBase64(signature), receivedHmac.trim());
}

export function extractShopifyOrderId(topic: string, payload: Record<string, unknown>) {
  if (topic.startsWith('orders/')) {
    return orderGid(payload.admin_graphql_api_id) ?? orderGid(payload.id);
  }
  const nestedOrder = isRecord(payload.order) ? payload.order : null;
  return orderGid(payload.order_id)
    ?? orderGid(payload.orderId)
    ?? orderGid(nestedOrder?.admin_graphql_api_id)
    ?? orderGid(nestedOrder?.id);
}

function readWebhookHeaders(headers: Headers): WebhookHeaders {
  return {
    hmac: requiredHeader(headers, 'x-shopify-hmac-sha256', 256),
    webhookId: requiredHeader(headers, 'x-shopify-webhook-id', 200),
    topic: requiredHeader(headers, 'x-shopify-topic', 100).toLowerCase(),
    shopDomain: requiredHeader(headers, 'x-shopify-shop-domain', 255),
    apiVersion: optionalHeader(headers, 'x-shopify-api-version', 40),
    triggeredAt: optionalHeader(headers, 'x-shopify-triggered-at', 80),
  };
}

function requiredHeader(headers: Headers, name: string, maxLength: number) {
  const value = optionalHeader(headers, name, maxLength);
  if (!value) {
    throw new ShopifyWebhookError('SHOPIFY_WEBHOOK_HEADER_MISSING', 'Shopify webhook 请求头不完整', 400);
  }
  return value;
}

function optionalHeader(headers: Headers, name: string, maxLength: number) {
  const value = headers.get(name)?.trim() ?? '';
  if (!value) return null;
  if (value.length > maxLength) {
    throw new ShopifyWebhookError('SHOPIFY_WEBHOOK_HEADER_INVALID', 'Shopify webhook 请求头无效', 400);
  }
  return value;
}

function parseWebhookPayload(rawBody: Uint8Array) {
  try {
    const payload = JSON.parse(new TextDecoder().decode(rawBody));
    if (!isRecord(payload)) throw new Error('payload_not_object');
    return payload;
  } catch {
    throw new ShopifyWebhookError('SHOPIFY_WEBHOOK_PAYLOAD_INVALID', 'Shopify webhook 请求体无效', 400);
  }
}

function orderGid(value: unknown) {
  if (typeof value === 'string') {
    const normalized = value.trim();
    if (/^gid:\/\/shopify\/Order\/\d+$/.test(normalized)) return normalized;
    if (/^\d+$/.test(normalized)) return `gid://shopify/Order/${normalized}`;
  }
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
    return `gid://shopify/Order/${value}`;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function sha256Hex(value: Uint8Array) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', copyArrayBuffer(value)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function toBase64(value: Uint8Array) {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function constantTimeTextEqual(left: string, right: string) {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const length = Math.max(leftBytes.length, rightBytes.length);
  let mismatch = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < length; index += 1) {
    mismatch |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return mismatch === 0;
}

function copyArrayBuffer(value: Uint8Array) {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
}
