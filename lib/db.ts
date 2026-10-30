import { env } from 'cloudflare:workers';
import { ensureDatabase } from '../db/initialize';
import {
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
};

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

  await ensureDatabase(db);
  const identity = readIdentity(request.headers);
  if (!identity) throw new HttpError(401, '请先登录后再访问易仓 ERP', 'AUTH_REQUIRED');
  const accessPolicy = readProductionAccessPolicy(runtimeEnv as Record<string, unknown>);
  const platformStore = await db.prepare(`
    SELECT 1 AS present FROM platform_stores WHERE tenant_id = ? LIMIT 1
  `).bind(TENANT_ID).first<{ present: number }>();
  if (platformStore && !accessPolicy.configured) {
    throw new HttpError(
      503,
      'ERP 已接入真实平台数据，但公司访问名单缺失，已拒绝访问',
      'ERP_ACCESS_POLICY_REQUIRED',
    );
  }
  if (accessPolicy.configured && !identityAllowed(identity.email, accessPolicy)) {
    throw new HttpError(403, '当前账号不在 ERP 公司访问名单中', 'ERP_ACCESS_NOT_ALLOWED');
  }

  await db.prepare(`
    INSERT OR IGNORE INTO tenants (id, name, created_at)
    VALUES (?, ?, ?)
  `).bind(TENANT_ID, TENANT_NAME, new Date().toISOString()).run();

  let member = await db.prepare(
    'SELECT auth_user_id, email, display_name, role FROM members WHERE auth_user_id = ? LIMIT 1',
  ).bind(identity.id).first<{ auth_user_id: string; email: string; display_name: string; role: Role }>();

  if (!member) {
    const count = await db.prepare('SELECT COUNT(*) AS count FROM members WHERE tenant_id = ?')
      .bind(TENANT_ID)
      .first<{ count: number }>();
    const isFirstMember = Number(count?.count ?? 0) === 0;
    if (isFirstMember && accessPolicy.configured && !identityExplicitlyListed(identity.email, accessPolicy)) {
      throw new HttpError(
        403,
        '首次管理员必须使用 ERP 精确邮箱名单中的账号初始化',
        'ERP_ADMIN_BOOTSTRAP_EMAIL_REQUIRED',
      );
    }
    const role: Role = isFirstMember ? 'admin' : 'operator';
    await db.prepare(
      `INSERT OR IGNORE INTO members
       (id, tenant_id, auth_user_id, email, display_name, role, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(crypto.randomUUID(), TENANT_ID, identity.id, identity.email, identity.displayName, role, new Date().toISOString()).run();
    member = await db.prepare(
      'SELECT auth_user_id, email, display_name, role FROM members WHERE auth_user_id = ? LIMIT 1',
    ).bind(identity.id).first<{ auth_user_id: string; email: string; display_name: string; role: Role }>();
  }

  if (!member) throw new HttpError(500, '用户上下文初始化失败', 'MEMBER_INIT_FAILED');

  const user: UserContext = {
    id: member.auth_user_id,
    email: member.email,
    displayName: member.display_name,
    role: member.role,
    permissions: ROLE_PERMISSIONS[member.role],
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
