import { HttpError, requirePermission, type UserContext } from './db';
import type { Role } from './domain';

type MemberRow = {
  id: string;
  auth_user_id: string;
  email: string;
  display_name: string;
  role: Role;
  created_at: string;
};

export type ManagedMember = {
  id: string;
  authUserId: string;
  email: string;
  displayName: string;
  role: Role;
  createdAt: string;
  protectedOwner: boolean;
};

export async function listManagedMembers(
  db: D1Database,
  user: UserContext,
  bootstrapOwnerEmail: string | null,
) {
  requirePermission(user, 'members:manage');
  const rows = await db.prepare(`
    SELECT id, auth_user_id, email, display_name, role, created_at
    FROM members
    WHERE tenant_id = ?
    ORDER BY
      CASE role WHEN 'admin' THEN 0 WHEN 'operator' THEN 1 ELSE 2 END,
      lower(display_name), lower(email), id
  `).bind(user.tenantId).all<MemberRow>();

  return rows.results.map((row) => toManagedMember(row, bootstrapOwnerEmail));
}

export async function updateManagedMemberRole(
  db: D1Database,
  user: UserContext,
  input: {
    memberId: string;
    role: Role;
    bootstrapOwnerEmail: string | null;
  },
) {
  requirePermission(user, 'members:manage');
  const memberId = input.memberId.trim();
  if (!memberId) {
    throw new HttpError(400, '成员标识不能为空', 'INVALID_MEMBER_ID');
  }

  const target = await db.prepare(`
    SELECT id, auth_user_id, email, display_name, role, created_at
    FROM members
    WHERE tenant_id = ? AND id = ?
    LIMIT 1
  `).bind(user.tenantId, memberId).first<MemberRow>();
  if (!target) {
    throw new HttpError(404, '成员不存在或不在当前工作区', 'MEMBER_NOT_FOUND');
  }

  const protectedOwner = isBootstrapOwner(target.email, input.bootstrapOwnerEmail);
  if (protectedOwner && input.role !== 'admin') {
    throw new HttpError(409, '工作区负责人必须保留管理员角色', 'BOOTSTRAP_OWNER_ROLE_PROTECTED');
  }
  if (target.role === input.role) {
    return { member: toManagedMember(target, input.bootstrapOwnerEmail), replayed: true };
  }

  if (target.role === 'admin' && input.role !== 'admin') {
    const admins = await db.prepare(`
      SELECT COUNT(*) AS count
      FROM members
      WHERE tenant_id = ? AND role = 'admin'
    `).bind(user.tenantId).first<{ count: number }>();
    if (Number(admins?.count ?? 0) <= 1) {
      throw new HttpError(409, '工作区必须至少保留一名管理员', 'LAST_ADMIN_ROLE_PROTECTED');
    }
  }

  const now = new Date().toISOString();
  const auditId = crypto.randomUUID();
  const requestId = crypto.randomUUID();
  const protectedEmail = normalizeEmail(input.bootstrapOwnerEmail) ?? '';
  const results = await db.batch([
    db.prepare(`
      UPDATE members
      SET role = ?
      WHERE tenant_id = ? AND id = ? AND role = ?
        AND (
          ? = 'admin'
          OR (
            role <> 'admin'
            OR (SELECT COUNT(*) FROM members admins WHERE admins.tenant_id = ? AND admins.role = 'admin') > 1
          )
        )
        AND (? = 'admin' OR ? = '' OR lower(email) <> ?)
    `).bind(
      input.role,
      user.tenantId,
      target.id,
      target.role,
      input.role,
      user.tenantId,
      input.role,
      protectedEmail,
      protectedEmail,
    ),
    db.prepare(`
      INSERT INTO audit_logs (
        id, tenant_id, actor_id, actor_email, action, entity_type, entity_id,
        before_json, after_json, request_id, idempotency_key, source, created_at
      )
      SELECT ?, ?, ?, ?, 'UPDATE_MEMBER_ROLE', 'member', ?, ?, ?, ?, ?, 'erp_api', ?
      WHERE changes() = 1
    `).bind(
      auditId,
      user.tenantId,
      user.id,
      user.email,
      target.id,
      JSON.stringify({ role: target.role }),
      JSON.stringify({ role: input.role }),
      requestId,
      `member-role:${target.id}:${auditId}`,
      now,
    ),
  ]);

  if (Number(results[0]?.meta.changes ?? 0) !== 1) {
    const current = await db.prepare(`
      SELECT id, auth_user_id, email, display_name, role, created_at
      FROM members
      WHERE tenant_id = ? AND id = ?
      LIMIT 1
    `).bind(user.tenantId, target.id).first<MemberRow>();
    if (!current) {
      throw new HttpError(404, '成员不存在或不在当前工作区', 'MEMBER_NOT_FOUND');
    }
    if (isBootstrapOwner(current.email, input.bootstrapOwnerEmail) && input.role !== 'admin') {
      throw new HttpError(409, '工作区负责人必须保留管理员角色', 'BOOTSTRAP_OWNER_ROLE_PROTECTED');
    }
    throw new HttpError(409, '成员角色已变化，请刷新后重试', 'MEMBER_ROLE_CONFLICT');
  }

  const updated = await db.prepare(`
    SELECT id, auth_user_id, email, display_name, role, created_at
    FROM members
    WHERE tenant_id = ? AND id = ?
    LIMIT 1
  `).bind(user.tenantId, target.id).first<MemberRow>();
  if (!updated) {
    throw new HttpError(404, '成员不存在或不在当前工作区', 'MEMBER_NOT_FOUND');
  }
  return { member: toManagedMember(updated, input.bootstrapOwnerEmail), replayed: false };
}

function toManagedMember(row: MemberRow, bootstrapOwnerEmail: string | null): ManagedMember {
  return {
    id: row.id,
    authUserId: row.auth_user_id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    createdAt: row.created_at,
    protectedOwner: isBootstrapOwner(row.email, bootstrapOwnerEmail),
  };
}

function isBootstrapOwner(email: string, bootstrapOwnerEmail: string | null) {
  const owner = normalizeEmail(bootstrapOwnerEmail);
  return owner !== null && email.trim().toLowerCase() === owner;
}

function normalizeEmail(email: string | null) {
  const value = email?.trim().toLowerCase() ?? '';
  return value || null;
}
