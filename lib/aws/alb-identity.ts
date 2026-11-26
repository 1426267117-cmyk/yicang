import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';

export type AlbIdentityConfig = {
  signerArn: string;
  clientId: string;
  issuer: string;
};

export type AlbIdentity = {
  id: string;
  email: string;
  displayName: string;
};

type VerifierOptions = {
  fetchKey?: typeof fetch;
  now?: () => number;
};

const ALB_ARN = /^arn:aws:elasticloadbalancing:([a-z]{2}(?:-[a-z0-9]+)+-\d+):\d{12}:loadbalancer\/app\/[A-Za-z0-9-]{1,32}\/[0-9a-f]{16}$/u;
const AWS_KEY_ID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu;
const BASE64URL = /^[A-Za-z0-9_-]+={0,2}$/u;
const KEY_CACHE_MS = 60 * 60 * 1000;
const KEY_CACHE_LIMIT = 32;
const KEY_LOOKUP_LIMIT = 4;
const KEY_RESPONSE_MAX_BYTES = 4096;
const ALB_TOKEN_MAX_LENGTH = 16 * 1024;

/**
 * Verifies the ALB-signed user-info assertion. Authorize the verified email
 * through the ERP access policy and allow ingress only from the expected ALB.
 */
export function createAlbIdentityVerifier(config: AlbIdentityConfig, options: VerifierOptions = {}) {
  const { signerArn, clientId, issuer } = config;
  const region = ALB_ARN.exec(signerArn)?.[1];
  if (!region) throw new Error('ERP_AWS_ALB_ARN must identify an ALB in the commercial AWS partition');
  if (!/^\S{1,255}$/u.test(clientId)) throw new Error('ERP_AWS_OIDC_CLIENT_ID is invalid');
  validateIssuer(issuer);
  const fetchKey = options.fetchKey ?? fetch;
  const now = options.now ?? Date.now;
  const cachedKeys = new Map<string, { key: KeyObject; expiresAt: number }>();
  const pendingKeys = new Map<string, Promise<KeyObject>>();

  async function getKey(kid: string) {
    const cached = cachedKeys.get(kid);
    if (cached && cached.expiresAt > now()) return cached.key;
    cachedKeys.delete(kid);

    const pending = pendingKeys.get(kid);
    if (pending) return pending;
    if (pendingKeys.size >= KEY_LOOKUP_LIMIT) throw new Error('AWS ALB key lookups are busy');

    const lookup = fetchPublicKey(fetchKey, `https://public-keys.auth.elb.${region}.amazonaws.com/${kid}`);
    pendingKeys.set(kid, lookup);
    try {
      const key = await lookup;
      if (cachedKeys.size >= KEY_CACHE_LIMIT) {
        const oldest = cachedKeys.keys().next().value;
        if (oldest !== undefined) cachedKeys.delete(oldest);
      }
      cachedKeys.set(kid, { key, expiresAt: now() + KEY_CACHE_MS });
      return key;
    } finally {
      pendingKeys.delete(kid);
    }
  }

  return async function readAlbIdentity(headers: Headers): Promise<AlbIdentity | null> {
    const token = headers.get('x-amzn-oidc-data');
    if (!token || token.length > ALB_TOKEN_MAX_LENGTH) return null;
    const segments = token.split('.');
    if (segments.length !== 3 || segments.some((segment) => !BASE64URL.test(segment))) return null;
    const [encodedHeader, encodedClaims, encodedSignature] = segments;
    try {
      const header = decodeObject(encodedHeader);
      const signature = decodeSegment(encodedSignature);
      if (!header || header.alg !== 'ES256' || header.signer !== signerArn || header.client !== clientId
        || header.iss !== issuer || typeof header.kid !== 'string' || !AWS_KEY_ID.test(header.kid)
        || signature.length !== 64) {
        return null;
      }
      const expiresAt = readExpiration(header.exp);
      if (expiresAt === null || expiresAt <= now()) return null;

      const key = await getKey(header.kid);
      const signedInput = Buffer.from(`${encodedHeader}.${encodedClaims}`, 'ascii');
      if (!verify('sha256', signedInput, { key, dsaEncoding: 'ieee-p1363' }, signature)
        || expiresAt <= now()) {
        return null;
      }
      const claims = decodeObject(encodedClaims);
      if (!claims || typeof claims.sub !== 'string' || !/^[\x21-\x7e]{1,255}$/u.test(claims.sub)
        || typeof claims.email !== 'string' || (claims.email_verified !== true && claims.email_verified !== 'true')) {
        return null;
      }
      const email = claims.email.trim().toLowerCase();
      if (!/^[^\s@,\x00-\x1f\x7f]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/u.test(email) || email.length > 254) return null;
      const displayName = typeof claims.name === 'string' ? claims.name.trim().slice(0, 160) : '';
      // Scope the stable provider subject to its issuer, so another IdP cannot reuse it.
      const subject = createHash('sha256').update(issuer).update('\0').update(claims.sub).digest('base64url');
      return { id: `aws-alb:${subject}`, email, displayName: displayName || email.split('@')[0] };
    } catch {
      return null;
    }
  };
}

function validateIssuer(issuer: string) {
  try {
    const url = new URL(issuer);
    if (issuer.trim() === issuer && url.protocol === 'https:' && !url.username && !url.password
      && !url.search && !url.hash) return;
  } catch {
    // Invalid URLs receive the same configuration error.
  }
  throw new Error('ERP_AWS_OIDC_ISSUER must be an HTTPS issuer URL');
}

function readExpiration(value: unknown) {
  const seconds = typeof value === 'string' && /^\d{1,12}$/u.test(value) ? Number(value) : value;
  if (typeof seconds !== 'number' || !Number.isSafeInteger(seconds) || seconds <= 0
    || !Number.isSafeInteger(seconds * 1000)) return null;
  return seconds * 1000;
}

function decodeSegment(segment: string) {
  const bytes = Buffer.from(segment, 'base64url');
  const unpadded = bytes.toString('base64url');
  const padding = '='.repeat((4 - unpadded.length % 4) % 4);
  if (segment !== unpadded && segment !== unpadded + padding) throw new Error('Invalid base64url segment');
  return bytes;
}

function decodeObject(segment: string): Record<string, unknown> | null {
  const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decodeSegment(segment)));
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
}

async function fetchPublicKey(fetchKey: typeof fetch, keyUrl: string) {
  const response = await fetchKey(keyUrl, { redirect: 'error', signal: AbortSignal.timeout(3000) });
  if (!response.ok || !response.body) throw new Error('AWS ALB public key unavailable');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > KEY_RESPONSE_MAX_BYTES) {
        await reader.cancel();
        throw new Error('AWS ALB public key response is too large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const key = createPublicKey(Buffer.concat(chunks).toString('utf8'));
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new Error('AWS ALB public key is not P-256');
  }
  return key;
}
