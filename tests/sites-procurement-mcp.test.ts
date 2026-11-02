import { describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({ env: {} }));

import {
  handleSiteMcpRequest,
  parseAutomationAllowedEmails,
  SITE_MCP_TENANT_LIMIT,
  SITE_MCP_VERSION,
  summarizeShopifyOrderSources,
} from '../lib/sites-procurement-mcp';

describe('Sites procurement MCP JSON-RPC', () => {
  it('discovers MCP 2026-07-28 and lists only the bounded procurement tools', async () => {
    const discover = await rpc('server/discover');
    expect(discover.status).toBe(200);
    expect(discover.headers.get('cache-control')).toBe('no-store');
    expect(await discover.json()).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {
        supportedVersions: [SITE_MCP_VERSION],
        capabilities: { tools: {} },
      },
    });

    const listed = await rpc('tools/list');
    const payload = await listed.json() as {
      result: { tools: Array<{ name: string; inputSchema: Record<string, unknown> }> };
    };
    expect(payload.result.tools.map((tool) => tool.name)).toEqual([
      'get_procurement_freshness',
      'refresh_procurement_sources',
    ]);
    expect(payload.result.tools.every((tool) => tool.inputSchema.additionalProperties === false)).toBe(true);
  });

  it('returns standard JSON-RPC errors for malformed payloads and methods', async () => {
    const invalidJson = await handleSiteMcpRequest(
      new Request('https://erp.example/mcp', { method: 'POST', body: '{' }),
      {},
    );
    expect(await invalidJson.json()).toMatchObject({
      jsonrpc: '2.0', id: null, error: { code: -32700 },
    });

    const unknown = await rpc('resources/list');
    expect(await unknown.json()).toMatchObject({
      jsonrpc: '2.0', id: 1, error: { code: -32601 },
    });
  });

  it('requires Sites verified identity for the read tool', async () => {
    const response = await toolCall('get_procurement_freshness', {}, {}, undefined, {
      ensureDatabase: vi.fn(),
    });
    expect(await toolPayload(response)).toMatchObject({
      result: {
        isError: true,
        structuredContent: { ok: false, code: 'AUTHENTICATED_USER_REQUIRED' },
      },
    });
  });

  it('rejects any tool arguments instead of accepting tenant, URL or credentials', async () => {
    const ensureDatabase = vi.fn();
    const response = await toolCall(
      'refresh_procurement_sources',
      { tenantId: 'tenant-private', url: 'https://attacker.invalid', token: 'secret' },
      { DB: {} as D1Database, ERP_AUTOMATION_ALLOWED_EMAILS: 'owner@example.com' },
      'owner@example.com',
      { ensureDatabase },
    );
    expect(await response.json()).toMatchObject({ error: { code: -32602 } });
    expect(ensureDatabase).not.toHaveBeenCalled();
  });
});

describe('Sites procurement MCP automation authorization', () => {
  it('fails closed without an explicit allowlist even when development access is open', async () => {
    const ensureDatabase = vi.fn();
    const response = await toolCall(
      'refresh_procurement_sources',
      {},
      { DB: {} as D1Database, ERP_DEV_OPEN_ACCESS: 'true' },
      'owner@example.com',
      { ensureDatabase },
    );
    expect(await toolPayload(response)).toMatchObject({
      result: {
        isError: true,
        structuredContent: { ok: false, code: 'AUTOMATION_ALLOWLIST_NOT_CONFIGURED' },
      },
    });
    expect(ensureDatabase).not.toHaveBeenCalled();
  });

  it('requires an exact normalized email match and never exposes the allowlist', async () => {
    const ensureDatabase = vi.fn();
    const runtimeEnv = {
      DB: {} as D1Database,
      ERP_DEV_OPEN_ACCESS: 'true',
      ERP_AUTOMATION_ALLOWED_EMAILS: 'owner@example.com, ops@example.com',
    };
    const response = await toolCall(
      'refresh_procurement_sources',
      {},
      runtimeEnv,
      'outsider@example.com',
      { ensureDatabase },
    );
    const payload = await toolPayload(response);
    expect(payload).toMatchObject({
      result: {
        isError: true,
        structuredContent: { ok: false, code: 'AUTOMATION_CALLER_NOT_ALLOWED' },
      },
    });
    expect(JSON.stringify(payload)).not.toContain('owner@example.com');
    expect(JSON.stringify(payload)).not.toContain('ops@example.com');
    expect(ensureDatabase).not.toHaveBeenCalled();
  });

  it('normalizes comma, semicolon and whitespace separated non-secret allowlists', () => {
    expect([...parseAutomationAllowedEmails(
      ' Owner@Example.com;ops@example.com\ninvalid  owner@example.com ',
    )]).toEqual(['owner@example.com', 'ops@example.com']);
  });
});

