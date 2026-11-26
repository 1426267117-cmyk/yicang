import { Miniflare } from 'miniflare';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runtimeEnv = vi.hoisted(() => ({} as Record<string, unknown>));

vi.mock('cloudflare:workers', () => ({ env: runtimeEnv }));
vi.mock('../db/initialize', () => ({ ensureDatabase: vi.fn(async () => undefined) }));

import {
  requestContext,
  requireProductionAccessPolicy,
} from '../lib/db';

const TENANT_ID = 'tenant_yicang_primary';

describe('ERP 请求访问边界', () => {
  let mf: Miniflare;
  let db: D1Database;

  beforeEach(async () => {
    for (const key of Object.keys(runtimeEnv)) delete runtimeEnv[key];
    mf = new Miniflare({
      modules: true,
      script: 'export default { fetch(){ return new Response("ok") } }',
      d1Databases: ['DB'],
    });
    db = await mf.getD1Database('DB');
    runtimeEnv.DB = db;
    await db.prepare(`
      CREATE TABLE tenants (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `).run();
    await db.prepare(`
      CREATE TABLE members (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        auth_user_id TEXT NOT NULL,
        email TEXT NOT NULL,
        display_name TEXT NOT NULL,
        role TEXT NOT NULL,
        access_profile TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (tenant_id) REFERENCES tenants(id)
      )
    `).run();
    await db.prepare('CREATE UNIQUE INDEX uq_members_auth_user ON members(auth_user_id)').run();
  });

  afterEach(async () => {
    await mf.dispose();
  });

  it('正式模式拒绝匿名请求', async () => {
    runtimeEnv.ERP_ALLOWED_EMAILS = 'owner@example.com';

    await expect(requestContext(erpRequest())).rejects.toMatchObject({
      status: 401,
      code: 'AUTH_REQUIRED',
    });
    expect(await memberCount()).toBe(0);
  });

  it('AWS 使用已验证身份，并拒绝外站提交业务操作', async () => {
    runtimeEnv.ERP_HOST_RUNTIME = 'aws';
    runtimeEnv.ERP_DEV_OPEN_ACCESS = 'true';
    runtimeEnv.ERP_ALLOWED_EMAILS = 'owner@example.com';
    runtimeEnv.ERP_PUBLIC_ORIGIN = 'https://erp.example.com';
    runtimeEnv.ERP_WORKSPACE_NAME = '广州易仓';
    runtimeEnv.verifyRequestIdentity = async () => null;
    await expect(requestContext(erpRequest('owner-id', 'owner@example.com'))).rejects.toMatchObject({
      status: 401, code: 'AUTH_REQUIRED',
    });

    runtimeEnv.verifyRequestIdentity = async () => ({
      id: 'alb-owner', email: 'owner@example.com', displayName: 'ERP 管理员',
    });
    const write = (origin: string) => new Request('https://erp.example.com/api/purchase/skus', {
      method: 'POST', headers: { origin },
    });
    await expect(requestContext(write('https://another.example.com'))).rejects.toMatchObject({
      status: 403, code: 'ERP_REQUEST_ORIGIN_NOT_ALLOWED',
    });
    expect(await memberCount()).toBe(0);
    await expect(requestContext(write('https://erp.example.com'))).resolves.toMatchObject({
      user: { id: 'alb-owner', role: 'admin', tenantName: '广州易仓' },
    });
  });

  it('飞书首次登录待授权，电邮相同也不会继承恢复管理员身份，岗位变更即时生效', async () => {
    runtimeEnv.ERP_HOST_RUNTIME = 'aws';
    runtimeEnv.ERP_ALLOWED_EMAILS = 'owner@example.com';
    const id = 'feishu:valid-test-subject';
    runtimeEnv.verifyRequestIdentity = async () => ({
      id, email: 'owner@example.com', displayName: '飞书员工', provider: 'feishu',
    });
    await expect(requestContext(erpRequest())).rejects.toMatchObject({ code: 'ERP_ADMIN_BOOTSTRAP_EMAIL_REQUIRED' });
    expect(await memberCount()).toBe(0);
    await seedMember('recovery-owner', 'owner@example.com', 'admin');
    expect((await requestContext(erpRequest())).user).toMatchObject({
      id, authProvider: 'feishu', role: 'viewer', accessProfile: 'pending', permissions: [], channelScope: null,
    });
    await db.prepare("UPDATE members SET access_profile = 'amazon' WHERE auth_user_id = ?").bind(id).run();
    expect((await requestContext(erpRequest())).user).toMatchObject({
      accessProfile: 'amazon', permissions: ['channels:read'], channelScope: 'amazon',
    });
    await db.prepare("UPDATE members SET access_profile = 'finance' WHERE auth_user_id = ?").bind(id).run();
    expect((await requestContext(erpRequest())).user).toMatchObject({
      accessProfile: 'finance', permissions: ['finance:read', 'finance:review', 'finance:write'], channelScope: null,
    });
    expect(await storedRole('recovery-owner')).toBe('admin');
  });

  it('开启飞书专用模式后保留负责人恢复入口，阻止旧登录员工访问', async () => {
    runtimeEnv.ERP_HOST_RUNTIME = 'aws';
    runtimeEnv.ERP_ALLOWED_EMAILS = 'owner@example.com,staff@example.com';
    runtimeEnv.ERP_FEISHU_LOGIN_REQUIRED = 'true';
    runtimeEnv.isFeishuLoginConfigured = true;
    runtimeEnv.verifyRequestIdentity = async () => ({ id: 'recovery-owner', email: 'owner@example.com', displayName: '负责人' });
    expect((await requestContext(erpRequest())).user).toMatchObject({ role: 'admin', authProvider: 'existing' });
    runtimeEnv.verifyRequestIdentity = async () => ({ id: 'old-staff', email: 'staff@example.com', displayName: '旧员工账号' });
    await expect(requestContext(erpRequest())).rejects.toMatchObject({ status: 401, code: 'AUTH_REQUIRED' });
    expect(await memberCount()).toBe(1);
  });

  it('正式模式空访问名单时失败关闭', async () => {
    runtimeEnv.ERP_DEV_OPEN_ACCESS = 'false';

    await expect(requestContext(erpRequest('owner-id', 'owner@example.com'))).rejects.toMatchObject({
      status: 503,
      code: 'ERP_ACCESS_POLICY_REQUIRED',
    });
    expect(await memberCount()).toBe(0);
  });

  it('允许精确邮箱初始化首位管理员', async () => {
    runtimeEnv.ERP_ALLOWED_EMAILS = ' OWNER@example.com ';

    const { user } = await requestContext(erpRequest('owner-id', 'owner@example.com'));

    expect(user).toMatchObject({ id: 'owner-id', email: 'owner@example.com', role: 'admin' });
    expect(user.permissions).toContain('purchase:review');
    expect(await storedRole('owner-id')).toBe('admin');
  });

  it('从开发开放切到正式模式时忽略开发成员，并由首位精确邮箱 owner 初始化管理员', async () => {
    runtimeEnv.ERP_DEV_OPEN_ACCESS = 'true';
    await requestContext(erpRequest());
    await requestContext(erpRequest('dev-user-id', 'temporary@example.net'));
    expect(await memberCount()).toBe(2);

    runtimeEnv.ERP_DEV_OPEN_ACCESS = 'false';
    runtimeEnv.ERP_ALLOWED_EMAILS = 'owner@example.com,staff@example.com';
    runtimeEnv.ERP_ALLOWED_EMAIL_DOMAINS = 'example.com';

    await expect(requestContext(erpRequest('staff-id', 'staff@example.com'))).rejects.toMatchObject({
      status: 403,
      code: 'ERP_ADMIN_BOOTSTRAP_EMAIL_REQUIRED',
    });
    expect(await storedRole('staff-id')).toBeUndefined();

    const owner = await requestContext(erpRequest('owner-id', 'OWNER@example.com'));
    expect(owner.user.role).toBe('admin');
    expect(await storedRole('owner-id')).toBe('admin');
    await requestContext(erpRequest('owner-id', 'owner@example.com'));
    expect(await memberCount()).toBe(3);

    const staff = await requestContext(erpRequest('staff-id', 'staff@example.com'));
    expect(staff.user.role).toBe('operator');
    expect(await storedRole('staff-id')).toBe('operator');
  });

  it('仅配置域名且尚无正式管理员时拒绝自动抢占管理员', async () => {
    runtimeEnv.ERP_ALLOWED_EMAIL_DOMAINS = '@muku.example';
    await seedMember('existing-id', 'existing@muku.example', 'admin');

    await expect(requestContext(erpRequest('existing-id', 'existing@muku.example'))).rejects.toMatchObject({
      status: 403,
      code: 'ERP_ADMIN_BOOTSTRAP_EMAIL_REQUIRED',
    });
    expect(await memberCount()).toBe(1);
    expect(await storedRole('existing-id')).toBe('admin');
  });

  it('允许公司域账号加入已有工作区并默认成为操作员', async () => {
    runtimeEnv.ERP_ALLOWED_EMAILS = 'owner@muku.example';
    runtimeEnv.ERP_ALLOWED_EMAIL_DOMAINS = '@muku.example';
    await seedMember('owner-id', 'owner@muku.example', 'admin');

    const { user } = await requestContext(erpRequest('staff-id', 'staff@MUKU.EXAMPLE'));

    expect(user.role).toBe('operator');
    expect(user.permissions).not.toContain('purchase:review');
    expect(await storedRole('staff-id')).toBe('operator');
  });

  it('拒绝名单外账号且绝不自动创建成员', async () => {
    runtimeEnv.ERP_ALLOWED_EMAILS = 'owner@example.com';

    await expect(requestContext(erpRequest('outsider-id', 'outsider@example.net'))).rejects.toMatchObject({
      status: 403,
      code: 'ERP_ACCESS_NOT_ALLOWED',
    });
    expect(await memberCount()).toBe(0);
  });

  it('开发阶段已有域名账号 admin 时仍由首位精确 owner 初始化正式管理员', async () => {
    runtimeEnv.ERP_DEV_OPEN_ACCESS = 'true';
    await requestContext(erpRequest('domain-dev-id', 'staff@allowed.example'));
    expect(await storedRole('domain-dev-id')).toBe('admin');

    runtimeEnv.ERP_DEV_OPEN_ACCESS = 'false';
    runtimeEnv.ERP_ALLOWED_EMAILS = 'owner@example.com';
    runtimeEnv.ERP_ALLOWED_EMAIL_DOMAINS = 'allowed.example';

    await expect(requestContext(
      erpRequest('domain-dev-id', 'staff@allowed.example'),
    )).rejects.toMatchObject({
      status: 403,
      code: 'ERP_ADMIN_BOOTSTRAP_EMAIL_REQUIRED',
    });
    expect(await storedRole('domain-dev-id')).toBe('admin');

    const owner = await requestContext(erpRequest('owner-id', 'owner@example.com'));
    expect(owner.user.role).toBe('admin');
    expect(await storedRole('owner-id')).toBe('admin');

    const existingDomainMember = await requestContext(
      erpRequest('domain-dev-id', 'staff@allowed.example'),
    );
    expect(existingDomainMember.user.role).toBe('admin');
    expect(await memberCount()).toBe(2);
  });

  it('首位精确 owner 已有非管理员记录时原地幂等提升为管理员', async () => {
    runtimeEnv.ERP_ALLOWED_EMAILS = 'owner@example.com';
    await seedMember('owner-id', 'owner@example.com', 'viewer');

    const [first, replay] = await Promise.all([
      requestContext(erpRequest('owner-id', 'owner@example.com')),
      requestContext(erpRequest('owner-id', 'OWNER@example.com')),
    ]);

    expect(first.user.role).toBe('admin');
    expect(replay.user.role).toBe('admin');
    expect(await storedRole('owner-id')).toBe('admin');
    expect(await memberCount()).toBe(1);
  });

  it('正式模式使用数据库中已有成员角色', async () => {
    runtimeEnv.ERP_ALLOWED_EMAILS = 'owner@example.com,viewer@example.com';
    await seedMember('owner-id', 'owner@example.com', 'admin');
    await seedMember('viewer-id', 'viewer@example.com', 'viewer');

    const { user } = await requestContext(erpRequest('viewer-id', 'viewer@example.com'));

    expect(user.role).toBe('viewer');
    expect(user.permissions).toEqual(['orders:read', 'connectors:read', 'purchase:read']);
    expect(await storedRole('viewer-id')).toBe('viewer');
  });

  it('开发开放模式保持匿名回退和任意账号管理员能力', async () => {
    runtimeEnv.ERP_DEV_OPEN_ACCESS = 'true';

    const anonymous = await requestContext(erpRequest());
    const arbitrary = await requestContext(erpRequest('dev-user-id', 'any-account@example.net'));

    expect(anonymous.user).toMatchObject({
      id: 'erp-development-open-access',
      role: 'admin',
    });
    expect(arbitrary.user).toMatchObject({ id: 'dev-user-id', role: 'admin' });
    expect(await memberCount()).toBe(2);
  });

  function erpRequest(id?: string, email?: string) {
    const headers = new Headers();
    if (id) headers.set('oai-authenticated-user-id', id);
    if (email) headers.set('oai-authenticated-user-email', email);
    return new Request('https://erp.example/api/erp', { headers });
  }

  async function seedMember(id: string, email: string, role: 'admin' | 'operator' | 'viewer') {
    const now = '2026-11-02T00:00:00.000Z';
    await db.prepare('INSERT OR IGNORE INTO tenants (id, name, created_at) VALUES (?, ?, ?)')
      .bind(TENANT_ID, 'Test ERP', now)
      .run();
    await db.prepare(`
      INSERT INTO members (id, tenant_id, auth_user_id, email, display_name, role, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(`member-${id}`, TENANT_ID, id, email, email.split('@')[0], role, now).run();
  }

  async function memberCount() {
    const row = await db.prepare('SELECT COUNT(*) AS count FROM members').first<{ count: number }>();
    return Number(row?.count ?? 0);
  }

  async function storedRole(id: string) {
    const row = await db.prepare('SELECT role FROM members WHERE auth_user_id = ?')
      .bind(id)
      .first<{ role: string }>();
    return row?.role;
  }
});

describe('真实店铺操作访问策略', () => {
  it('正式模式校验操作者必须在精确邮箱名单中', () => {
    const runtime = {
      ERP_ALLOWED_EMAILS: 'owner@example.com',
      ERP_ALLOWED_EMAIL_DOMAINS: 'muku.example',
    };

    expect(requireProductionAccessPolicy(runtime, 'OWNER@example.com').configured).toBe(true);
    expect(() => requireProductionAccessPolicy(runtime, 'staff@muku.example')).toThrowError(
      expect.objectContaining({ status: 403, code: 'ERP_SYNC_OPERATOR_EMAIL_REQUIRED' }),
    );
  });

  it('正式模式空配置失败关闭，开发开放模式保持原有行为', () => {
    expect(() => requireProductionAccessPolicy({}, 'owner@example.com')).toThrowError(
      expect.objectContaining({ status: 503, code: 'ERP_ACCESS_POLICY_REQUIRED' }),
    );
    expect(requireProductionAccessPolicy(
      { ERP_DEV_OPEN_ACCESS: 'true' },
      'any-account@example.net',
    ).configured).toBe(false);
  });
});
