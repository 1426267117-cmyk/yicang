import { env } from 'cloudflare:workers';
import { z } from 'zod';
import { ensureDatabase } from '../../../../../db/initialize';
import { isShopifyStoreKey, type ShopifyStoreKey } from '../../../../../lib/connectors/shopify/config';
import { sanitizedConnectorError, ShopifyConnectorError } from '../../../../../lib/connectors/shopify/errors';
import { reconcileStoredShopifyOrders } from '../../../../../lib/connectors/shopify/reconcile';
import { HttpError, jsonError } from '../../../../../lib/db';
import {
  InternalJobAuthError,
  requireInternalJobToken,
} from '../../../../../lib/internal-job-auth';

export const dynamic = 'force-dynamic';

const NO_STORE_HEADERS = { 'Cache-Control': 'no-store' } as const;
const reconcileRequestSchema = z.object({
  storeKeys: z.array(z.string().trim().min(1)).min(1).max(4).optional(),
  maxPages: z.number().int().min(1).max(500).default(100),
}).strict();

type ReconcileRouteDependencies = {
  ensureDatabase: typeof ensureDatabase;
  reconcile: typeof reconcileStoredShopifyOrders;
};

export async function POST(request: Request) {
  return handleShopifyReconcileRequest(
    request,
    env as unknown as Record<string, unknown> & { DB?: D1Database },
  );
}

export async function handleShopifyReconcileRequest(
  request: Request,
  runtimeEnv: Record<string, unknown> & { DB?: D1Database },
  overrides: Partial<ReconcileRouteDependencies> = {},
) {
  const dependencies: ReconcileRouteDependencies = {
    ensureDatabase,
    reconcile: reconcileStoredShopifyOrders,
    ...overrides,
  };
  try {
    requireInternalJobToken(request.headers, runtimeEnv);
    const db = runtimeEnv.DB;
    if (!db) throw new HttpError(503, '数据库尚未绑定，请稍后重试', 'DATABASE_UNAVAILABLE');
    await dependencies.ensureDatabase(db);
    const body = await parseBody(request);
    const parsed = reconcileRequestSchema.safeParse(body);
    if (!parsed.success) {
      return Response.json({
        ok: false,
        code: 'INVALID_SHOPIFY_RECONCILE_REQUEST',
        message: parsed.error.issues[0]?.message ?? 'Shopify 定时对账参数无效',
      }, { status: 400, headers: NO_STORE_HEADERS });
    }
    if (parsed.data.storeKeys?.some((key) => !isShopifyStoreKey(key))) {
      return Response.json({
        ok: false,
        code: 'INVALID_SHOPIFY_RECONCILE_REQUEST',
        message: 'storeKeys 包含尚未支持的 Shopify 店铺',
      }, { status: 400, headers: NO_STORE_HEADERS });
    }
    const result = await dependencies.reconcile({
      db,
      runtimeEnv,
      requestUrl: request.url,
      storeKeys: parsed.data.storeKeys as ShopifyStoreKey[] | undefined,
      maxPages: parsed.data.maxPages,
    });
    return Response.json({
      ...result,
      scheduling: {
        externalScheduleConfigured: explicitTrue(
          runtimeEnv.ERP_SHOPIFY_RECONCILE_SCHEDULE_CONFIGURED,
        ),
        recommendedIntervalMinutes: 15,
      },
    }, {
      status: result.ok ? 200 : 207,
      headers: NO_STORE_HEADERS,
    });
  } catch (error) {
    if (error instanceof InternalJobAuthError) {
      return Response.json({ ok: false, code: error.code, message: error.message }, {
        status: error.status,
        headers: NO_STORE_HEADERS,
      });
    }
    if (error instanceof ShopifyConnectorError) {
      const safe = sanitizedConnectorError(error);
      return Response.json({ ok: false, ...safe }, {
        status: error.status ?? (error.retryable ? 503 : 422),
        headers: NO_STORE_HEADERS,
      });
    }
    const response = jsonError(error);
    const headers = new Headers(response.headers);
    headers.set('Cache-Control', 'no-store');
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
}

function explicitTrue(value: unknown) {
  if (value === true) return true;
  return typeof value === 'string' && value.trim().toLowerCase() === 'true';
}

async function parseBody(request: Request) {
  const text = await request.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
