import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from '../app/api/connectors/wayfair/preview/route';
import { GET } from '../app/api/connectors/wayfair/status/route';
import type { WayfairOrderPreview } from '../lib/connectors/wayfair/order-preview';
import { HttpError, type UserContext } from '../lib/db';
import { ROLE_PERMISSIONS } from '../lib/domain';

const fixtures = vi.hoisted(() => ({
  env: {} as Record<string, string>,
  requestContext: vi.fn(),
  fetch: vi.fn<typeof globalThis.fetch>(),
  now: Date.parse('2026-11-25T19:00:00Z'),
}));

vi.mock('cloudflare:workers', () => ({ env: fixtures.env }));
vi.mock('../lib/db', async (original) => ({ ...await original<typeof import('../lib/db')>(), requestContext: fixtures.requestContext }));
vi.mock('../lib/connectors/wayfair/order-preview', async (original) => {
  const actual = await original<typeof import('../lib/connectors/wayfair/order-preview')>();
  return { ...actual, previewWayfairOrders: vi.fn((config, input) => actual.previewWayfairOrders(config, input, {
    now: () => fixtures.now, fetch: fixtures.fetch, sleep: async () => {},
  })) };
});

const tenantId = 'tenant-test-guangzhou';
const administrator: UserContext = {
  id: 'fixture-admin', email: 'fixture-admin@example.invalid', displayName: '测试管理员',
  role: 'admin', permissions: ROLE_PERMISSIONS.admin, tenantId, tenantName: '隔离测试工作区',
};
const configuration = {
  ERP_WAYFAIR_LINHE_TENANT_ID: tenantId,
  ERP_WAYFAIR_LINHE_ENVIRONMENT: 'production',
  ERP_WAYFAIR_LINHE_SUPPLIER_IDS: '4242, 4243',
  ERP_WAYFAIR_LINHE_CLIENT_ID: 'fixture-private-client',
  ERP_WAYFAIR_LINHE_CLIENT_SECRET: 'fixture-private-secret',
  ERP_WAYFAIR_LINHE_VERIFY_PO_NUMBER: 'PO-PRIVATE-ANCHOR',
  ERP_WAYFAIR_LINHE_VERIFY_HAS_RESPONSE: 'true',
  ERP_ALLOWED_EMAILS: administrator.email,
};

function signIn(user = administrator) {
  fixtures.requestContext.mockResolvedValue({ user,
    db: { prepare: () => { throw new Error('This preview must not access order storage'); } } });
}

