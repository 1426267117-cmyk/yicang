import { createHash, randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { configuredFeishuIdentity, createFeishuIdentity } from '../lib/aws/feishu-identity';

const config = {
  appId: 'cli_ExampleERP',
  appSecret: 'example-app-secret-erp',
  tenantKey: 'guangzhou-example',
  publicOrigin: 'https://erp.example.test',
  sessionSecret: randomBytes(32).toString('base64url'),
};
const callback = config.publicOrigin + '/api/auth/feishu/callback';
const initialTime = 1800000000000;
const tokenEndpoint = 'https://open.feishu.cn/open-apis/authen/v2/oauth/token';
const userInfoEndpoint = 'https://open.feishu.cn/open-apis/authen/v1/user_info';
const tokenResponse = { code: 0, token_type: 'Bearer', access_token: 'example-redemption-token', expires_in: 7200 };

function startLogin(identity: ReturnType<typeof createFeishuIdentity>) {
  const start = identity.beginLogin();
  const target = new URL(start.headers.get('Location')!);
  const [loginCookie] = start.headers.getSetCookie();
  const requestCookie = loginCookie.split(';')[0];
  const query = new URLSearchParams({ state: target.searchParams.get('state')!, code: 'login-code' });
  function request(params = query, cookie = requestCookie) {
    return new Request(callback + '?' + params, { headers: { cookie } });
  }
  return { start, target, loginCookie, query, request };
}

function sessionHeaders(response: Response) {
  const cookie = response.headers.getSetCookie().find((value) => value.startsWith('__Host-yicang-feishu-session='));
  return new Headers(cookie ? { cookie: cookie.split(';')[0] } : undefined);
}

describe('Feishu web login', () => {
  it('exchanges only the bound code and PKCE verifier, pins Feishu identity, and issues an isolated session', async () => {
    let currentTime = initialTime;
    const provider = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(init?.redirect).toBe('error');
      if (url === tokenEndpoint) {
        expect(init?.method).toBe('POST');
        expect(new Headers(init?.headers).get('Content-Type')).toBe('application/json; charset=utf-8');
        const body = JSON.parse(String(init?.body));
        expect(body).toEqual({
          grant_type: 'authorization_code', client_id: config.appId, client_secret: config.appSecret,
          redirect_uri: callback, code: 'login-code', code_verifier: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
        });
        expect(createHash('sha256').update(body.code_verifier).digest('base64url')).toBe(challenge);
        return Response.json(tokenResponse);
      }
      expect(url).toBe(userInfoEndpoint);
      expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${tokenResponse.access_token}`);
      return Response.json({ code: 0, data: {
        tenant_key: config.tenantKey, open_id: 'ou_first-buyer', name: '采购员', enterprise_email: 'Purchaser@Example.test',
      } });
    });
    const identity = createFeishuIdentity(config, { fetch: provider, now: () => currentTime });
    const { start, target, loginCookie, request } = startLogin(identity);
    const challenge = target.searchParams.get('code_challenge');
    expect(start.status).toBe(303);
    expect(start.headers.get('Cache-Control')).toBe('no-store');
    expect(target.origin + target.pathname).toBe('https://accounts.feishu.cn/open-apis/authen/v1/authorize');
    expect(Object.fromEntries(target.searchParams)).toEqual({
      client_id: config.appId, response_type: 'code', redirect_uri: callback, target_tenant: config.tenantKey,
      code_challenge_method: 'S256', code_challenge: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
      state: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
    });
    expect(loginCookie).toMatch(/^__Host-yicang-feishu-login=.*; Path=\/; Max-Age=600; Secure; HttpOnly; SameSite=Lax$/u);
    expect(target.href).not.toContain(config.appSecret);

    const response = await identity.finishLogin(request());
    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toBe(config.publicOrigin + '/');
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    const cookies = response.headers.getSetCookie();
    expect(cookies).toEqual([
      expect.stringContaining('__Host-yicang-feishu-login=; Path=/; Max-Age=0'),
      expect.stringMatching(/^__Host-yicang-feishu-session=.*; Path=\/; Max-Age=3600; Secure; HttpOnly; SameSite=Lax$/u),
      expect.stringContaining('__Host-yicang-cognito-login=; Path=/; Max-Age=0'),
      expect.stringContaining('__Host-yicang-cognito-session=; Path=/; Max-Age=0'),
    ]);
    expect(cookies.join(' ')).not.toContain(tokenResponse.access_token);
    const headers = sessionHeaders(response);
    await expect(identity.verifyIdentity(headers)).resolves.toEqual({
      id: 'feishu:' + createHash('sha256').update(JSON.stringify([config.tenantKey, config.appId, 'ou_first-buyer'])).digest('base64url'),
      email: 'purchaser@example.test', displayName: '采购员', provider: 'feishu',
    });
    await expect(createFeishuIdentity({ ...config, appId: 'cli_OtherERP' }).verifyIdentity(headers)).resolves.toBeNull();
    await expect(createFeishuIdentity({ ...config, tenantKey: 'other-company' }).verifyIdentity(headers)).resolves.toBeNull();
    const modifiedCookie = headers.get('cookie')!.replace(/=(.)/u, (_, first: string) => '=' + (first === 'a' ? 'b' : 'a'));
    await expect(identity.verifyIdentity(new Headers({ cookie: modifiedCookie }))).resolves.toBeNull();
    currentTime += 3600_000;
    await expect(identity.verifyIdentity(headers)).resolves.toBeNull();
    expect(provider).toHaveBeenCalledTimes(2);
  });

  it('rejects invalid, repeated, or expired login context before contacting Feishu', async () => {
    let currentTime = initialTime;
    const provider = vi.fn();
    const identity = createFeishuIdentity(config, { fetch: provider, now: () => currentTime });
    const { query, request } = startLogin(identity);
    const wrongState = new URLSearchParams(query);
    wrongState.set('state', randomBytes(32).toString('base64url'));
    const repeatedCode = new URLSearchParams(query);
    repeatedCode.append('code', 'second-code');
    for (const invalid of [request(wrongState), request(repeatedCode), request(query, '')]) {
      expect((await identity.finishLogin(invalid)).status).toBe(401);
    }
    currentTime += 600_000;
    expect((await identity.finishLogin(request())).status).toBe(401);
    expect(provider).not.toHaveBeenCalled();
  });

  it('rejects Feishu PKCE verification failure after a single exchange', async () => {
    const provider = vi.fn(async () => Response.json({ code: 20049 }, { status: 400 }));
    const identity = createFeishuIdentity(config, { fetch: provider, now: () => initialTime });
    const response = await identity.finishLogin(startLogin(identity).request());
    expect(response.status).toBe(401);
    expect(await identity.verifyIdentity(sessionHeaders(response))).toBeNull();
    expect(provider).toHaveBeenCalledExactlyOnceWith(tokenEndpoint, expect.objectContaining({ method: 'POST' }));
  });

  it('rejects other companies and derives accounts from the app and open ID even if profile email changes or coincides', async () => {
    let userInfo: Record<string, string> = {};
    const provider = vi.fn(async (url: string | URL | Request) => Response.json(
      url === tokenEndpoint ? tokenResponse : { code: 0, data: userInfo },
    ));
    const identity = createFeishuIdentity(config, { fetch: provider, now: () => initialTime });
    async function tryWith(profile: Record<string, string>) {
      userInfo = profile;
      const response = await identity.finishLogin(startLogin(identity).request());
      return { response, user: await identity.verifyIdentity(sessionHeaders(response)) };
    }
    const foreign = await tryWith({ tenant_key: 'shenzhen-example', open_id: 'ou_first-buyer', email: 'owner@example.test' });
    expect(foreign.response.status).toBe(401);
    expect(foreign.user).toBeNull();
    const missingId = await tryWith({ tenant_key: config.tenantKey, email: 'owner@example.test' });
    expect(missingId.response.status).toBe(401);
    const ownerEmail = await tryWith({ tenant_key: config.tenantKey, open_id: 'ou_first-buyer', email: 'owner@example.test' });
    const sameEmail = await tryWith({ tenant_key: config.tenantKey, open_id: 'ou_second-buyer', email: 'owner@example.test' });
    const noEmail = await tryWith({ tenant_key: config.tenantKey, open_id: 'ou_first-buyer' });
    expect(ownerEmail.user?.email).toBe('owner@example.test');
    expect(sameEmail.user?.id).not.toBe(ownerEmail.user?.id);
    expect(noEmail.user?.id).toBe(ownerEmail.user?.id);
    expect(noEmail.user?.email).toMatch(/^f-[a-z0-9_-]{43}@feishu\.invalid$/u);
  });

  it('requires same-origin logout and expires both providers’ cookies', () => {
    const identity = createFeishuIdentity(config);
    const request = (origin: string) => new Request(config.publicOrigin + '/api/auth/feishu/logout', {
      method: 'POST', headers: { origin },
    });
    expect(identity.logout(request('https://elsewhere.test')).status).toBe(403);
    const response = identity.logout(request(config.publicOrigin));
    expect(response.status).toBe(303);
    expect(response.headers.getSetCookie()).toHaveLength(4);
    expect(response.headers.getSetCookie().every((cookie) => cookie.includes('Max-Age=0'))).toBe(true);
  });

  it('stays disabled until explicitly configured with an independent secure session', () => {
    const runtime = {
      ERP_FEISHU_LOGIN_APP_ID: config.appId,
      ERP_FEISHU_LOGIN_APP_SECRET: config.appSecret,
      ERP_FEISHU_LOGIN_TENANT_KEY: config.tenantKey,
      ERP_FEISHU_LOGIN_SESSION_SECRET: config.sessionSecret,
      ERP_PUBLIC_ORIGIN: config.publicOrigin,
    };
    expect(configuredFeishuIdentity(runtime)).toBeUndefined();
    const enabled = { ...runtime, ERP_FEISHU_LOGIN_ENABLED: 'true' };
    expect(configuredFeishuIdentity({ ...enabled, ERP_PUBLIC_ORIGIN: 'http://erp.example.test' })).toBeUndefined();
    expect(configuredFeishuIdentity({ ...enabled, ERP_FEISHU_LOGIN_TENANT_KEY: '' })).toBeUndefined();
    expect(configuredFeishuIdentity({ ...enabled, ERP_AWS_SESSION_SECRET: config.sessionSecret })).toBeUndefined();
    expect(configuredFeishuIdentity({ ...enabled, ERP_FEISHU_SYNC_WORKER_TOKEN: config.appSecret })).toBeUndefined();
    expect(configuredFeishuIdentity(enabled)).toBeDefined();
  });
});
