import { ensureDatabase } from '../db/initialize';
import { MukuDashboardClient } from './connectors/muku/client';
import { resolveMukuConfig } from './connectors/muku/config';
import { sanitizedMukuConnectorError } from './connectors/muku/errors';
import { createMukuLocalEgressFetch } from './connectors/muku/local-egress';
import { sanitizedConnectorError } from './connectors/shopify/errors';
import { reconcileStoredShopifyOrders } from './connectors/shopify/reconcile';
import {
  evaluateMukuFreshness,
  refreshMukuIfDue,
  type MukuFreshnessReport,
} from './muku-freshness-service';

export const SITE_MCP_VERSION = '2026-07-28';
export const SITE_MCP_TENANT_LIMIT = 20;
const SHOPIFY_RECONCILE_MAX_PAGES = 20;
const DEFAULT_ORDER_FRESHNESS_MAX_AGE_MINUTES = 30;

const GET_FRESHNESS_TOOL = 'get_procurement_freshness';
const REFRESH_SOURCES_TOOL = 'refresh_procurement_sources';

type RuntimeEnv = Record<string, unknown> & { DB?: D1Database };
type JsonRpcId = string | number | null;
type TenantRow = { id: string; name: string };
type MukuClient = Pick<MukuDashboardClient, 'verifyManifest' | 'getAllPages'>;

type SafeShopifyFreshness = {
  status: 'fresh' | 'stale' | 'missing';
  readyForProcurement: boolean;
  maxAgeMinutes: number;
  storesConfigured: number;
  freshStores: number;
  staleStores: number;
  failedStores: number;
  latestSuccessfulSyncAt: string | null;
};

type SafeTenantFreshness = {
  tenantName: string;
  readyForProcurement: boolean;
  muku: ReturnType<typeof sanitizeMukuFreshness>;
  shopify: SafeShopifyFreshness;
};

type SiteMcpDependencies = {
  ensureDatabase: typeof ensureDatabase;
  listTenants: (db: D1Database) => Promise<TenantRow[]>;
  readTenantFreshness: (input: {
    db: D1Database;
    tenant: TenantRow;
    runtimeEnv: RuntimeEnv;
  }) => Promise<SafeTenantFreshness>;
  createMukuClient: (runtimeEnv: RuntimeEnv) => MukuClient;
  refreshMuku: typeof refreshMukuIfDue;
  reconcileShopify: typeof reconcileStoredShopifyOrders;
};

const DEFAULT_DEPENDENCIES: SiteMcpDependencies = {
  ensureDatabase,
  listTenants,
  readTenantFreshness,
  createMukuClient,
  refreshMuku: refreshMukuIfDue,
  reconcileShopify: reconcileStoredShopifyOrders,
};

export async function handleSiteMcpRequest(
  request: Request,
  runtimeEnv: RuntimeEnv,
  overrides: Partial<SiteMcpDependencies> = {},
) {
  if (request.method !== 'POST') {
    return new Response(null, {
      status: 405,
      headers: { Allow: 'POST', 'Cache-Control': 'no-store' },
    });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return jsonRpcError(null, -32700, 'Parse error');
  }
  if (!isJsonRpcRequest(payload)) {
    return jsonRpcError(null, -32600, 'Invalid Request');
  }

  const id = Object.hasOwn(payload, 'id') ? payload.id as JsonRpcId : null;
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
  try {
    const result = await dispatchJsonRpc(payload, request, runtimeEnv, dependencies);
    if (!Object.hasOwn(payload, 'id')) {
      return new Response(null, { status: 204, headers: NO_STORE_HEADERS });
    }
    return jsonRpcResult(id, result);
  } catch (error) {
    if (error instanceof JsonRpcRequestError) {
      return jsonRpcError(id, error.code, error.message);
    }
    return jsonRpcError(id, -32603, 'Internal error');
  }
}

