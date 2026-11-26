import { env } from 'cloudflare:workers';
import { ensureDatabase } from '../db/initialize';
import {
  developmentOpenAccessEnabled,
  identityAllowed,
  identityExplicitlyListed,
  readProductionAccessPolicy,
} from './access-policy';
import { resolveMemberAccess, type AccessProfile, type ChannelScope, type Permission, type Role } from './domain';

const TENANT_ID = 'tenant_yicang_primary';
const TENANT_NAME = '易仓 ERP 工作区';

type RuntimeEnv = {
  DB?: D1Database;
  ERP_HOST_RUNTIME?: string;
  ERP_PUBLIC_ORIGIN?: string;
  ERP_WORKSPACE_NAME?: string;
  ERP_FEISHU_LOGIN_REQUIRED?: string;
  isFeishuLoginConfigured?: boolean;
  verifyRequestIdentity?: (headers: Headers) => Promise<{
    id: string;
    email: string;
    displayName: string;
    provider?: 'feishu';
  } | null>;
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
  accessProfile?: AccessProfile | null;
  channelScope?: ChannelScope | null;
  authProvider?: 'feishu' | 'existing';
};

type RequestMember = { auth_user_id: string; email: string; display_name: string; role: Role; access_profile: AccessProfile | null };

export async function requestContext(request: Request) {
  const runtimeEnv = env as unknown as RuntimeEnv;
  const db = runtimeEnv.DB;
  if (!db) throw new HttpError(503, '数据库尚未绑定，请稍后重试', 'DATABASE_UNAVAILABLE');

  const isAws = runtimeEnv.ERP_HOST_RUNTIME === 'aws';
  const tenantName = isAws ? runtimeEnv.ERP_WORKSPACE_NAME?.trim() || TENANT_NAME : TENANT_NAME;
  const developmentOpenAccess = !isAws && developmentOpenAccessEnabled(runtimeEnv as Record<string, unknown>);
  const identity = isAws
    ? await runtimeEnv.verifyRequestIdentity?.(request.headers)
    : readIdentity(request.headers) ?? (developmentOpenAccess ? DEVELOPMENT_IDENTITY : null);
  if (!identity) throw new HttpError(401, '请先登录后再访问易仓 ERP', 'AUTH_REQUIRED');
  const isFeishu = isAws && 'provider' in identity && identity.provider === 'feishu';
  if (isAws && identity.id.startsWith('feishu:') !== isFeishu) {
    throw new HttpError(401, '登录身份与认证来源不一致，请重新登录', 'AUTH_REQUIRED');
  }
  if (isAws && request.method !== 'GET' && request.method !== 'HEAD' && request.method !== 'OPTIONS'
    && request.headers.get('origin') !== runtimeEnv.ERP_PUBLIC_ORIGIN) {
    throw new HttpError(403, '请求来源与 ERP 站点不一致', 'ERP_REQUEST_ORIGIN_NOT_ALLOWED');
  }

  const accessPolicy = readProductionAccessPolicy(runtimeEnv as Record<string, unknown>);
  if (!developmentOpenAccess) {
    if (!accessPolicy.configured) {
      throw new HttpError(
        503,
        'ERP 正式访问名单尚未配置，已拒绝访问',
        'ERP_ACCESS_POLICY_REQUIRED',
      );
    }
    if (!isFeishu && !identityAllowed(identity.email, accessPolicy)) {
      throw new HttpError(403, '当前账号不在 ERP 公司访问名单中', 'ERP_ACCESS_NOT_ALLOWED');
    }
    if (isAws && !isFeishu && runtimeEnv.ERP_FEISHU_LOGIN_REQUIRED === 'true'
      && identity.email.trim().toLowerCase() !== accessPolicy.bootstrapOwnerEmail) {
      if (!runtimeEnv.isFeishuLoginConfigured) throw new HttpError(503, '飞书登录配置尚未完成', 'ERP_FEISHU_LOGIN_UNAVAILABLE');
      throw new HttpError(401, '请使用工作区的飞书账号登录', 'AUTH_REQUIRED');
    }
  }

  await ensureDatabase(db);
  await db.prepare(`
    INSERT OR IGNORE INTO tenants (id, name, created_at)
    VALUES (?, ?, ?)
  `).bind(TENANT_ID, tenantName, new Date().toISOString()).run();

  const findMember = () => db.prepare(
    `SELECT auth_user_id, email, display_name, role, access_profile
     FROM members WHERE tenant_id = ? AND auth_user_id = ? LIMIT 1`,
  ).bind(TENANT_ID, identity.id).first<RequestMember>();
  let member = await findMember();

  let bootstrapOwnerNeedsCreation = false;
  if (!developmentOpenAccess) {
    const bootstrapOwnerEmail = accessPolicy.bootstrapOwnerEmail;
    if (!bootstrapOwnerEmail) {
      throw new HttpError(
        403,
        '正式管理员尚未配置，请先在 ERP 精确邮箱名单中设置首位 owner 账号',
        'ERP_ADMIN_BOOTSTRAP_EMAIL_REQUIRED',
      );
    }

    const ownerAdmin = await db.prepare(`
      SELECT 1 AS present FROM members
      WHERE tenant_id = ? AND role = 'admin' AND access_profile IS NULL
        AND lower(email) = ? AND auth_user_id NOT LIKE 'feishu:%'
      LIMIT 1
    `).bind(TENANT_ID, bootstrapOwnerEmail).first<{ present: number }>();

    if (!ownerAdmin) {
      const isBootstrapOwner = !isFeishu && bootstrapOwnerEmail === identity.email.trim().toLowerCase();
      if (!isBootstrapOwner) {
        throw new HttpError(
          403,
          '正式管理员尚未初始化，请先使用 ERP 精确邮箱名单中的首位 owner 账号访问',
          'ERP_ADMIN_BOOTSTRAP_EMAIL_REQUIRED',
        );
      }
      if (member) {
        await db.prepare(`
          UPDATE members SET email = ?, display_name = ?, role = 'admin', access_profile = NULL
          WHERE tenant_id = ? AND auth_user_id = ?
            AND (role <> 'admin' OR access_profile IS NOT NULL OR lower(email) <> ?)
        `).bind(
          identity.email,
          identity.displayName,
          TENANT_ID,
          identity.id,
          bootstrapOwnerEmail,
        ).run();
        member = await findMember();
      } else if (!member) {
        bootstrapOwnerNeedsCreation = true;
      }
    }
  }

  if (!member) {
    const role: Role = developmentOpenAccess || bootstrapOwnerNeedsCreation ? 'admin' : isFeishu ? 'viewer' : 'operator';
    await db.prepare(
      `INSERT OR IGNORE INTO members
       (id, tenant_id, auth_user_id, email, display_name, role, access_profile, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(crypto.randomUUID(), TENANT_ID, identity.id, identity.email, identity.displayName, role,
      isFeishu ? 'pending' : null, new Date().toISOString()).run();
    member = await findMember();
  }

  if (!member) throw new HttpError(500, '用户上下文初始化失败', 'MEMBER_INIT_FAILED');

  // 开发开放模式临时提升为管理员，便于换账号联调；正式模式始终使用数据库成员角色。
  const role: Role = developmentOpenAccess ? 'admin' : member.role;
  const accessProfile = developmentOpenAccess ? null : member.access_profile;
  const access = resolveMemberAccess(role, accessProfile);
  const user: UserContext = {
    id: member.auth_user_id,
    email: member.email,
    displayName: member.display_name,
    role,
    ...access,
    accessProfile,
    authProvider: isFeishu ? 'feishu' : 'existing',
    tenantId: TENANT_ID,
    tenantName,
  };
  return { db, user };
}

export function requirePermission(user: UserContext, permission: Permission) {
  if (!user.permissions.includes(permission)) {
    throw new HttpError(403, '当前账号没有执行该操作的权限', 'PERMISSION_DENIED');
  }
}

export function isWorkspaceFeishuAdministrator(runtimeEnv: Record<string, unknown>, user: UserContext) {
  return runtimeEnv.ERP_HOST_RUNTIME === 'aws' && user.authProvider === 'feishu'
    && user.id.startsWith('feishu:') && user.role === 'admin' && !user.accessProfile && !user.channelScope;
}

export function requireShopifyConnectorOperator(runtimeEnv: Record<string, unknown>, user: UserContext) {
  requirePermission(user, 'connectors:sync');
  if (isWorkspaceFeishuAdministrator(runtimeEnv, user) && readProductionAccessPolicy(runtimeEnv).configured) return;
  requireProductionAccessPolicy(runtimeEnv, user.email);
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
  if (message.includes('WAREHOUSE_PACK_REQUIRED')) {
    return Response.json({ ok: false, code: 'WAREHOUSE_PACK_REQUIRED', message: '请先完成拣货、复核和打包，再确认发货' }, { status: 409 });
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
