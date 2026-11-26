import { createHash, randomBytes } from 'node:crypto';
import {
  asObject, authCookie, authHeaders, authRedirect, COGNITO_LOGIN_COOKIE, COGNITO_SESSION_COOKIE,
  constantStringEqual, createSealedAuthCookies, decodeBase64url, FEISHU_LOGIN_COOKIE,
  FEISHU_SESSION_COOKIE, fetchIdentityJson, isFuture, isOpaqueToken,
} from './identity-http';

type FeishuIdentityConfig = {
  appId: string;
  appSecret: string;
  tenantKey: string;
  publicOrigin: string;
  sessionSecret: string;
};

type FeishuIdentityOptions = {
  fetch?: typeof fetch;
  now?: () => number;
};

export type FeishuIdentity = { id: string; email: string; displayName: string; provider: 'feishu' };

const AUTHORIZATION_ENDPOINT = 'https://accounts.feishu.cn/open-apis/authen/v1/authorize';
const TOKEN_ENDPOINT = 'https://open.feishu.cn/open-apis/authen/v2/oauth/token';
const USER_INFO_ENDPOINT = 'https://open.feishu.cn/open-apis/authen/v1/user_info';
const CALLBACK_PATH = '/api/auth/feishu/callback';
const TRANSACTION_MS = 10 * 60_000;
const SESSION_MS = 60 * 60_000;
const OPEN_ID = /^ou[_-][A-Za-z0-9_-]{1,240}$/u;
const EXTERNAL_ID = /^feishu:[A-Za-z0-9_-]{43}$/u;

export function configuredFeishuIdentity(runtime: Record<string, string | undefined>) {
  if (runtime.ERP_FEISHU_LOGIN_ENABLED !== 'true') return undefined;
  const sessionSecret = runtime.ERP_FEISHU_LOGIN_SESSION_SECRET ?? '';
  const appSecret = runtime.ERP_FEISHU_LOGIN_APP_SECRET ?? '';
  const workerToken = runtime.ERP_FEISHU_SYNC_WORKER_TOKEN;
  if (sessionSecret === runtime.ERP_AWS_SESSION_SECRET || sessionSecret === workerToken
    || appSecret === workerToken || appSecret === sessionSecret) {
    return undefined;
  }
  try {
    return createFeishuIdentity({
      appId: runtime.ERP_FEISHU_LOGIN_APP_ID ?? '',
      appSecret,
      tenantKey: runtime.ERP_FEISHU_LOGIN_TENANT_KEY ?? '',
      publicOrigin: runtime.ERP_PUBLIC_ORIGIN ?? '',
      sessionSecret,
    });
  } catch {
    // Invalid opt-in configuration leaves the independently configured recovery login available.
    return undefined;
  }
}

