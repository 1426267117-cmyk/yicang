import { createHash, createPublicKey, randomBytes, verify, type KeyObject } from 'node:crypto';
import type { AlbIdentity } from './alb-identity';
import {
  asObject, authCookie as cookie, authHeaders, authRedirect as redirect,
  COGNITO_LOGIN_COOKIE as LOGIN_COOKIE, COGNITO_SESSION_COOKIE as SESSION_COOKIE,
  constantStringEqual, createSealedAuthCookies, decodeBase64url, fetchIdentityJson as fetchJson,
  FEISHU_LOGIN_COOKIE, FEISHU_SESSION_COOKIE, isFuture, isOpaqueToken, parseObject,
} from './identity-http';

type CognitoIdentityConfig = {
  issuer: string;
  clientId: string;
  domain: string;
  publicOrigin: string;
  sessionSecret: string;
};

type CognitoIdentityOptions = {
  fetch?: typeof fetch;
  now?: () => number;
  clearFeishuSession?: boolean;
};

type LoginTransaction = {
  state: string;
  nonce: string;
  codeVerifier: string;
  expiresAt: number;
};

const CALLBACK_PATH = '/api/auth/cognito/callback';
const TRANSACTION_MS = 10 * 60_000;
const SESSION_MS = 60 * 60_000;
const KEYS_CACHE_MS = 5 * 60_000;
const KEY_RETRY_MS = 30_000;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;
const COGNITO_ISSUER = /^https:\/\/(?:issuer-)?cognito-idp\.([a-z]{2}(?:-[a-z0-9]+)+-\d+)\.amazonaws\.com\/\1_[A-Za-z0-9]+$/u;
const COGNITO_DOMAIN = /^https:\/\/[a-z0-9][a-z0-9-]*\.auth\.([a-z]{2}(?:-[a-z0-9]+)+-\d+)\.amazoncognito\.com$/u;

