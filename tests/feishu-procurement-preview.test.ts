import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET, POST } from '../app/api/purchase/feishu-preview/route';
import { POST as POST_SYNC } from '../app/api/purchase/feishu-preview/sync/route';
import { POST as POST_WORKER } from '../app/api/purchase/feishu-preview/worker/route';
import { openSqliteD1 } from '../lib/aws/sqlite-d1';
import { HttpError } from '../lib/db';
import { ROLE_PERMISSIONS, type Role } from '../lib/domain';
import { FEISHU_PROCUREMENT_PREVIEW_MAX_BYTES } from '../lib/feishu-procurement-preview-contract';
import { FEISHU_SYNC_TENANT_ID } from '../lib/feishu-procurement-sync';

const { requestContext, runtime } = vi.hoisted(() => ({
  requestContext: vi.fn(),
  runtime: {} as Record<string, unknown>,
}));

vi.mock('cloudflare:workers', () => ({ env: runtime }));
vi.mock('../lib/db', async (original) => ({
  ...await original<typeof import('../lib/db')>(),
  requestContext,
}));

const snapshot = {
  snapshotDate: '2026-11-24',
  salesStart: '2026-10-25',
  salesEnd: '2026-11-23',
  skus: [{
    sku: 'PREVIEW-01', verifiedSales: 10, otherSales: null, storeCount: 1,
    ca: null, ga: 0, nj: 2, stockTotal: 2, warehouseCount: 2,
    transitPcs: null, status: '待核',
  }],
  storeSales: [{
    sku: 'PREVIEW-01', platform: 'Amazon', store: '试运行店铺', verifiedSales: 10,
    otherSales: null, trustedDays: 30, averagePerDay: 0.33,
  }],
  transit: [],
  review: [],
};

const endpoint = 'https://example.test/api/purchase/feishu-preview';
const origin = 'http://localhost:3000';
const localEndpoint = `${origin}/api/purchase/feishu-preview`;
const testToken = 'local-sync-worker-token-for-test-only';

function get() {
  return GET(new Request(endpoint));
}

function post(body: unknown, headers: Record<string, string> = {}) {
  return POST(new Request(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }));
}

function trigger(requestOrigin = origin, body?: string) {
  return POST_SYNC(new Request(`${localEndpoint}/sync`, {
    method: 'POST',
    headers: { Origin: requestOrigin },
    body,
  }));
}

function worker(body: unknown, token = testToken, baseUrl = localEndpoint, headers: Record<string, string> = {}) {
  return POST_WORKER(new Request(`${baseUrl}/worker`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...headers },
    body: JSON.stringify(body),
  }));
}

async function claimJob() {
  const response = await worker({ action: 'claim' });
  expect(response.status).toBe(200);
  return await response.json() as { ok: true; claim: { id: string } | null };
}

async function expectJob() {
  const { claim } = await claimJob();
  expect(claim).not.toBeNull();
  return claim?.id;
}