const origin = 'https://erp.example.invalid';
function status() {
  return GET(new Request(`${origin}/api/connectors/wayfair/status`));
}
function preview(body: object = { hasResponse: false }) {
  return POST(new Request(`${origin}/api/connectors/wayfair/preview`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
}

function wayfairOrder(id: number, supplierId = 4242, poNumber = `PO-FIXTURE-${id}`) {
  return { id, poNumber, supplierId, poDate: '2026-11-24 10:16:44.000000 -04:00', customerName: 'private-fixture-person',
    products: [{ partNumber: 'TEST-SUPPLIER-SKU', sku: 'WF-FIXTURE-SKU', name: 'Fixture Product', quantity: '3', price: 12, isCancelled: false }] };
}
const list = (...orders: object[]) => Response.json({ data: { getDropshipPurchaseOrders: orders } });
const token = () => Response.json({ access_token: 'fixture-private-token', token_type: 'Bearer', expires_in: 43_200 });

describe('Wayfair 林和订单只读预览路由', () => {
  beforeEach(() => {
    signIn();
    fixtures.fetch.mockReset();
  });
  afterEach(() => {
    for (const name of Object.keys(fixtures.env)) delete fixtures.env[name];
  });

  it('配置状态从不请求 Wayfair，缺失配置和其他工作区都不能打开预览', async () => {
    const unavailable = await status();
    expect(unavailable.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await unavailable.json()).toMatchObject({ ok: true, key: 'wayfair-linhe', configuration: 'unconfigured', environment: null });
    expect((await preview()).status).toBe(409);
    Object.assign(fixtures.env, configuration);
    const configured = await status();
    expect(await configured.json()).toEqual({ ok: true, key: 'wayfair-linhe', name: '林和', configuration: 'configured',
      environment: 'production', previewDays: 30, maxOrders: 25 });
    signIn({ ...administrator, tenantId: 'tenant-test-shenzhen' });
    expect(await (await status()).json()).toMatchObject({ configuration: 'unconfigured', environment: null });
    expect((await preview()).status).toBe(409);
    expect(fixtures.fetch).not.toHaveBeenCalled();
  });

  it('检查已登录成员、接入权限、生产精确邮箱访问名单以及配置和请求格式', async () => {
    Object.assign(fixtures.env, configuration);
    fixtures.requestContext.mockRejectedValueOnce(new HttpError(401, '请登录', 'AUTH_REQUIRED'));
    expect((await status()).status).toBe(401);
    signIn({ ...administrator, role: 'viewer', permissions: ['orders:read', 'connectors:read'] });
    expect((await status()).status).toBe(200);
    expect((await preview()).status).toBe(403);
    signIn({ ...administrator, permissions: ['channels:read'], channelScope: 'wayfair' });
    expect((await status()).status).toBe(403);
    expect((await preview()).status).toBe(403);
    signIn({ ...administrator, email: 'someone-else@example.invalid' });
    const denied = await preview();
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ code: 'ERP_SYNC_OPERATOR_EMAIL_REQUIRED' });
    signIn();
    expect((await preview({ hasResponse: false, poNumbers: ['unbounded-selection'] })).status).toBe(400);
    fixtures.env.ERP_WAYFAIR_LINHE_SUPPLIER_IDS = '4242,4242';
    expect(await (await status()).json()).toMatchObject({ configuration: 'invalid', environment: null });
    expect((await preview()).status).toBe(409);
    expect(fixtures.fetch).not.toHaveBeenCalled();
  });

  it('核验后只返回近30天有界结果，标明上限且隐藏授权数据、锚点和非必要字段', async () => {
    Object.assign(fixtures.env, configuration);
    const rows = Array.from({ length: 25 }, (_, index) => wayfairOrder(index + 1, 4243));
    fixtures.fetch.mockResolvedValueOnce(token()).mockResolvedValueOnce(list(wayfairOrder(40, 4242, 'PO-PRIVATE-ANCHOR')))
      .mockResolvedValueOnce(list(...rows));
    const response = await preview({ hasResponse: true });
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    const body = await response.json() as WayfairOrderPreview & { ok: boolean };
    expect(body).toMatchObject({ ok: true, hasResponse: true, possiblyTruncated: true, fromDay: '2026-10-28', environment: 'production',
      readAt: '2026-11-25T19:00:00.000Z' });
    expect(body.orders).toHaveLength(25);
    expect(body.orders[0]).toEqual({ poNumber: 'PO-FIXTURE-1', createdAt: '2026-11-24T14:16:44.000Z',
      lines: [{ supplierSku: 'TEST-SUPPLIER-SKU', wayfairSku: 'WF-FIXTURE-SKU', title: 'Fixture Product', quantity: 3, cancelled: false }] });
    expect(JSON.stringify(body)).not.toMatch(/4242|4243|fixture-private|PO-PRIVATE-ANCHOR|private-fixture-person|price/u);
    const anchorRequest = JSON.parse(String(fixtures.fetch.mock.calls[1][1]?.body));
    expect(anchorRequest.variables).toMatchObject({ limit: 25, hasResponse: true, poNumbers: ['PO-PRIVATE-ANCHOR'] });
    const previewRequest = JSON.parse(String(fixtures.fetch.mock.calls[2][1]?.body));
    expect(previewRequest.variables).toEqual({ limit: 25, hasResponse: true, fromDate: '2026-10-27 16:00:00.000000 +00:00' });
  });

  it('核验错误时不读取订单范围，并发预览只执行一轮且允许失败后重新核验', async () => {
    Object.assign(fixtures.env, configuration);
    let allowOAuth!: (value: Response) => void;
    let started!: () => void;
    const hasStarted = new Promise<void>((resolve) => { started = resolve; });
    fixtures.fetch.mockImplementationOnce(() => {
      started();
      return new Promise((resolve) => { allowOAuth = resolve; });
    }).mockResolvedValueOnce(list(wayfairOrder(40, 9999, 'PO-PRIVATE-ANCHOR')));
    const first = preview();
    await hasStarted;
    expect((await preview()).status).toBe(429);
    allowOAuth(token());
    const failed = await first;
    expect(failed.status).toBe(409);
    expect(await failed.json()).toMatchObject({ code: 'WAYFAIR_SUPPLIER_MISMATCH' });
    expect(fixtures.fetch).toHaveBeenCalledTimes(2);
    fixtures.fetch.mockResolvedValueOnce(token()).mockResolvedValueOnce(list(wayfairOrder(40, 4242, 'PO-PRIVATE-ANCHOR')))
      .mockResolvedValueOnce(list());
    expect(await (await preview()).json()).toMatchObject({ ok: true, possiblyTruncated: false, orders: [] });
    expect(fixtures.fetch).toHaveBeenCalledTimes(5);
  });
});
