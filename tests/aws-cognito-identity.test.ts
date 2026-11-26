import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createCognitoIdentity } from '../lib/aws/cognito-identity';

const config = {
  issuer: 'https://cognito-idp.ap-southeast-1.amazonaws.com/ap-southeast-1_Example',
  clientId: 'client123',
  domain: 'https://yicang-tests.auth.ap-southeast-1.amazoncognito.com',
  publicOrigin: 'https://example.execute-api.ap-southeast-1.amazonaws.com',
  sessionSecret: randomBytes(32).toString('base64url'),
};
const initialTime = 1800000000000;
const callback = config.publicOrigin + '/api/auth/cognito/callback';
const kid = 'cognito-key+/=';
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwks = {
  keys: [{ ...publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' }],
};

function encodeJwt(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function signIdToken(nonce: string, overrides: Record<string, unknown> = {}) {
  const claims = {
    iss: config.issuer, aud: config.clientId, token_use: 'id', nonce,
    email: 'Buyer@Example.Com', email_verified: true, sub: 'cognito-subject', name: '采购负责人',
    exp: initialTime / 1000 + 900, iat: initialTime / 1000,
    ...overrides,
  };
  const input = encodeJwt({ kid, alg: 'RS256' }) + '.' + encodeJwt(claims);
  const signature = sign('RSA-SHA256', Buffer.from(input), privateKey);
  return input + '.' + signature.toString('base64url');
}

function beginLogin(identity: ReturnType<typeof createCognitoIdentity>) {
  const start = identity.beginLogin();
  const target = new URL(start.headers.get('Location')!);
  const [loginCookie] = start.headers.getSetCookie();
  const requestCookie = loginCookie.split(';')[0];
  function callbackRequest(state: string = target.searchParams.get('state')!, cookie = requestCookie) {
    return new Request(callback + '?' + new URLSearchParams({ state, code: 'auth-code' }), {
      headers: { cookie },
    });
  }
  return { start, target, loginCookie, requestCookie, callbackRequest };
}

describe('AWS Cognito site login', () => {
  it('binds OAuth code redemption to PKCE and nonce, then issues a verified HTTPS-only session', async () => {
    let currentTime = initialTime;
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (url === config.domain + '/oauth2/token') {
        const form = init?.body as URLSearchParams;
        expect(init?.method).toBe('POST');
        expect(init?.redirect).toBe('error');
        expect(form.get('redirect_uri')).toBe(callback);
        expect(form.get('client_id')).toBe(config.clientId);
        expect(form.get('grant_type')).toBe('authorization_code');
        expect(form.get('code')).toBe('auth-code');
        expect(createHash('sha256').update(form.get('code_verifier')!).digest('base64url')).toBe(expectedChallenge);
        return Response.json({ id_token: signIdToken(expectedNonce) });
      }
      expect(url).toBe(config.issuer + '/.well-known/jwks.json');
      return Response.json(jwks);
    });
    const identity = createCognitoIdentity(config, { fetch: fetcher, now: () => currentTime });
    const { start, target, loginCookie, callbackRequest } = beginLogin(identity);
    const expectedNonce = target.searchParams.get('nonce')!;
    const expectedChallenge = target.searchParams.get('code_challenge')!;
    expect(start.status).toBe(303);
    expect(start.headers.get('Cache-Control')).toBe('no-store');
    expect(target.origin).toBe(config.domain);
    expect(target.pathname).toBe('/oauth2/authorize');
    expect(target.searchParams.get('code_challenge_method')).toBe('S256');
    expect(target.searchParams.get('response_type')).toBe('code');
    expect(target.searchParams.get('scope')).toBe('openid email');
    expect(target.searchParams.get('redirect_uri')).toBe(callback);
    expect(loginCookie).toMatch(/^__Host-yicang-cognito-login=.*; Path=\/; Max-Age=600; Secure; HttpOnly; SameSite=Lax$/u);

    const done = await identity.finishLogin(callbackRequest());
    expect(done.status).toBe(303);
    expect(done.headers.get('Location')).toBe(config.publicOrigin + '/');
    const [cleared, session] = done.headers.getSetCookie();
    expect(cleared).toMatch(/^__Host-yicang-cognito-login=; Path=\/; Max-Age=0;/u);
    expect(session).toMatch(/^__Host-yicang-cognito-session=.*; Path=\/; Max-Age=900; Secure; HttpOnly; SameSite=Lax$/u);
    expect(session).not.toContain('buyer');
    const headers = new Headers({ cookie: session.split(';')[0] });
    await expect(identity.verifyIdentity(headers)).resolves.toEqual({
      id: 'aws-alb:' + createHash('sha256').update(config.issuer).update('\0').update('cognito-subject').digest('base64url'),
      email: 'buyer@example.com',
      displayName: '采购负责人',
    });
    expect(fetcher).toHaveBeenCalledTimes(2);

    const otherInstance = createCognitoIdentity({ ...config, publicOrigin: config.publicOrigin.replace('example', 'other') });
    await expect(otherInstance.verifyIdentity(headers)).resolves.toBeNull();
    currentTime += 900_000;
    await expect(identity.verifyIdentity(headers)).resolves.toBeNull();
  });

  it('refuses incorrect state, modified and expired login cookies, and unsigned legacy headers', async () => {
    let currentTime = initialTime;
    const fetcher = vi.fn();
    const identity = createCognitoIdentity(config, { fetch: fetcher, now: () => currentTime });
    const { callbackRequest, target, requestCookie } = beginLogin(identity);
    const state = target.searchParams.get('state')!;
    const [name, value] = requestCookie.split('=');
    const modified = name + '=' + (value[0] === 'a' ? 'b' : 'a') + value.slice(1);
    expect((await identity.finishLogin(callbackRequest('wrong'))).status).toBe(401);
    expect((await identity.finishLogin(callbackRequest(state, modified))).status).toBe(401);
    expect((await identity.finishLogin(callbackRequest(state, requestCookie + '; ' + requestCookie))).status).toBe(401);
    currentTime += 600_000;
    expect((await identity.finishLogin(callbackRequest())).status).toBe(401);
    expect(fetcher).not.toHaveBeenCalled();
    await expect(identity.verifyIdentity(new Headers({
      'x-amzn-oidc-data': 'unsigned',
      'oai-authenticated-user-email': 'buyer@example.com',
    }))).resolves.toBeNull();
  });

  it('rejects tokens that are signed for another audience, issuer, nonce, or usage', async () => {
    let encodedToken = '';
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      return url === config.domain + '/oauth2/token'
        ? Response.json({ id_token: encodedToken })
        : Response.json(jwks);
    });
    const identity = createCognitoIdentity(config, { fetch: fetcher, now: () => initialTime });
    for (const overrides of [
      { aud: 'shenzhen' }, { iss: config.issuer + 'other' }, { nonce: 'another-transaction' },
      { token_use: 'access' }, { email_verified: false }, { exp: initialTime / 1000 },
    ]) {
      const { target, callbackRequest } = beginLogin(identity);
      encodedToken = signIdToken(target.searchParams.get('nonce')!, overrides);
      const response = await identity.finishLogin(callbackRequest());
      expect(response.status).toBe(401);
      expect(response.headers.getSetCookie()).toHaveLength(1);
    }
    expect(fetcher).toHaveBeenCalledTimes(6);
  });

  it('rejects a modified signature and caches the expected issuer keys for other users', async () => {
    let encodedToken = '';
    const fetcher = vi.fn(async (url: string | URL | Request) =>
      url === config.domain + '/oauth2/token' ? Response.json({ id_token: encodedToken }) : Response.json(jwks),
    );
    const identity = createCognitoIdentity(config, { fetch: fetcher, now: () => initialTime });
    for (const tamper of [true, false]) {
      const { target, callbackRequest } = beginLogin(identity);
      const nonce = target.searchParams.get('nonce')!;
      const [header, payload, signature] = signIdToken(nonce).split('.');
      encodedToken = tamper ? [header, payload, (signature[0] === 'a' ? 'b' : 'a') + signature.slice(1)].join('.') : signIdToken(nonce);
      expect((await identity.finishLogin(callbackRequest())).status).toBe(tamper ? 401 : 303);
    }
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('requires same-origin logout and expires both cookies before logging out of Cognito', () => {
    const identity = createCognitoIdentity(config);
    const request = (origin: string) => new Request(config.publicOrigin + '/api/auth/cognito/logout', {
      method: 'POST',
      headers: { origin },
    });
    expect(identity.logout(request('https://another.example.com')).status).toBe(403);
    const response = identity.logout(request(config.publicOrigin));
    expect(response.status).toBe(303);
    const target = new URL(response.headers.get('Location')!);
    expect(target.origin + target.pathname).toBe(config.domain + '/logout');
    expect(target.searchParams.get('logout_uri')).toBe(config.publicOrigin + '/');
    expect(response.headers.getSetCookie()).toHaveLength(2);
    expect(response.headers.getSetCookie().every((cookie) => cookie.includes('Max-Age=0'))).toBe(true);
  });

  it('rejects bad configuration before any Cognito calls', () => {
    expect(() => createCognitoIdentity({ ...config, issuer: 'https://another.example.com' })).toThrow('ERP_AWS_OIDC_ISSUER');
    expect(() => createCognitoIdentity({ ...config, domain: 'https://another.example.com' })).toThrow('ERP_AWS_COGNITO_DOMAIN');
    expect(() => createCognitoIdentity({ ...config, publicOrigin: config.publicOrigin + '/path' })).toThrow('ERP_PUBLIC_ORIGIN');
    expect(() => createCognitoIdentity({ ...config, sessionSecret: 'unsafe' })).toThrow('ERP_AWS_COGNITO_SESSION_SECRET');
  });
});