async function dispatchJsonRpc(
  payload: JsonRpcRequest,
  request: Request,
  runtimeEnv: RuntimeEnv,
  dependencies: SiteMcpDependencies,
) {
  if (payload.method === 'server/discover') {
    return {
      supportedVersions: [SITE_MCP_VERSION],
      capabilities: { tools: {} },
    };
  }
  if (payload.method === 'tools/list') {
    return { tools: toolDefinitions() };
  }
  if (payload.method !== 'tools/call') {
    throw new JsonRpcRequestError(-32601, 'Method not found');
  }

  const call = parseToolCall(payload.params);
  try {
    const callerEmail = requireAuthenticatedEmail(request.headers);
    if (call.name === GET_FRESHNESS_TOOL) {
      const result = await getProcurementFreshness(runtimeEnv, dependencies);
      return toolResult(result);
    }
    if (call.name === REFRESH_SOURCES_TOOL) {
      requireAutomationCaller(callerEmail, runtimeEnv);
      const result = await refreshProcurementSources(request, runtimeEnv, dependencies);
      return toolResult(result, !result.ok);
    }
    return toolResult({
      ok: false,
      code: 'MCP_TOOL_NOT_FOUND',
      message: '请求的工具不存在',
    }, true);
  } catch (error) {
    if (error instanceof SiteMcpToolError) {
      return toolResult({ ok: false, code: error.code, message: error.message }, true);
    }
    return toolResult({
      ok: false,
      code: 'PROCUREMENT_TOOL_FAILED',
      message: '采购数据任务执行失败，敏感错误详情已隐藏',
    }, true);
  }
}

