import { env } from 'cloudflare:workers';
import { ensureDatabase } from '../db/initialize';
import {
  developmentOpenAccessEnabled,
  identityAllowed,
  identityExplicitlyListed,
  readProductionAccessPolicy,
} from './access-policy';
import { ROLE_PERMISSIONS, type Permission, type Role } from './domain';

const TENANT_ID = 'tenant_yicang_primary';
const TENANT_NAME = '易仓 ERP 工作区';

type RuntimeEnv = {
  DB?: D1Database;
  ERP_ALLOWED_EMAILS?: string;
  ERP_ALLOWED_EMAIL_DOMAINS?: string;
  ERP_DEV_OPEN_ACCESS?: string;
};

const DEVELOPMENT_IDENTITY = {
  id: 'erp-development-open-access',
  email: 'development-open-access@local.invalid',
  displayName: '开放开发模式',
} as const;

export class HttpError extends Error {
  constructor(public status: number, message: string, public code = 'REQUEST_FAILED') {
    super(message);
  }
}

export type UserContext = {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  permissions: Permission[];
  tenantId: string;
  tenantName: string;
};

export async function requestContext(request: Request) {
  const runtimeEnv = env as unknown as RuntimeEnv;
  const db = runtimeEnv.DB;
  if (!db) throw new HttpError(503, '数据库尚未绑定，请稍后重试', 'DATABASE_UNAVAILABLE');

  const developmentOpenAccess = developmentOpenAccessEnabled(runtimeEnv as Record<string, unknown>);
  const identity = readIdentity(request.headers)
    ?? (developmentOpenAccess
      ? DEVELOPMENT_IDENTITY
      : null);
  if (!identity) throw new HttpError(401, '请先登录后再访问易仓 ERP', 'AUTH_REQUIRED');

  const accessPolicy = readProductionAccessPolicy(runtimeEnv as Record<string, unknown>);
  if (!developmentOpenAccess) {
    if (!accessPolicy.configured) {
      throw new HttpError(
        503,
        'ERP 正式访问名单尚未配置，已拒绝访问',
        'ERP_ACCESS_POLICY_REQUIRED',
      );
    }
    if (!identityAllowed(identity.email, accessPolicy)) {
      throw new HttpError(403, '当前账号不在 ERP 公司访问名单中', 'ERP_ACCESS_NOT_ALLOWED');
    }
  }

  await ensureDatabase(db);
  await db.prepare(`
    INSERT OR IGNORE INTO tenants (id, name, created_at)
    VALUES (?, ?, ?)
  `).bind(TENANT_ID, TENANT_NAME, new Date().toISOString()).run();

  let member = await db.prepare(
    `SELECT auth_user_id, email, display_name, role
     FROM members WHERE tenant_id = ? AND auth_user_id = ? LIMIT 1`,
  ).bind(TENANT_ID, identity.id).first<{ auth_user_id: string; email: string; display_name: string; role: Role }>();

  if (!member) {
    let role: Role = 'admin';
    if (!developmentOpenAccess) {
      const bootstrapOwnerEmail = accessPolicy.bootstrapOwnerEmail;
      const ownerAdmin = bootstrapOwnerEmail
        ? await db.prepare(`
            SELECT 1 AS present FROM members
            WHERE tenant_id = ? AND role = 'admin' AND lower(email) = ?
            LIMIT 1
          `).bind(TENANT_ID, bootstrapOwnerEmail).first<{ present: number }>()
        : null;
      const needsOwnerBootstrap = !ownerAdmin;
      const isBootstrapOwner = bootstrapOwnerEmail === identity.email.trim().toLowerCase();
      if (needsOwnerBootstrap && !isBootstrapOwner) {
        throw new HttpError(
          403,
          '正式管理员尚未初始化，请先使用 ERP 精确邮箱名单中的首位 owner 账号访问',
          'ERP_ADMIN_BOOTSTRAP_EMAIL_REQUIRED',
        );
      }
      role = needsOwnerBootstrap ? 'admin' : 'operator';
    }
    await db.prepare(
      `INSERT OR IGNORE INTO members
       (id, tenant_id, auth_user_id, email, display_name, role, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(crypto.randomUUID(), TENANT_ID, identity.id, identity.email, identity.displayName, role, new Date().toISOString()).run();
    member = await db.prepare(
      `SELECT auth_user_id, email, display_name, role
       FROM members WHERE tenant_id = ? AND auth_user_id = ? LIMIT 1`,
    ).bind(TENANT_ID, identity.id).first<{ auth_user_id: string; email: string; display_name: string; role: Role }>();
  }

  if (!member) throw new HttpError(500, '用户上下文初始化失败', 'MEMBER_INIT_FAILED');

  // 开发开放模式临时提升为管理员，便于换账号联调；正式模式始终使用数据库成员角色。
  const role: Role = developmentOpenAccess ? 'admin' : member.role;
  const user: UserContext = {
    id: member.auth_user_id,
    email: member.email,
    displayName: member.display_name,
    role,
    permissions: ROLE_PERMISSIONS[role],
    tenantId: TENANT_ID,
    tenantName: TENANT_NAME,
  };
  return { db, user };
}

export function requirePermission(user: UserContext, permission: Permission) {
  if (!user.permissions.includes(permission)) {
    throw new HttpError(403, '当前账号没有执行该操作的权限', 'PERMISSION_DENIED');
  }
}

export function requireProductionAccessPolicy(runtimeEnv: Record<string, unknown>, operatorEmail: string) {
  const policy = readProductionAccessPolicy(runtimeEnv);
  if (developmentOpenAccessEnabled(runtimeEnv)) return policy;
  if (!policy.configured) {
    throw new HttpError(
      503,
      '接入真实店铺前必须先配置 ERP 公司邮箱或域名访问名单',
      'ERP_ACCESS_POLICY_REQUIRED',
    );
  }
  if (!identityExplicitlyListed(operatorEmail, policy)) {
    throw new HttpError(
      403,
      '真实店铺同步只能由精确邮箱名单中的管理员执行',
      'ERP_SYNC_OPERATOR_EMAIL_REQUIRED',
    );
  }
  return policy;
}

export function jsonError(error: unknown) {
  if (error instanceof HttpError) {
    return Response.json({ ok: false, code: error.code, message: error.message }, { status: error.status });
  }
  const message = error instanceof Error ? error.message : '未知错误';
  if (message.includes('INSUFFICIENT_STOCK')) {
    return Response.json({ ok: false, code: 'INSUFFICIENT_STOCK', message: '可售库存不足，无法完成审核预占' }, { status: 409 });
  }
  if (message.includes('INVALID_ORDER_TRANSITION')) {
    return Response.json({ ok: false, code: 'INVALID_ORDER_TRANSITION', message: '当前订单状态不允许执行该操作' }, { status: 409 });
  }
  if (message.includes('UNIQUE constraint failed')) {
    return Response.json({ ok: false, code: 'DUPLICATE_OPERATION', message: '该操作已处理，请刷新后查看' }, { status: 409 });
  }
  if (message.includes('DATABASE_MIGRATIONS_PENDING')) {
    return Response.json({ ok: false, code: 'DATABASE_MIGRATIONS_PENDING', message: '数据库迁移尚未完成，请重新部署当前版本' }, { status: 503 });
  }
  console.error(error);
  return Response.json({ ok: false, code: 'INTERNAL_ERROR', message: '系统暂时无法处理，请稍后重试' }, { status: 500 });
}

function readIdentity(headers: Headers) {
  const id = headers.get('oai-authenticated-user-id');
  const email = headers.get('oai-authenticated-user-email');
  if (!id || !email) return null;

  const encodedName = headers.get('oai-authenticated-user-full-name');
  const encoding = headers.get('oai-authenticated-user-full-name-encoding');
  let displayName = email.split('@')[0];
  if (encodedName && encoding === 'percent-encoded-utf-8') {
    try {
      displayName = decodeURIComponent(encodedName);
    } catch {
      displayName = email.split('@')[0];
    }
  }
  return { id, email, displayName };
}
