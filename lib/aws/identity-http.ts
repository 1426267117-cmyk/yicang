import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

const MAX_JSON_BYTES = 64 * 1024;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;
export const COGNITO_LOGIN_COOKIE = '__Host-yicang-cognito-login';
export const COGNITO_SESSION_COOKIE = '__Host-yicang-cognito-session';
export const FEISHU_LOGIN_COOKIE = '__Host-yicang-feishu-login';
export const FEISHU_SESSION_COOKIE = '__Host-yicang-feishu-session';

export function authCookie(name: string, value: string, maxAge: number) {
  return `${name}=${value}; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Lax`;
}

export function authHeaders() {
  return new Headers({
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'Content-Type': 'text/plain; charset=utf-8',
  });
}

export function authRedirect(location: string, cookies: string[]) {
  const headers = authHeaders();
  headers.set('Location', location);
  for (const cookie of cookies) headers.append('Set-Cookie', cookie);
  return new Response(null, { status: 303, headers });
}

export function decodeBase64url(value: string) {
  if (!BASE64URL.test(value)) return null;
  const bytes = Buffer.from(value, 'base64url');
  return bytes.toString('base64url') === value ? bytes : null;
}

export function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function parseObject(bytes: Uint8Array) {
  return asObject(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
}

export function isFuture(value: unknown, now: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > now;
}

export function isOpaqueToken(value: unknown): value is string {
  return typeof value === 'string' && value.length === 43 && BASE64URL.test(value);
}

export function constantStringEqual(candidate: string, expected: string) {
  if (candidate.length !== expected.length) return false;
  const left = Buffer.from(candidate);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function createSealedAuthCookies(sessionKey: Buffer, context: string[]) {
  function cookieContext(name: string) {
    return Buffer.from(JSON.stringify([name, ...context]));
  }

  function read(headers: Headers, name: string) {
    const prefix = name + '=';
    const matching = headers.get('cookie')?.split(';').map((item) => item.trim())
      .filter((item) => item.startsWith(prefix));
    const value = matching?.length === 1 ? matching[0].slice(prefix.length) : null;
    const sealed = value && value.length <= 4096 ? decodeBase64url(value) : null;
    if (!sealed || sealed.length <= 28) return null;
    try {
      const decipher = createDecipheriv('aes-256-gcm', sessionKey, sealed.subarray(0, 12));
      decipher.setAAD(cookieContext(name));
      decipher.setAuthTag(sealed.subarray(12, 28));
      const plaintext = Buffer.concat([decipher.update(sealed.subarray(28)), decipher.final()]);
      return parseObject(plaintext);
    } catch {
      return null;
    }
  }

  function write(name: string, payload: Record<string, unknown>, maxAge: number) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', sessionKey, iv);
    cipher.setAAD(cookieContext(name));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
    const value = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url');
    return authCookie(name, value, maxAge);
  }

  return { read, write };
}

export async function fetchIdentityJson(fetcher: typeof fetch, url: string, init?: RequestInit) {
  const response = await fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(5000) });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error('Identity provider response unavailable');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_JSON_BYTES) {
        await reader.cancel();
        throw new Error('Identity provider response exceeds the size limit');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const object = parseObject(Buffer.concat(chunks));
  if (!object) throw new Error('Identity provider did not return a JSON object');
  return object;
}