function toolDefinitions() {
  const emptyInput = {
    type: 'object',
    properties: {},
    additionalProperties: false,
  } as const;
  return [
    {
      name: GET_FRESHNESS_TOOL,
      description: '只读检查 ERP 采购依赖的 MUKU 库存与 Shopify 订单同步时效；不返回订单、客户或凭证。',
      inputSchema: emptyInput,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    {
      name: REFRESH_SOURCES_TOOL,
      description: '按固定配置刷新到期的 MUKU 只读数据并增量对账已授权 Shopify 店铺；不接受 URL、凭证或租户参数。',
      inputSchema: emptyInput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
  ];
}

async function getProcurementFreshness(
  runtimeEnv: RuntimeEnv,
  dependencies: SiteMcpDependencies,
) {
  const db = requireDatabase(runtimeEnv);
  await dependencies.ensureDatabase(db);
  const tenants = (await dependencies.listTenants(db)).slice(0, SITE_MCP_TENANT_LIMIT);
  const results: SafeTenantFreshness[] = [];
  const failures: Array<{ tenantName: string; code: string }> = [];

  for (const tenant of tenants) {
    try {
      results.push(await dependencies.readTenantFreshness({ db, tenant, runtimeEnv }));
    } catch {
      failures.push({ tenantName: safeTenantName(tenant.name), code: 'FRESHNESS_READ_FAILED' });
    }
  }

  const readyTenants = results.filter((result) => result.readyForProcurement).length;
  return {
    ok: failures.length === 0,
    checkedAt: new Date().toISOString(),
    tenantLimit: SITE_MCP_TENANT_LIMIT,
    tenantsChecked: tenants.length,
    readyTenants,
    blockedTenants: tenants.length - readyTenants,
    tenants: results,
    failures,
  };
}

async function refreshProcurementSources(
  request: Request,
  runtimeEnv: RuntimeEnv,
  dependencies: SiteMcpDependencies,
) {
  const db = requireDatabase(runtimeEnv);
  await dependencies.ensureDatabase(db);
  const tenants = (await dependencies.listTenants(db)).slice(0, SITE_MCP_TENANT_LIMIT);

  const muku = await refreshMukuTenants(db, tenants, runtimeEnv, dependencies);
  const shopify = await refreshShopifyTenants(request, db, tenants, runtimeEnv, dependencies);
  const freshness = await getProcurementFreshness(runtimeEnv, {
    ...dependencies,
    ensureDatabase: async () => {},
    listTenants: async () => tenants,
  });
  return {
    ok: muku.ok && shopify.ok && freshness.ok,
    completedAt: new Date().toISOString(),
    tenantLimit: SITE_MCP_TENANT_LIMIT,
    tenantsChecked: tenants.length,
    muku,
    shopify,
    freshness: {
      readyTenants: freshness.readyTenants,
      blockedTenants: freshness.blockedTenants,
      failures: freshness.failures,
    },
  };
}

async function refreshMukuTenants(
  db: D1Database,
  tenants: TenantRow[],
  runtimeEnv: RuntimeEnv,
  dependencies: SiteMcpDependencies,
) {
  let client: MukuClient;
  try {
    client = dependencies.createMukuClient(runtimeEnv);
  } catch (error) {
    const failure = sanitizedMukuConnectorError(error);
    return {
      ok: false,
      tenantsChecked: 0,
      attempted: 0,
      skipped: 0,
      failures: [{ code: failure.code, retryable: failure.retryable }],
      results: [],
    };
  }

  const results: Array<{
    tenantName: string;
    ok: boolean;
    attempted: boolean;
    skipReason: string | null;
    status: string | null;
    readyForProcurement: boolean;
  }> = [];
  const failures: Array<{ tenantName: string; code: string; retryable: boolean }> = [];
  for (const tenant of tenants) {
    try {
      const refreshed = await dependencies.refreshMuku({
        db,
        tenantId: tenant.id,
        tenantName: tenant.name,
        client,
        runtimeEnv,
        force: false,
      });
      const current = 'after' in refreshed && refreshed.after ? refreshed.after : refreshed.before;
      results.push({
        tenantName: safeTenantName(tenant.name),
        ok: refreshed.ok,
        attempted: refreshed.attempted,
        skipReason: refreshed.skipReason,
        status: current.status,
        readyForProcurement: current.readyForProcurement,
      });
    } catch (error) {
      const failure = sanitizedMukuConnectorError(error);
      failures.push({
        tenantName: safeTenantName(tenant.name),
        code: failure.code,
        retryable: failure.retryable,
      });
    }
  }
  return {
    ok: failures.length === 0 && results.every((result) => result.ok),
    tenantsChecked: tenants.length,
    attempted: results.filter((result) => result.attempted).length,
    skipped: results.filter((result) => !result.attempted).length,
    failures,
    results,
  };
}

async function refreshShopifyTenants(
  request: Request,
  db: D1Database,
  tenants: TenantRow[],
  runtimeEnv: RuntimeEnv,
  dependencies: SiteMcpDependencies,
) {
  try {
    const result = await dependencies.reconcileShopify({
      db,
      runtimeEnv,
      requestUrl: new URL(request.url).origin,
      tenantIds: tenants.map((tenant) => tenant.id),
      maxPages: SHOPIFY_RECONCILE_MAX_PAGES,
    });
    return {
      ok: result.ok,
      storesChecked: result.storesChecked,
      storesSynced: result.synced.length,
      storesSkipped: result.skipped.length,
      storesFailed: result.failed.length,
      pagesCompleted: sum(result.synced.map((item) => item.pagesCompleted)),
      ordersSeen: sum(result.synced.map((item) => item.ordersSeen)),
      ordersInserted: sum(result.synced.map((item) => item.ordersInserted)),
      ordersUpdated: sum(result.synced.map((item) => item.ordersUpdated)),
      ordersUnchanged: sum(result.synced.map((item) => item.ordersUnchanged)),
      skippedCodes: countCodes(result.skipped.map((item) => item.code)),
      failureCodes: countCodes(result.failed.map((item) => item.code)),
    };
  } catch (error) {
    const failure = sanitizedConnectorError(error);
    return {
      ok: false,
      storesChecked: 0,
      storesSynced: 0,
      storesSkipped: 0,
      storesFailed: 1,
      pagesCompleted: 0,
      ordersSeen: 0,
      ordersInserted: 0,
      ordersUpdated: 0,
      ordersUnchanged: 0,
      skippedCodes: {},
      failureCodes: { [failure.code]: 1 },
    };
  }
}

async function listTenants(db: D1Database) {
  const rows = await db.prepare(`
    SELECT id, name
    FROM tenants
    ORDER BY created_at, id
    LIMIT ?
  `).bind(SITE_MCP_TENANT_LIMIT).all<TenantRow>();
  return rows.results;
}

async function readTenantFreshness(input: {
  db: D1Database;
  tenant: TenantRow;
  runtimeEnv: RuntimeEnv;
}): Promise<SafeTenantFreshness> {
  const [muku, shopify] = await Promise.all([
    evaluateMukuFreshness(input.db, input.tenant.id, { runtimeEnv: input.runtimeEnv }),
    readShopifyFreshness(input.db, input.tenant.id, input.runtimeEnv),
  ]);
  return {
    tenantName: safeTenantName(input.tenant.name),
    readyForProcurement: muku.readyForProcurement && shopify.readyForProcurement,
    muku: sanitizeMukuFreshness(muku),
    shopify,
  };
}

async function readShopifyFreshness(
  db: D1Database,
  tenantId: string,
  runtimeEnv: RuntimeEnv,
): Promise<SafeShopifyFreshness> {
  const maxAgeMinutes = boundedEnvInteger(
    runtimeEnv.ERP_ORDER_SYNC_MAX_AGE_MINUTES,
    DEFAULT_ORDER_FRESHNESS_MAX_AGE_MINUTES,
    5,
    24 * 60,
  );
  const threshold = new Date(Date.now() - maxAgeMinutes * 60_000).toISOString();
  const row = await db.prepare(`
    SELECT COUNT(*) AS stores_configured,
           SUM(CASE
             WHEN COALESCE(state.status, 'idle') != 'failed'
              AND COALESCE(state.last_success_at, store.last_successful_sync_at) >= ?
             THEN 1 ELSE 0
           END) AS fresh_stores,
           SUM(CASE WHEN state.status = 'failed' THEN 1 ELSE 0 END) AS failed_stores,
           MAX(COALESCE(state.last_success_at, store.last_successful_sync_at)) AS latest_success_at
    FROM platform_stores store
    LEFT JOIN connector_sync_state state
      ON state.platform_store_id = store.id
     AND state.tenant_id = store.tenant_id
     AND state.connector = 'shopify'
     AND state.resource = 'orders'
    WHERE store.tenant_id = ? AND store.platform = 'shopify' AND store.active = 1
  `).bind(threshold, tenantId).first<{
    stores_configured: number | null;
    fresh_stores: number | null;
    failed_stores: number | null;
    latest_success_at: string | null;
  }>();
  const storesConfigured = Number(row?.stores_configured ?? 0);
  const freshStores = Number(row?.fresh_stores ?? 0);
  const failedStores = Number(row?.failed_stores ?? 0);
  const staleStores = Math.max(0, storesConfigured - freshStores);
  const readyForProcurement = storesConfigured > 0 && staleStores === 0 && failedStores === 0;
  return {
    status: storesConfigured === 0 ? 'missing' : readyForProcurement ? 'fresh' : 'stale',
    readyForProcurement,
    maxAgeMinutes,
    storesConfigured,
    freshStores,
    staleStores,
    failedStores,
    latestSuccessfulSyncAt: row?.latest_success_at ?? null,
  };
}

function sanitizeMukuFreshness(report: MukuFreshnessReport) {
  return {
    status: report.status,
    readyForProcurement: report.readyForProcurement,
    checkedAt: report.checkedAt,
    maxAgeMinutes: report.maxAgeMinutes,
    needsRefresh: report.needsRefresh,
    refreshDue: report.refreshDue,
    refreshInProgress: report.refreshInProgress,
    nextRefreshAt: report.nextRefreshAt,
    datasets: report.datasets.map((dataset) => ({
      dataset: dataset.dataset,
      requiredForProcurement: dataset.requiredForProcurement,
      fresh: dataset.fresh,
      status: dataset.stateStatus,
      generatedAt: dataset.generatedAt,
      lastSuccessAt: dataset.lastSuccessAt,
      recordCount: dataset.recordCount,
      lastErrorCode: dataset.lastErrorCode,
      reasonCodes: dataset.reasons.map((reason) => reason.code),
    })),
  };
}

function createMukuClient(runtimeEnv: RuntimeEnv) {
  const config = resolveMukuConfig(runtimeEnv);
  return new MukuDashboardClient(config, createMukuLocalEgressFetch(config));
}

function requireDatabase(runtimeEnv: RuntimeEnv) {
  if (!runtimeEnv.DB) {
    throw new SiteMcpToolError('DATABASE_UNAVAILABLE', 'ERP 数据库尚未绑定');
  }
  return runtimeEnv.DB;
}

function requireAuthenticatedEmail(headers: Headers) {
  const value = headers.get('oai-authenticated-user-email')?.trim().toLowerCase();
  if (!value || !isPlausibleEmail(value)) {
    throw new SiteMcpToolError(
      'AUTHENTICATED_USER_REQUIRED',
      '此工具需要 Sites 提供已验证的用户邮箱',
    );
  }
  return value;
}

function requireAutomationCaller(email: string, runtimeEnv: RuntimeEnv) {
  const allowed = parseAutomationAllowedEmails(runtimeEnv.ERP_AUTOMATION_ALLOWED_EMAILS);
  if (allowed.size === 0) {
    throw new SiteMcpToolError(
      'AUTOMATION_ALLOWLIST_NOT_CONFIGURED',
      '尚未配置采购自动化允许邮箱，刷新任务已拒绝执行',
    );
  }
  if (!allowed.has(email)) {
    throw new SiteMcpToolError(
      'AUTOMATION_CALLER_NOT_ALLOWED',
      '当前账号不在采购自动化允许列表中',
    );
  }
}

export function parseAutomationAllowedEmails(value: unknown) {
  if (typeof value !== 'string') return new Set<string>();
  return new Set(value
    .split(/[;,\s]+/)
    .map((email) => email.trim().toLowerCase())
    .filter((email) => isPlausibleEmail(email)));
}

function parseToolCall(params: unknown) {
  if (!isRecord(params) || typeof params.name !== 'string') {
    throw new JsonRpcRequestError(-32602, 'Invalid params');
  }
  if (Object.keys(params).some((key) => key !== 'name' && key !== 'arguments' && key !== '_meta')) {
    throw new JsonRpcRequestError(-32602, 'Invalid params');
  }
  const args = params.arguments ?? {};
  if (!isRecord(args) || Object.keys(args).length !== 0) {
    throw new JsonRpcRequestError(-32602, 'Invalid params');
  }
  return { name: params.name };
}

function toolResult(value: unknown, isError = false) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    ...(isError ? { isError: true } : {}),
  };
}