export function createCognitoIdentity(config: CognitoIdentityConfig, options: CognitoIdentityOptions = {}) {
  const { issuer, clientId, domain, publicOrigin } = config;
  const region = COGNITO_ISSUER.exec(issuer)?.[1];
  if (!region) throw new Error('ERP_AWS_OIDC_ISSUER must be the Cognito user pool issuer');
  if (COGNITO_DOMAIN.exec(domain)?.[1] !== region) {
    throw new Error('ERP_AWS_COGNITO_DOMAIN must be the managed Cognito HTTPS origin in the issuer region');
  }
  if (!/^[A-Za-z0-9_+\-]{1,128}$/u.test(clientId)) throw new Error('ERP_AWS_OIDC_CLIENT_ID is invalid');
  let site: URL;
  try {
    site = new URL(publicOrigin);
  } catch {
    throw new Error('ERP_PUBLIC_ORIGIN must be the HTTPS origin of this ERP instance');
  }
  if (site.protocol !== 'https:' || site.origin !== publicOrigin) {
    throw new Error('ERP_PUBLIC_ORIGIN must be the HTTPS origin of this ERP instance');
  }
  const configuredKey = decodeBase64url(config.sessionSecret);
  if (configuredKey?.length !== 32) throw new Error('ERP_AWS_COGNITO_SESSION_SECRET must be 32 bytes encoded as base64url');
  const fetcher = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const callbackUrl = publicOrigin + CALLBACK_PATH;
  const keyCache = createSigningKeyCache(issuer, fetcher, now);
  const { read: readSealedCookie, write: writeSealedCookie } = createSealedAuthCookies(configuredKey,
    [publicOrigin, issuer, clientId]);
  const clearFeishuCookies = options.clearFeishuSession
    ? [cookie(FEISHU_LOGIN_COOKIE, '', 0), cookie(FEISHU_SESSION_COOKIE, '', 0)] : [];

  function beginLogin(): Response {
    const transaction = {
      state: randomBytes(32).toString('base64url'),
      nonce: randomBytes(32).toString('base64url'),
      codeVerifier: randomBytes(32).toString('base64url'),
      expiresAt: now() + TRANSACTION_MS,
    } satisfies LoginTransaction;
    const target = new URL('/oauth2/authorize', domain);
    target.search = new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: callbackUrl,
      scope: 'openid email',
      state: transaction.state,
      nonce: transaction.nonce,
      code_challenge: createHash('sha256').update(transaction.codeVerifier).digest('base64url'),
      code_challenge_method: 'S256',
    }).toString();
    return redirect(target.href, [writeSealedCookie(LOGIN_COOKIE, transaction, TRANSACTION_MS / 1000)]);
  }

  async function finishLogin(request: Request): Promise<Response> {
    const query = new URL(request.url).searchParams;
    const transaction = readSealedCookie(request.headers, LOGIN_COOKIE);
    const state = query.get('state');
    const code = query.get('code');
    if (query.has('error') || query.getAll('state').length !== 1 || query.getAll('code').length !== 1
      || !state || !code || code.length > 2048 || !transaction
      || !isOpaqueToken(transaction.state) || !isOpaqueToken(transaction.nonce)
      || !isOpaqueToken(transaction.codeVerifier) || !isFuture(transaction.expiresAt, now())
      || !constantStringEqual(state, transaction.state)) {
      return loginRejected();
    }

    try {
      const tokens = await fetchJson(fetcher, new URL('/oauth2/token', domain).href, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: clientId,
          redirect_uri: callbackUrl,
          code,
          code_verifier: transaction.codeVerifier,
        }),
      });
      const assertion = typeof tokens.id_token === 'string' && await verifyIdToken(
        tokens.id_token, { issuer, clientId, nonce: transaction.nonce }, keyCache, now,
      );
      if (!assertion || !isFuture(transaction.expiresAt, now())) return loginRejected();

      const expiresAt = Math.min(assertion.expiresAt, now() + SESSION_MS);
      const maxAge = Math.floor((expiresAt - now()) / 1000);
      if (maxAge < 1) return loginRejected();
      return redirect(site.origin + '/', [
        cookie(LOGIN_COOKIE, '', 0),
        writeSealedCookie(SESSION_COOKIE, { ...assertion.identity, expiresAt }, maxAge),
        ...clearFeishuCookies,
      ]);
    } catch {
      return loginRejected();
    }
  }

  async function verifyIdentity(headers: Headers): Promise<AlbIdentity | null> {
    const session = readSealedCookie(headers, SESSION_COOKIE);
    if (!session || !isFuture(session.expiresAt, now()) || typeof session.id !== 'string'
      || typeof session.email !== 'string' || typeof session.displayName !== 'string') return null;
    return { id: session.id, email: session.email, displayName: session.displayName };
  }

  function logout(request: Request): Response {
    if (request.headers.get('origin') !== site.origin) {
      return new Response('请求来源与 ERP 站点不一致', { status: 403, headers: authHeaders() });
    }
    const target = new URL('/logout', domain);
    target.search = new URLSearchParams({ client_id: clientId, logout_uri: site.origin + '/' }).toString();
    return redirect(target.href, [cookie(SESSION_COOKIE, '', 0), cookie(LOGIN_COOKIE, '', 0), ...clearFeishuCookies]);
  }

  return { beginLogin, finishLogin, verifyIdentity, logout };
}

function loginRejected() {
  const headers = authHeaders();
  headers.append('Set-Cookie', cookie(LOGIN_COOKIE, '', 0));
  return new Response('登录未完成。请重新打开易仓并再次登录。', { status: 401, headers });
}

