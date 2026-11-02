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

  it('允许公司域账号加入已有工作区并默认成为操作员', async () => {
    runtimeEnv.ERP_ALLOWED_EMAIL_DOMAINS = '@muku.example';
    await seedMember('owner-id', 'owner@example.com', 'admin');

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

  it('正式模式使用数据库中已有成员角色', async () => {
    runtimeEnv.ERP_ALLOWED_EMAILS = 'viewer@example.com';
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