function jsonRpcResult(id: JsonRpcId, result: unknown) {
  return Response.json({ jsonrpc: '2.0', id, result }, { headers: NO_STORE_HEADERS });
}

function jsonRpcError(id: JsonRpcId, code: number, message: string) {
  return Response.json({ jsonrpc: '2.0', id, error: { code, message } }, {
    status: 200,
    headers: NO_STORE_HEADERS,
  });
}

type JsonRpcRequest = {
  jsonrpc: '2.0';
  id?: JsonRpcId;
  method: string;
  params?: unknown;
};

function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  if (!isRecord(value) || value.jsonrpc !== '2.0' || typeof value.method !== 'string') return false;
  if (Object.hasOwn(value, 'id') && !isJsonRpcId(value.id)) return false;
  return true;
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return value === null || typeof value === 'string'
    || (typeof value === 'number' && Number.isFinite(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isPlausibleEmail(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function safeTenantName(value: string) {
  return value.trim().slice(0, 120) || '未命名租户';
}

function boundedEnvInteger(value: unknown, fallback: number, minimum: number, maximum: number) {
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) return fallback;
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0);
}

function countCodes(codes: string[]) {
  const counts: Record<string, number> = {};
  for (const code of codes) counts[code] = (counts[code] ?? 0) + 1;
  return counts;
}

class JsonRpcRequestError extends Error {
  constructor(public readonly code: number, message: string) {
    super(message);
  }
}

class SiteMcpToolError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

const NO_STORE_HEADERS = { 'Cache-Control': 'no-store' } as const;