describe('Sites procurement MCP tool behavior', () => {
  it('excludes LOCAL QA stores without letting them drag down or fake official readiness', () => {
    const checkedAt = '2026-11-02T10:00:00.000Z';
    const officialAndLocal = summarizeShopifyOrderSources([
      shopifySource({ connector_key: 'bizfurniz', credential_ref: 'd1:shopify:bizfurniz' }),
      shopifySource({
        connector_key: 'local_qa',
        credential_ref: 'local:qa',
        identity_verified_at: 'invalid',
        last_successful_sync_at: '2099-01-01T00:00:00.000Z',
        sync_status: 'failed',
      }),
    ], checkedAt, 30);
    expect(officialAndLocal).toMatchObject({
      status: 'fresh',
      readyForProcurement: true,
      storesDiscovered: 2,
      storesConfigured: 1,
      excludedLocalStores: 1,
      freshStores: 1,
      staleStores: 0,
      failedStores: 0,
      blockerCodes: {},
    });

    const onlyLocal = summarizeShopifyOrderSources([
      shopifySource({ connector_key: 'local_qa', credential_ref: 'local:qa' }),
    ], checkedAt, 30);
    expect(onlyLocal).toMatchObject({
      status: 'missing',
      readyForProcurement: false,
      storesConfigured: 0,
      excludedLocalStores: 1,
      blockerCodes: { no_official_order_source: 1 },
    });
  });

  it('blocks and reports official stores with a future success time or invalid identity proof', () => {
    const checkedAt = '2026-11-02T10:00:00.000Z';
    const future = summarizeShopifyOrderSources([
      shopifySource({ last_successful_sync_at: '2026-11-02T10:00:01.000Z' }),
    ], checkedAt, 30);
    expect(future).toMatchObject({
      status: 'stale',
      readyForProcurement: false,
      storesConfigured: 1,
      freshStores: 0,
      staleStores: 1,
      blockerCodes: { order_sync_time_in_future: 1 },
    });

    const invalidIdentity = summarizeShopifyOrderSources([
      shopifySource({ identity_verified_at: 'not-a-time' }),
    ], checkedAt, 30);
    expect(invalidIdentity).toMatchObject({
      readyForProcurement: false,
      verifiedOfficialStores: 0,
      blockerCodes: { identity_verification_invalid: 1 },
    });
  });

  it('reads freshness without returning tenant IDs, credentials or order data', async () => {
    const dependencies = {
      ensureDatabase: vi.fn(async () => {}),
      listTenants: vi.fn(async () => [{ id: 'tenant-private', name: 'MUKU' }]),
      readTenantFreshness: vi.fn(async () => safeFreshness('MUKU')),
    };
    const response = await toolCall(
      'get_procurement_freshness',
      {},
      { DB: {} as D1Database },
      'viewer@example.com',
      dependencies,
    );
    const payload = await toolPayload(response);
    expect(payload).toMatchObject({
      result: {
        structuredContent: {
          ok: true,
          tenantsChecked: 1,
          readyTenants: 1,
          blockedTenants: 0,
        },
      },
    });
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain('tenant-private');
    expect(serialized).not.toContain('accessToken');
    expect(serialized).not.toContain('customer');
  });

  it('refreshes at most 20 DB tenants and passes only server-derived scope to Shopify', async () => {
    const tenants = Array.from({ length: 25 }, (_, index) => ({
      id: `tenant-${index + 1}`,
      name: `Tenant ${index + 1}`,
    }));
    const refreshMuku = vi.fn(async () => ({
      ok: true,
      attempted: false,
      skipReason: 'not_due',
      before: mukuFreshness(),
    }));
    const reconcileShopify = vi.fn(async (input: Record<string, unknown>) => {
      void input;
      return {
        ok: true,
        storesChecked: 1,
        synced: [{
          storeKey: 'bizfurniz',
          pagesCompleted: 2,
          ordersSeen: 9,
          ordersInserted: 0,
          ordersUpdated: 1,
          ordersUnchanged: 8,
          completedAt: '2026-11-02T10:00:00.000Z',
        }],
        skipped: [],
        failed: [],
      };
    });
    const dependencies = {
      ensureDatabase: vi.fn(async () => {}),
      listTenants: vi.fn(async () => tenants),
      createMukuClient: vi.fn(() => ({ verifyManifest: vi.fn(), getAllPages: vi.fn() })),
      refreshMuku,
      reconcileShopify,
      readTenantFreshness: vi.fn(async ({ tenant }: { tenant: { name: string } }) => (
        safeFreshness(tenant.name)
      )),
    };
    const response = await toolCall(
      'refresh_procurement_sources',
      {},
      {
        DB: {} as D1Database,
        ERP_DEV_OPEN_ACCESS: 'true',
        ERP_AUTOMATION_ALLOWED_EMAILS: 'owner@example.com',
      },
      'OWNER@example.com',
      dependencies,
    );
    const payload = await toolPayload(response);
    expect(payload).toMatchObject({
      result: {
        structuredContent: {
          ok: true,
          tenantLimit: SITE_MCP_TENANT_LIMIT,
          tenantsChecked: SITE_MCP_TENANT_LIMIT,
          muku: { tenantsChecked: SITE_MCP_TENANT_LIMIT, attempted: 0, skipped: SITE_MCP_TENANT_LIMIT },
          shopify: {
            storesChecked: 1,
            ordersSeen: 9,
            ordersUpdated: 1,
            ordersUnchanged: 8,
          },
        },
      },
    });
    expect(refreshMuku).toHaveBeenCalledTimes(SITE_MCP_TENANT_LIMIT);
    expect(reconcileShopify).toHaveBeenCalledWith(expect.objectContaining({
      requestUrl: 'https://erp.example',
      tenantIds: tenants.slice(0, SITE_MCP_TENANT_LIMIT).map((tenant) => tenant.id),
      maxPages: 20,
    }));
    const input = reconcileShopify.mock.calls[0][0] as Record<string, unknown>;
    expect(input).not.toHaveProperty('storeKeys');
    expect(input).not.toHaveProperty('credentials');
  });
});

