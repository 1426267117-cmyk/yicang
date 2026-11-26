import { Miniflare } from 'miniflare';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({ env: {} }));

import type { UserContext } from '../lib/db';
import { ROLE_PERMISSIONS, resolveMemberAccess, type Role } from '../lib/domain';
import {
  listManagedMembers,
  updateManagedMemberRole,
} from '../lib/member-management-service';

const tenantId = 'tenant-member-management';
const otherTenantId = 'tenant-member-management-other';
const ownerEmail = 'owner@example.com';

const admin: UserContext = {
  id: 'auth-owner',
  email: ownerEmail,
  displayName: '负责人',
  role: 'admin',
  permissions: ROLE_PERMISSIONS.admin,
  tenantId,
  tenantName: '采购工作区',
};

describe('采购团队角色管理', () => {
  let mf: Miniflare;
  let db: D1Database;

  beforeEach(async () => {
    mf = new Miniflare({
      modules: true,
      script: 'export default { fetch(){ return new Response("ok") } }',
      d1Databases: ['DB'],
    });
    db = await mf.getD1Database('DB');
    await createSchema(db);
    await db.batch([
      db.prepare('INSERT INTO tenants (id, name, created_at) VALUES (?, ?, ?)')
        .bind(tenantId, '采购工作区', '2026-11-02T00:00:00.000Z'),
      db.prepare('INSERT INTO tenants (id, name, created_at) VALUES (?, ?, ?)')
        .bind(otherTenantId, '其他工作区', '2026-11-02T00:00:00.000Z'),
      memberStatement(db, 'member-owner', tenantId, 'auth-owner', ownerEmail, '负责人', 'admin'),
      memberStatement(db, 'member-buyer', tenantId, 'auth-buyer', 'buyer@example.com', '采购员', 'operator'),
      memberStatement(db, 'member-viewer', tenantId, 'auth-viewer', 'viewer@example.com', '查看员', 'viewer'),
      memberStatement(db, 'member-other-admin', otherTenantId, 'auth-other', 'other@example.com', '其他管理员', 'admin'),
    ]);
  });

  afterEach(async () => {
    await mf.dispose();
  });

  it('管理员只列出当前租户成员，并标记受保护负责人', async () => {
    const members = await listManagedMembers(db, admin, ' OWNER@example.com ');

    expect(members.map((member) => member.id)).toEqual([
      'member-owner',
      'member-buyer',
      'member-viewer',
    ]);
    expect(members.find((member) => member.id === 'member-owner')?.protectedOwner).toBe(true);
    expect(members.some((member) => member.id === 'member-other-admin')).toBe(false);
  });

  it('非管理员不能列出或修改成员角色', async () => {
    const operator: UserContext = {
      ...admin,
      id: 'auth-buyer',
      email: 'buyer@example.com',
      displayName: '采购员',
      role: 'operator',
      permissions: ROLE_PERMISSIONS.operator,
    };

    await expect(listManagedMembers(db, operator, ownerEmail)).rejects.toMatchObject({
      status: 403,
      code: 'PERMISSION_DENIED',
    });
    await expect(updateManagedMemberRole(db, operator, {
      memberId: 'member-viewer',
      role: 'operator',
      bootstrapOwnerEmail: ownerEmail,
    })).rejects.toMatchObject({ status: 403, code: 'PERMISSION_DENIED' });
  });

  it('管理员可调整现有成员角色，并追加不含凭证的审计记录', async () => {
    const result = await updateManagedMemberRole(db, admin, {
      memberId: 'member-buyer',
      role: 'viewer',
      bootstrapOwnerEmail: ownerEmail,
    });

    expect(result).toMatchObject({ replayed: false, member: { id: 'member-buyer', role: 'viewer' } });
    const audit = await db.prepare(`
      SELECT actor_email, action, entity_type, entity_id, before_json, after_json
      FROM audit_logs WHERE tenant_id = ?
    `).bind(tenantId).first<{
      actor_email: string;
      action: string;
      entity_type: string;
      entity_id: string;
      before_json: string;
      after_json: string;
    }>();
    expect(audit).toEqual({
      actor_email: ownerEmail,
      action: 'UPDATE_MEMBER_ROLE',
      entity_type: 'member',
      entity_id: 'member-buyer',
      before_json: JSON.stringify({ role: 'operator' }),
      after_json: JSON.stringify({ role: 'viewer' }),
    });
  });

  it('重复设置相同角色不重复写审计', async () => {
    const result = await updateManagedMemberRole(db, admin, {
      memberId: 'member-buyer',
      role: 'operator',
      bootstrapOwnerEmail: ownerEmail,
    });

    expect(result.replayed).toBe(true);
    expect(await auditCount(db)).toBe(0);
  });

  it('可给飞书成员分配单平台权限，重复保存不写第二条审计', async () => {
    await memberStatement(db, 'member-feishu', tenantId, 'feishu:test:employee', ownerEmail, '新员工', 'viewer').run();
    await db.prepare("UPDATE members SET access_profile = 'pending' WHERE id = 'member-feishu'").run();
    const input = { memberId: 'member-feishu', accessProfile: 'amazon' as const, bootstrapOwnerEmail: ownerEmail };
    const result = await updateManagedMemberRole(db, admin, input);
    expect(result).toMatchObject({ replayed: false, member: {
      role: 'viewer', accessProfile: 'amazon', identityProvider: 'feishu', protectedOwner: false,
    } });
    expect(resolveMemberAccess(result.member.role, result.member.accessProfile)).toEqual({
      permissions: ['channels:read'], channelScope: 'amazon',
    });
    expect(await updateManagedMemberRole(db, admin, input)).toMatchObject({ replayed: true });
    expect(await auditCount(db)).toBe(1);
    const audit = await db.prepare('SELECT before_json, after_json FROM audit_logs WHERE entity_id = ?')
      .bind('member-feishu').first<{ before_json: string; after_json: string }>();
    expect(JSON.parse(audit!.before_json)).toEqual({ role: 'viewer', accessProfile: 'pending' });
    expect(JSON.parse(audit!.after_json)).toEqual({ role: 'viewer', accessProfile: 'amazon' });
  });

  it('同一底层角色切换岗位仍需守住采购指派和租户边界', async () => {
    const purchaser = await updateManagedMemberRole(db, admin, {
      memberId: 'member-buyer', accessProfile: 'purchase', bootstrapOwnerEmail: ownerEmail,
    });
    expect(purchaser.member).toMatchObject({ role: 'operator', accessProfile: 'purchase' });
    await insertRequest(db, 'request-profile', 'draft', 'member-buyer', 'member-owner');
    await expect(updateManagedMemberRole(db, admin, {
      memberId: 'member-buyer', accessProfile: 'finance', bootstrapOwnerEmail: ownerEmail,
    })).rejects.toMatchObject({ code: 'MEMBER_ROLE_ACTIVE_PURCHASER_ASSIGNMENTS' });
    await expect(updateManagedMemberRole(db, admin, {
      memberId: 'member-other-admin', accessProfile: 'pending', bootstrapOwnerEmail: ownerEmail,
    })).rejects.toMatchObject({ code: 'MEMBER_NOT_FOUND' });
    expect(await auditCount(db)).toBe(1);
  });

  it('管理员失权后不能凭旧授权批量修改成员', async () => {
    const staleActorDb = {
      prepare: db.prepare.bind(db),
      batch: async (statements: D1PreparedStatement[]) => {
        await db.prepare("UPDATE members SET role = 'viewer', access_profile = 'pending' WHERE id = 'member-owner'").run();
        return db.batch(statements);
      },
    } as D1Database;
    await expect(updateManagedMemberRole(staleActorDb, admin, {
      memberId: 'member-viewer', accessProfile: 'finance', bootstrapOwnerEmail: ownerEmail,
    })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(await auditCount(db)).toBe(0);
  });

  it('跨租户成员标识按不存在处理且不会修改', async () => {
    await expect(updateManagedMemberRole(db, admin, {
      memberId: 'member-other-admin',
      role: 'viewer',
      bootstrapOwnerEmail: ownerEmail,
    })).rejects.toMatchObject({ status: 404, code: 'MEMBER_NOT_FOUND' });
    expect(await storedRole(db, otherTenantId, 'member-other-admin')).toBe('admin');
    expect(await auditCount(db)).toBe(0);
  });

  it('配置的正式负责人不能被降级', async () => {
    await db.prepare(`
      UPDATE members SET role = 'admin'
      WHERE tenant_id = ? AND id = 'member-buyer'
    `).bind(tenantId).run();

    await expect(updateManagedMemberRole(db, admin, {
      memberId: 'member-owner',
      role: 'operator',
      bootstrapOwnerEmail: 'OWNER@example.com',
    })).rejects.toMatchObject({ status: 409, code: 'BOOTSTRAP_OWNER_ROLE_PROTECTED' });
    expect(await storedRole(db, tenantId, 'member-owner')).toBe('admin');
    expect(await auditCount(db)).toBe(0);
  });

  it('即使未配置负责人也不能降级唯一管理员', async () => {
    await expect(updateManagedMemberRole(db, admin, {
      memberId: 'member-owner',
      role: 'viewer',
      bootstrapOwnerEmail: null,
    })).rejects.toMatchObject({ status: 409, code: 'LAST_ADMIN_ROLE_PROTECTED' });
    expect(await storedRole(db, tenantId, 'member-owner')).toBe('admin');
  });

  it('存在另一管理员时可降级非负责人管理员', async () => {
    await db.prepare(`
      UPDATE members SET role = 'admin'
      WHERE tenant_id = ? AND id = 'member-buyer'
    `).bind(tenantId).run();

    const result = await updateManagedMemberRole(db, admin, {
      memberId: 'member-buyer',
      role: 'operator',
      bootstrapOwnerEmail: ownerEmail,
    });

    expect(result.member.role).toBe('operator');
    expect(await storedRole(db, tenantId, 'member-owner')).toBe('admin');
    expect(await auditCount(db)).toBe(1);
  });

  it('不能把仍负责草稿、待复审或待转单申请的采购负责人降为只读', async () => {
    await insertRequest(db, 'request-draft', 'draft', 'member-buyer', 'member-owner');
    await expect(updateManagedMemberRole(db, admin, {
      memberId: 'member-buyer',
      role: 'viewer',
      bootstrapOwnerEmail: ownerEmail,
    })).rejects.toMatchObject({
      status: 409,
      code: 'MEMBER_ROLE_ACTIVE_PURCHASER_ASSIGNMENTS',
    });
    expect(await storedRole(db, tenantId, 'member-buyer')).toBe('operator');

    await db.prepare(`UPDATE purchase_requests SET status = 'pending_review' WHERE id = 'request-draft'`).run();
    await expect(updateManagedMemberRole(db, admin, {
      memberId: 'member-buyer',
      role: 'viewer',
      bootstrapOwnerEmail: ownerEmail,
    })).rejects.toMatchObject({
      status: 409,
      code: 'MEMBER_ROLE_ACTIVE_PURCHASER_ASSIGNMENTS',
    });

    await db.prepare(`UPDATE purchase_requests SET status = 'cancelled' WHERE id = 'request-draft'`).run();
    const changed = await updateManagedMemberRole(db, admin, {
      memberId: 'member-buyer',
      role: 'viewer',
      bootstrapOwnerEmail: ownerEmail,
    });
    expect(changed.member.role).toBe('viewer');
  });

  it('不能移除仍被草稿或待复审申请指定的复审权限', async () => {
    await db.prepare(`
      INSERT INTO members (id, tenant_id, auth_user_id, email, display_name, role, created_at)
      VALUES ('member-reviewer', ?, 'auth-reviewer', 'reviewer@example.com', '复审员', 'admin', ?)
    `).bind(tenantId, '2026-11-02T00:00:00.000Z').run();
    await insertRequest(db, 'request-review', 'pending_review', 'member-buyer', 'member-reviewer');

    await expect(updateManagedMemberRole(db, admin, {
      memberId: 'member-reviewer',
      role: 'operator',
      bootstrapOwnerEmail: ownerEmail,
    })).rejects.toMatchObject({
      status: 409,
      code: 'MEMBER_ROLE_ACTIVE_REVIEWER_ASSIGNMENTS',
    });
    expect(await storedRole(db, tenantId, 'member-reviewer')).toBe('admin');
  });

  it.each(['draft', 'issued', 'partially_received'])(
    '仍负责 %s 采购单时不能降为只读',
    async (orderStatus) => {
      await insertRequest(db, 'request-approved', 'approved', 'member-buyer', 'member-owner');
      await db.prepare(`
        INSERT INTO purchase_orders (id, tenant_id, purchase_request_id, status)
        VALUES ('order-active', ?, 'request-approved', ?)
      `).bind(tenantId, orderStatus).run();

      await expect(updateManagedMemberRole(db, admin, {
        memberId: 'member-buyer',
        role: 'viewer',
        bootstrapOwnerEmail: ownerEmail,
      })).rejects.toMatchObject({
        status: 409,
        code: 'MEMBER_ROLE_ACTIVE_PURCHASE_ORDERS',
      });
      expect(await storedRole(db, tenantId, 'member-buyer')).toBe('operator');
      expect(await auditCount(db)).toBe(0);
    },
  );

  it.each(['received', 'closed_short', 'cancelled'])(
    '只有 %s 终态采购单时不因该采购单阻止降级',
    async (orderStatus) => {
      const requestStatus = orderStatus === 'cancelled' ? 'cancelled' : 'approved';
      await insertRequest(db, 'request-terminal', requestStatus, 'member-buyer', 'member-owner');
      await db.prepare(`
        INSERT INTO purchase_orders (id, tenant_id, purchase_request_id, status)
        VALUES ('order-terminal', ?, 'request-terminal', ?)
      `).bind(tenantId, orderStatus).run();

      const changed = await updateManagedMemberRole(db, admin, {
        memberId: 'member-buyer',
        role: 'viewer',
        bootstrapOwnerEmail: ownerEmail,
      });

      expect(changed.member.role).toBe('viewer');
      expect(await auditCount(db)).toBe(1);
    },
  );
});

async function createSchema(db: D1Database) {
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
      created_at TEXT NOT NULL
    )
  `).run();
  await db.prepare(`
    CREATE TABLE audit_logs (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      actor_email TEXT NOT NULL,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      before_json TEXT,
      after_json TEXT,
      request_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      source TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `).run();
  await db.prepare(`
    CREATE TABLE purchase_requests (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      status TEXT NOT NULL,
      purchaser_member_id TEXT NOT NULL,
      reviewer_member_id TEXT NOT NULL
    )
  `).run();
  await db.prepare(`
    CREATE TABLE purchase_orders (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      purchase_request_id TEXT NOT NULL,
      status TEXT NOT NULL
    )
  `).run();
  await db.prepare(`
    CREATE UNIQUE INDEX uq_audit_tenant_idempotency
    ON audit_logs (tenant_id, idempotency_key)
  `).run();
}

async function insertRequest(
  db: D1Database,
  id: string,
  status: string,
  purchaserMemberId: string,
  reviewerMemberId: string,
) {
  await db.prepare(`
    INSERT INTO purchase_requests (id, tenant_id, status, purchaser_member_id, reviewer_member_id)
    VALUES (?, ?, ?, ?, ?)
  `).bind(id, tenantId, status, purchaserMemberId, reviewerMemberId).run();
}

function memberStatement(
  db: D1Database,
  id: string,
  memberTenantId: string,
  authUserId: string,
  email: string,
  displayName: string,
  role: Role,
) {
  return db.prepare(`
    INSERT INTO members (id, tenant_id, auth_user_id, email, display_name, role, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(id, memberTenantId, authUserId, email, displayName, role, '2026-11-02T00:00:00.000Z');
}

async function storedRole(db: D1Database, memberTenantId: string, memberId: string) {
  const row = await db.prepare(`
    SELECT role FROM members WHERE tenant_id = ? AND id = ?
  `).bind(memberTenantId, memberId).first<{ role: Role }>();
  return row?.role;
}

async function auditCount(db: D1Database) {
  const row = await db.prepare('SELECT COUNT(*) AS count FROM audit_logs')
    .first<{ count: number }>();
  return Number(row?.count ?? 0);
}
