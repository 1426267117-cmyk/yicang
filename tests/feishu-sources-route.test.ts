import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from '../app/api/feishu-sources/route';
import { HttpError } from '../lib/db';

const { requestContext, runtime } = vi.hoisted(() => ({
  requestContext: vi.fn(),
  runtime: {} as Record<string, unknown>,
}));
vi.mock('cloudflare:workers', () => ({ env: runtime }));
vi.mock('../lib/db', async (original) => ({
  ...await original<typeof import('../lib/db')>(),
  requestContext,
}));

const localOrigin = 'http://127.0.0.1:3000';
const endPoint = `${localOrigin}/api/feishu-sources`;
const testToken = 'mock-feishu-worker-token-for-tests-only';
const fetchBridge = vi.fn();
const entry = {
  id: 'sales', title: '九店销量', type: 'sheet', usage: '采购', status: 'ready',
  checkedAt: '2026-11-25T12:00:00.000Z', tables: [{ id: 'metadata_01', title: '核对', hidden: false, preview: true }],
};
const preview = {
  sourceId: 'sales', tableId: 'metadata_01', title: '核对', readAt: '2026-11-25T12:00:00.000Z',
  columns: ['SKU', '销量'], rows: [['TEST-001', 0]], hasMore: false,
};

function get(query = '', origin = endPoint) {
  return GET(new Request(`${origin}${query}`, { headers: { Cookie: 'private-app-session=stub' } }));
}

describe('本机飞书来源只读接入', () => {
  beforeEach(() => {
    Object.assign(runtime, {
      ERP_FEISHU_MODE: 'continuous',
      ERP_FEISHU_SOURCES_LOCAL_ENABLED: 'true', ERP_FEISHU_SOURCES_LOCAL_ORIGIN: localOrigin,
      ERP_FEISHU_SYNC_WORKER_TOKEN: testToken,
    });
    delete runtime.ERP_HOST_RUNTIME;
    requestContext.mockReset();
    requestContext.mockResolvedValue({ user: { permissions: ['purchase:read'] } });
    fetchBridge.mockReset();
    vi.stubGlobal('fetch', fetchBridge);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('未登录、无采购权限及 AWS 请求不触达内网桥接', async () => {
    requestContext.mockRejectedValueOnce(new HttpError(401, '请先登录', 'AUTH_REQUIRED'));
    expect((await get()).status).toBe(401);
    requestContext.mockResolvedValueOnce({ user: { permissions: [] } });
    expect((await get()).status).toBe(403);
    expect((await get('', 'https://127.0.0.1:3000/api/feishu-sources')).status).toBe(503);
    expect((await get('', 'http://127.0.0.1:3001/api/feishu-sources')).status).toBe(503);
    expect((await get('', 'http://example.test/api/feishu-sources')).status).toBe(503);
    runtime.ERP_HOST_RUNTIME = 'aws';
    expect((await get()).status).toBe(503);
    delete runtime.ERP_HOST_RUNTIME;
    delete runtime.ERP_FEISHU_MODE;
    expect((await get()).status).toBe(503);
    expect(fetchBridge).not.toHaveBeenCalled();
  });

  it('向同环回站点传入专用令牌但不转发浏览器请求头，目录响应过滤额外字段', async () => {
    fetchBridge.mockImplementationOnce(async () => Response.json({
      ok: true, sources: [{ ...entry, privateDebug: 'ignored' }], unexpected: 'ignored',
    }));
    const response = await get();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toEqual({ ok: true, sources: [entry] });
    const [url, init] = fetchBridge.mock.calls[0];
    expect(String(url)).toBe(`${localOrigin}/__local/feishu-sources`);
    expect(init).toMatchObject({
      method: 'GET', redirect: 'manual',
      headers: { Accept: 'application/json', Authorization: `Bearer ${testToken}`, 'Cache-Control': 'no-store' },
    });
    expect(Object.keys(init.headers)).toHaveLength(3);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    '?source=sales', '?table=metadata_01', '?source=sales&table=x&limit=25',
    '?source=sales&table=x&table=y', '?source=x&source=y', '?source=sales&table=%2Fetc%2Fpasswd',
  ])('不接受未配对或超出预览契约的参数 %s', async (query) => {
    expect((await get(query)).status).toBe(400);
    expect(fetchBridge).not.toHaveBeenCalled();
  });

  it('校验匹配来源与子表的有限预览，并保留受控上游错误', async () => {
    fetchBridge.mockImplementationOnce(async () => Response.json({ ok: true, preview }));
    const query = '?source=sales&table=metadata_01';
    expect(await (await get(query)).json()).toEqual({ ok: true, preview });
    expect(String(fetchBridge.mock.calls[0][0])).toBe(`${localOrigin}/__local/feishu-sources${query}`);

    fetchBridge.mockImplementationOnce(async () => Response.json({
      ok: true, preview: { ...preview, tableId: 'another' },
    }));
    expect((await get(query)).status).toBe(502);
    fetchBridge.mockImplementationOnce(async () => Response.json({
      ok: true, preview: { ...preview, rows: Array.from({ length: 26 }, () => ['TEST']) },
    }));
    expect((await get(query)).status).toBe(502);
    fetchBridge.mockImplementationOnce(async () => Response.json({
      ok: false, code: 'SOURCE_READ_DENIED', message: '此子表未开放预览', detail: 'ignored',
    }, { status: 403 }));
    const denied = await get(query);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ ok: false, code: 'SOURCE_READ_DENIED', message: '此子表未开放预览' });
  });
});