describe('广州采购预览快照', () => {
  let sqlite: ReturnType<typeof openSqliteD1>;

  function signIn(role: Role, tenantId = 'guangzhou', canRead = true) {
    requestContext.mockResolvedValue({
      db: sqlite.db,
      user: {
        id: `user-${role}`,
        role,
        tenantId,
        permissions: canRead ? ROLE_PERMISSIONS[role] : [],
      },
    });
  }

  beforeEach(async () => {
    requestContext.mockReset();
    for (const key of Object.keys(runtime)) delete runtime[key];
    sqlite = openSqliteD1(':memory:', resolve('drizzle'));
    await sqlite.db.prepare(`
      INSERT INTO tenants (id, name, created_at)
      VALUES ('guangzhou', '广州', '2026-11-25'), ('shenzhen', '深圳', '2026-11-25'),
             (?, '广州本地', '2026-11-25')
    `).bind(FEISHU_SYNC_TENANT_ID).run();
  });

  afterEach(() => {
    vi.useRealTimers();
    sqlite.close();
  });

  function enableSync() {
    Object.assign(runtime, {
      DB: sqlite.db,
      ERP_FEISHU_MODE: 'continuous',
      ERP_FEISHU_SYNC_ENABLED: 'true',
      ERP_FEISHU_SYNC_WORKER_TOKEN: testToken,
    });
  }

  it('仅向当前工作区有采购读取权限的成员返回快照', async () => {
    requestContext.mockRejectedValueOnce(new HttpError(401, '请先登录', 'AUTH_REQUIRED'));
    const anonymous = await get();
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await anonymous.json()).not.toHaveProperty('snapshot');

    signIn('admin');
    expect((await post(snapshot)).status).toBe(201);

    signIn('viewer', 'guangzhou', false);
    expect((await get()).status).toBe(403);
    signIn('viewer', 'shenzhen');
    expect(await (await get()).json()).toEqual({ ok: true, snapshot: null, sync: null });

    signIn('viewer');
    const response = await get();
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await response.json()).toEqual({ ok: true, snapshot, sync: null });
  });

  it('仅允许管理员导入，拒绝无效内容并保留已保存的快照', async () => {
    signIn('admin');
    expect((await post(snapshot)).status).toBe(201);

    signIn('operator');
    expect((await post(snapshot)).status).toBe(403);
    signIn('admin');
    expect((await post(snapshot, { 'Content-Type': 'text/plain' })).status).toBe(415);
    expect((await post(snapshot, {
      'Content-Length': String(FEISHU_PROCUREMENT_PREVIEW_MAX_BYTES + 1),
    })).status).toBe(413);
    expect((await post({ ...snapshot, salesEnd: '2026-11-25' })).status).toBe(400);
    expect((await post({
      ...snapshot,
      skus: [snapshot.skus[0], { ...snapshot.skus[0], sku: 'preview-01' }],
    })).status).toBe(400);
    expect(await (await get()).json()).toEqual({ ok: true, snapshot, sync: null });
  });

  it('同内容重试去重，旧批次不会替换最新快照', async () => {
    signIn('admin');
    expect(await (await post(snapshot)).json()).toMatchObject({ ok: true, replayed: false });
    const revised = { ...snapshot, skus: [{ ...snapshot.skus[0], verifiedSales: 12 }] };
    expect((await post(revised)).status).toBe(201);
    const { review, ...data } = snapshot;
    const replay = await post({ review, ...data });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ ok: true, replayed: true });
    expect((await post({ ...snapshot, snapshotDate: '2026-11-23' })).status).toBe(201);
    expect(await (await get()).json()).toEqual({ ok: true, snapshot: revised, sync: null });
    expect(await sqlite.db.prepare('SELECT COUNT(*) AS total FROM feishu_procurement_previews')
      .first('total')).toBe(3);
  });

  it('本地管理员同源触发，任务令牌只供本地工作进程使用', async () => {
    signIn('admin', FEISHU_SYNC_TENANT_ID);
    expect((await trigger()).status).toBe(503);
    enableSync();
    const getLocal = async () => (await GET(new Request(localEndpoint))).json();
    expect(await getLocal()).toMatchObject({
      sync: { enabled: true, status: 'idle', canTrigger: true, lastSuccessAt: null },
    });
    expect((await trigger('http://127.0.0.1:3000')).status).toBe(403);
    expect((await trigger(origin, '{}')).status).toBe(400);
    signIn('viewer', FEISHU_SYNC_TENANT_ID);
    expect((await trigger()).status).toBe(403);
    expect(await getLocal()).toMatchObject({ sync: { canTrigger: false } });
    signIn('admin', 'shenzhen');
    expect(await getLocal()).toMatchObject({ sync: null });
    expect((await trigger()).status).toBe(403);
    signIn('admin', FEISHU_SYNC_TENANT_ID);
    expect((await worker({ action: 'claim' }, 'wrong-token')).status).toBe(401);
    expect((await worker({ action: 'claim' }, testToken, endpoint)).status).toBe(503);
    expect((await trigger()).status).toBe(202);
    expect((await trigger()).status).toBe(409);
    expect(await getLocal()).toMatchObject({ sync: { status: 'running', canTrigger: true, lastAttemptAt: null } });
    runtime.ERP_HOST_RUNTIME = 'aws';
    expect(await getLocal()).toMatchObject({ sync: null });
    expect((await worker({ action: 'claim' })).status).toBe(503);
  });

  it('期初模式保留已导入资料，旧令牌和开关无法启动定时采集', async () => {
    signIn('admin', FEISHU_SYNC_TENANT_ID);
    enableSync();
    runtime.ERP_FEISHU_MODE = 'opening';
    expect((await post(snapshot)).status).toBe(201);
    expect((await trigger()).status).toBe(503);
    expect((await worker({ action: 'claim' })).status).toBe(503);
    expect(await (await GET(new Request(localEndpoint))).json()).toEqual({ ok: true, snapshot, sync: null });
  });

  it('AWS 必须单独启用，公开同源管理员与环回工作进程使用各自的授权', async () => {
    enableSync();
    Object.assign(runtime, {
      ERP_HOST_RUNTIME: 'aws',
      ERP_PUBLIC_ORIGIN: 'https://example.test',
      HOST: '127.0.0.1',
      PORT: '3000',
    });
    const proxiedUrl = endpoint.replace('https:', 'http:');
    const awsLoopback = localEndpoint.replace('localhost', '127.0.0.1');
    const awsTrigger = (requestOrigin: string, url = proxiedUrl) => POST_SYNC(new Request(`${url}/sync`, {
      method: 'POST', headers: { Origin: requestOrigin },
    }));
    const getAws = async () => (await GET(new Request(proxiedUrl))).json();
    signIn('admin', FEISHU_SYNC_TENANT_ID);
    expect(await getAws()).toEqual({ ok: true, snapshot: null, sync: null });
    expect((await awsTrigger('https://example.test')).status).toBe(503);
    expect((await worker({ action: 'claim' }, testToken, awsLoopback)).status).toBe(503);
    runtime.ERP_FEISHU_SYNC_AWS_ENABLED = 'true';
    expect(await getAws()).toMatchObject({ sync: { enabled: true, status: 'idle', canTrigger: true } });
    signIn('viewer', FEISHU_SYNC_TENANT_ID);
    expect(await getAws()).toMatchObject({ sync: { enabled: true, canTrigger: false } });
    expect((await awsTrigger('https://example.test')).status).toBe(403);
    signIn('admin', FEISHU_SYNC_TENANT_ID);
    expect((await awsTrigger('http://example.test')).status).toBe(403);
    expect((await awsTrigger('https://example.test', awsLoopback)).status).toBe(503);
    expect((await worker({ action: 'claim' }, testToken, endpoint)).status).toBe(503);
    expect((await worker({ action: 'claim' }, testToken, localEndpoint)).status).toBe(503);
    expect((await worker({ action: 'claim' }, testToken, awsLoopback.replace('3000', '3001'))).status).toBe(503);
    expect((await worker({ action: 'claim' }, testToken, awsLoopback, { 'X-Forwarded-Proto': 'https' })).status).toBe(503);
    expect((await worker({ action: 'claim' }, testToken, awsLoopback, { Origin: 'https://example.test' })).status).toBe(503);
    expect((await worker({ action: 'claim' }, 'wrong-token', awsLoopback)).status).toBe(401);
    expect((await awsTrigger('https://example.test')).status).toBe(202);
    const response = await worker({ action: 'claim' }, testToken, awsLoopback);
    expect(response.status).toBe(200);
    const { claim } = await response.json() as { claim: { id: string } };
    expect(claim.id).toEqual(expect.any(String));
    expect((await worker({ action: 'complete', id: claim.id, snapshot }, testToken, awsLoopback)).status).toBe(200);
    expect(await getAws()).toMatchObject({ snapshot, sync: { status: 'success' } });
    runtime.HOST = '0.0.0.0';
    expect(await getAws()).toEqual({ ok: true, snapshot, sync: null });
    expect((await worker({ action: 'claim' }, testToken, awsLoopback)).status).toBe(503);
  });

  it('领取租约等待五分钟，过期任务不能替换最后有效快照，失败信息不泄漏', async () => {
    enableSync();
    signIn('admin', FEISHU_SYNC_TENANT_ID);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-25T02:00:00.000Z'));
    const getLocal = async () => (await GET(new Request(localEndpoint))).json();
    const claims = await Promise.all([claimJob(), claimJob()]);
    expect(claims.filter(({ claim }) => claim)).toHaveLength(1);
    const firstId = claims.find(({ claim }) => claim)?.claim?.id;
    expect((await trigger()).status).toBe(409);
    expect((await worker({ action: 'complete', id: firstId, snapshot: { ...snapshot, salesEnd: '2026-11-28' } })).status).toBe(400);
    expect(await (await worker({ action: 'complete', id: firstId, snapshot })).json()).toEqual({ ok: true, replayed: false });
    expect(await getLocal()).toEqual({
      ok: true,
      snapshot,
      sync: {
        enabled: true, status: 'success', canTrigger: true, error: null,
        lastAttemptAt: '2026-11-25T02:00:00.000Z', lastSuccessAt: '2026-11-25T02:00:00.000Z',
        snapshotImportedAt: '2026-11-25T02:00:00.000Z',
      },
    });

    vi.setSystemTime(new Date('2026-11-25T02:04:59.999Z'));
    expect(await claimJob()).toEqual({ ok: true, claim: null });
    vi.setSystemTime(new Date('2026-11-25T02:05:00.000Z'));
    const expiredId = await expectJob();
    vi.setSystemTime(new Date('2026-11-25T02:09:30.000Z'));
    expect(await getLocal()).toMatchObject({ snapshot, sync: { status: 'failed', error: '同步超时' } });
    expect((await worker({ action: 'complete', id: expiredId, snapshot })).status).toBe(409);
    expect((await trigger()).status).toBe(202);
    const nextId = await expectJob();
    expect((await worker({ action: 'fail', id: expiredId, error: 'WORKER_STOPPED' })).status).toBe(409);
    expect((await worker({ action: 'fail', id: nextId, error: 'raw cli output' })).status).toBe(400);
    expect((await worker({ action: 'fail', id: nextId, error: 'SOURCE_FAILED' })).status).toBe(200);
    expect(await getLocal()).toMatchObject({
      snapshot,
      sync: { status: 'failed', error: '读取飞书数据失败', lastSuccessAt: '2026-11-25T02:00:00.000Z' },
    });
    expect((await trigger()).status).toBe(202);
    const retryId = await expectJob();
    expect(await (await worker({ action: 'complete', id: retryId, snapshot })).json()).toEqual({ ok: true, replayed: true });
    expect(await sqlite.db.prepare('SELECT COUNT(*) AS total FROM feishu_procurement_previews')
      .first('total')).toBe(1);
  });
});