function createSigningKeyCache(issuer: string, fetcher: typeof fetch, now: () => number) {
  let keys = new Map<string, KeyObject>();
  let expiresAt = 0;
  let lastAttempt = -Infinity;
  let pending: Promise<void> | null = null;

  async function refreshKeys() {
    const jwks = await fetchJson(fetcher, issuer + '/.well-known/jwks.json');
    if (!Array.isArray(jwks.keys) || jwks.keys.length > 32) throw new Error('Invalid Cognito key set');
    const verified = new Map<string, KeyObject>();
    for (const candidate of jwks.keys) {
      const key = asObject(candidate);
      if (!key || typeof key.kid !== 'string' || key.kid.length > 128 || key.kty !== 'RSA'
        || key.alg !== 'RS256' || key.use !== 'sig' || typeof key.n !== 'string' || typeof key.e !== 'string'
        || !BASE64URL.test(key.n) || !BASE64URL.test(key.e)) continue;
      const publicKey = createPublicKey({ format: 'jwk', key: { kty: 'RSA', n: key.n, e: key.e } });
      if (publicKey.asymmetricKeyType !== 'rsa' || (publicKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) continue;
      if (verified.has(key.kid)) throw new Error('Duplicate Cognito key identifier');
      verified.set(key.kid, publicKey);
    }
    if (verified.size === 0) throw new Error('No usable Cognito signing keys');
    keys = verified;
    expiresAt = now() + KEYS_CACHE_MS;
  }

  return async (kid: string) => {
    if (expiresAt > now() && keys.has(kid)) return keys.get(kid) ?? null;
    if (!pending && now() - lastAttempt >= KEY_RETRY_MS) {
      lastAttempt = now();
      pending = refreshKeys().finally(() => { pending = null; });
    }
    await pending;
    return expiresAt > now() ? keys.get(kid) ?? null : null;
  };
}

async function verifyIdToken(
  token: string,
  expected: { issuer: string; clientId: string; nonce: string },
  getKey: (kid: string) => Promise<KeyObject | null>,
  now: () => number,
) {
  const segments = token.split('.');
  if (token.length > 16 * 1024 || segments.length !== 3) return null;
  const [encodedHeader, encodedPayload, encodedSignature] = segments;
  const headerBytes = decodeBase64url(encodedHeader);
  const payloadBytes = decodeBase64url(encodedPayload);
  const signature = decodeBase64url(encodedSignature);
  if (!headerBytes || !payloadBytes || !signature) return null;
  const header = parseObject(headerBytes);
  if (!header || header.alg !== 'RS256' || 'crit' in header || typeof header.kid !== 'string'
    || !/^[\x21-\x7e]{1,128}$/u.test(header.kid)) return null;
  const claims = parseObject(payloadBytes);
  if (!claims || claims.iss !== expected.issuer || claims.aud !== expected.clientId || claims.token_use !== 'id'
    || claims.nonce !== expected.nonce || claims.email_verified !== true || typeof claims.sub !== 'string'
    || !/^[\x21-\x7e]{1,255}$/u.test(claims.sub) || typeof claims.email !== 'string'
    || typeof claims.exp !== 'number' || !isFuture(claims.exp * 1000, now())
    || typeof claims.iat !== 'number' || !Number.isSafeInteger(claims.iat) || claims.iat * 1000 > now() + 30_000
    || ('nbf' in claims && (typeof claims.nbf !== 'number' || claims.nbf * 1000 > now()))) return null;

  const key = await getKey(header.kid);
  const expiresAt = claims.exp * 1000;
  if (!key || !verify('RSA-SHA256', Buffer.from(`${encodedHeader}.${encodedPayload}`, 'ascii'), key, signature)
    || !isFuture(expiresAt, now())) return null;
  const email = claims.email.trim().toLowerCase();
  if (!/^[^\s@,\x00-\x1f\x7f]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/u.test(email) || email.length > 254) return null;
  const displayName = typeof claims.name === 'string' ? claims.name.trim().slice(0, 160) : '';
  const subject = createHash('sha256').update(expected.issuer).update('\0').update(claims.sub).digest('base64url');
  return {
    identity: { id: `aws-alb:${subject}`, email, displayName: displayName || email.split('@')[0] },
    expiresAt,
  };
}