function rpc(method: string, params?: unknown) {
  return handleSiteMcpRequest(new Request('https://erp.example/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params === undefined ? {} : { params }) }),
  }), {});
}

function toolCall(
  name: string,
  args: Record<string, unknown>,
  runtimeEnv: Record<string, unknown> & { DB?: D1Database },
  email: string | undefined,
  dependencies: Record<string, unknown>,
) {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (email) headers.set('oai-authenticated-user-email', email);
  return handleSiteMcpRequest(new Request('https://erp.example/mcp', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  }), runtimeEnv, dependencies as never);
}

async function toolPayload(response: Response) {
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  return response.json() as Promise<Record<string, unknown>>;
}

function safeFreshness(tenantName: string) {
  return {
    tenantName,
    readyForProcurement: true,
    muku: {
      status: 'fresh',
      readyForProcurement: true,
      checkedAt: '2026-11-02T10:00:00.000Z',
      maxAgeMinutes: 30,
      needsRefresh: false,
      refreshDue: false,
      refreshInProgress: false,
      nextRefreshAt: '2026-11-02T10:10:00.000Z',
      datasets: [],
    },
    shopify: {
      status: 'fresh',
      readyForProcurement: true,
      maxAgeMinutes: 30,
      storesDiscovered: 1,
      storesConfigured: 1,
      excludedLocalStores: 0,
      verifiedOfficialStores: 1,
      freshStores: 1,
      staleStores: 0,
      failedStores: 0,
      latestSuccessfulSyncAt: '2026-11-02T10:00:00.000Z',
      sourceLimitReached: false,
      blockerCodes: {},
    },
  };
}

function shopifySource(overrides: Partial<{
  connector_key: string;
  credential_ref: string;
  identity_verified_at: string | null;
  last_successful_sync_at: string | null;
  sync_status: string | null;
  sync_last_success_at: string | null;
}> = {}) {
  return {
    connector_key: 'bizfurniz',
    credential_ref: 'd1:shopify:bizfurniz',
    identity_verified_at: '2026-11-02T09:00:00.000Z',
    last_successful_sync_at: '2026-11-02T09:50:00.000Z',
    sync_status: 'idle',
    sync_last_success_at: null,
    ...overrides,
  };
}

function mukuFreshness() {
  return {
    checkedAt: '2026-11-02T10:00:00.000Z',
    status: 'fresh' as const,
    readyForProcurement: true,
    maxAgeMinutes: 30,
    minRefreshIntervalMinutes: 10,
    datasets: [],
    blockingReasons: [],
    needsRefresh: false,
    refreshDue: false,
    refreshInProgress: false,
    lastAttemptAt: '2026-11-02T10:00:00.000Z',
    nextRefreshAt: '2026-11-02T10:10:00.000Z',
  };
}