export function createFeishuIdentity(config: FeishuIdentityConfig, options: FeishuIdentityOptions = {}) {
  const { appId, appSecret, tenantKey } = config;
  if (!/^cli_[a-zA-Z0-9]{4,124}$/u.test(appId)) throw new Error('ERP_FEISHU_LOGIN_APP_ID is invalid');
  if (!/^[\x21-\x7e]{16,512}$/u.test(appSecret)) throw new Error('ERP_FEISHU_LOGIN_APP_SECRET is invalid');
  if (!/^[a-zA-Z0-9_-]{4,128}$/u.test(tenantKey)) throw new Error('ERP_FEISHU_LOGIN_TENANT_KEY is invalid');
  const site = URL.parse(config.publicOrigin);
  if (site?.protocol !== 'https:' || (config.publicOrigin !== site.origin && config.publicOrigin !== site.origin + '/')) {
    throw new Error('ERP_PUBLIC_ORIGIN must be the HTTPS origin of this ERP instance');
  }
  const publicOrigin = site.origin;
  const key = decodeBase64url(config.sessionSecret);
  if (key?.length !== 32) throw new Error('ERP_FEISHU_LOGIN_SESSION_SECRET must be 32 bytes encoded as base64url');

  const sealed = createSealedAuthCookies(key, [publicOrigin, AUTHORIZATION_ENDPOINT, appId, tenantKey]);
  const fetcher = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const callbackUrl = publicOrigin + CALLBACK_PATH;
  const home = publicOrigin + '/';
  const clearCognitoCookies = [authCookie(COGNITO_LOGIN_COOKIE, '', 0), authCookie(COGNITO_SESSION_COOKIE, '', 0)];

  function beginLogin(): Response {
    const state = randomBytes(32).toString('base64url');
    const codeVerifier = randomBytes(32).toString('base64url');
    const target = new URL(AUTHORIZATION_ENDPOINT);
    target.search = new URLSearchParams({
      client_id: appId,
      response_type: 'code',
      redirect_uri: callbackUrl,
      state,
      code_challenge: createHash('sha256').update(codeVerifier).digest('base64url'),
      code_challenge_method: 'S256',
      target_tenant: tenantKey,
    }).toString();
    return authRedirect(target.href, [sealed.write(FEISHU_LOGIN_COOKIE, {
      state, codeVerifier, expiresAt: now() + TRANSACTION_MS,
    }, TRANSACTION_MS / 1000)]);
  }

  async function finishLogin(request: Request): Promise<Response> {
    const query = new URL(request.url).searchParams;
    const transaction = sealed.read(request.headers, FEISHU_LOGIN_COOKIE);
    const state = query.get('state');
    const code = query.get('code');
    if (query.has('error') || query.getAll('state').length !== 1 || query.getAll('code').length !== 1
      || !isOpaqueToken(state) || !code || !/^[\x21-\x7e]{1,2048}$/u.test(code)
      || !transaction || !isOpaqueToken(transaction.state) || !isOpaqueToken(transaction.codeVerifier)
      || !isFuture(transaction.expiresAt, now()) || !constantStringEqual(state, transaction.state)) {
      return loginRejected();
    }

    try {
      const tokens = await fetchIdentityJson(fetcher, TOKEN_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          grant_type: 'authorization_code', client_id: appId, client_secret: appSecret,
          redirect_uri: callbackUrl, code, code_verifier: transaction.codeVerifier,
        }),
      });
      if (tokens.code !== 0 || typeof tokens.token_type !== 'string' || tokens.token_type.toLowerCase() !== 'bearer'
        || typeof tokens.access_token !== 'string'
        || !/^[\x21-\x7e]{1,16384}$/u.test(tokens.access_token)
        || typeof tokens.expires_in !== 'number' || !Number.isSafeInteger(tokens.expires_in)
        || tokens.expires_in <= 0) return loginRejected();

      const expiresAt = now() + Math.min(tokens.expires_in * 1000, SESSION_MS);
      const info = await fetchIdentityJson(fetcher, USER_INFO_ENDPOINT, {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });
      const data = asObject(info.data);
      if (info.code !== 0 || data?.tenant_key !== tenantKey || typeof data.open_id !== 'string' || !OPEN_ID.test(data.open_id)
        || !isFuture(transaction.expiresAt, now())) return loginRejected();

      const subject = createHash('sha256').update(JSON.stringify([tenantKey, appId, data.open_id])).digest('base64url');
      const identity: FeishuIdentity = {
        id: `feishu:${subject}`,
        email: validEmail(data.enterprise_email) ?? validEmail(data.email) ?? `f-${subject.toLowerCase()}@feishu.invalid`,
        displayName: normalizeName(data.name) || '飞书员工',
        provider: 'feishu',
      };
      const maxAge = Math.floor((expiresAt - now()) / 1000);
      if (maxAge < 1) return loginRejected();
      return authRedirect(home, [
        authCookie(FEISHU_LOGIN_COOKIE, '', 0),
        sealed.write(FEISHU_SESSION_COOKIE, { ...identity, expiresAt }, maxAge),
        ...clearCognitoCookies,
      ]);
    } catch {
      return loginRejected();
    }
  }

  async function verifyIdentity(headers: Headers): Promise<FeishuIdentity | null> {
    const session = sealed.read(headers, FEISHU_SESSION_COOKIE);
    if (!session || session.provider !== 'feishu' || !isFuture(session.expiresAt, now())
      || typeof session.id !== 'string' || !EXTERNAL_ID.test(session.id)
      || typeof session.email !== 'string' || typeof session.displayName !== 'string') return null;
    return { id: session.id, email: session.email, displayName: session.displayName, provider: 'feishu' };
  }

  function logout(request: Request): Response {
    if (request.headers.get('origin') !== publicOrigin) {
      return new Response('请求来源与 ERP 站点不一致', { status: 403, headers: authHeaders() });
    }
    return authRedirect(home, [authCookie(FEISHU_SESSION_COOKIE, '', 0), authCookie(FEISHU_LOGIN_COOKIE, '', 0),
      ...clearCognitoCookies]);
  }

  return { beginLogin, finishLogin, verifyIdentity, logout };
}

function validEmail(value: unknown) {
  if (typeof value !== 'string' || value.length > 254) return null;
  const email = value.trim().toLowerCase();
  return /^[^\s@,\x00-\x1f\x7f]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/u.test(email) ? email : null;
}

function normalizeName(value: unknown) {
  return typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/gu, '').trim().slice(0, 160) : '';
}

function loginRejected() {
  const headers = authHeaders();
  headers.append('Set-Cookie', authCookie(FEISHU_LOGIN_COOKIE, '', 0));
  return new Response('飞书登录未完成。请确认使用本公司的飞书账号，再从易仓重新登录。', { status: 401, headers });
}
