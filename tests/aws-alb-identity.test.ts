import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createAlbIdentityVerifier } from '../lib/aws/alb-identity';

const config = {
  signerArn: 'arn:aws:elasticloadbalancing:ap-southeast-1:123456789012:loadbalancer/app/yicang-gz/0123456789abcdef',
  clientId: 'yicang-gz-login',
  issuer: 'https://identity.example.com/yicang',
};
const keyId = '12345678-1234-1234-1234-123456789012';
const now = 1800000000000;
const expiration = now / 1000 + 60;
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const pem = publicKey.export({ format: 'pem', type: 'spki' }).toString();

function headerSegment(value: unknown) {
  const base64 = Buffer.from(JSON.stringify(value)).toString('base64');
  return base64.replaceAll('+', '-').replaceAll('/', '_');
}

function assertion(
  headerOverrides: Record<string, unknown> = {},
  claimOverrides: Record<string, unknown> = {},
  key: KeyObject = privateKey,
) {
  const header = headerSegment({
    alg: 'ES256', signer: config.signerArn, client: config.clientId, iss: config.issuer, kid: keyId,
    exp: expiration, ...headerOverrides,
  });
  const claims = headerSegment({
    sub: 'provider-user-42', email: 'Buyer@Example.Com', email_verified: 'true', name: '采购负责人',
    ...claimOverrides,
  });
  const signedInput = `${header}.${claims}`;
  const signature = sign('sha256', Buffer.from(signedInput), { key, dsaEncoding: 'ieee-p1363' })
    .toString('base64').replaceAll('+', '-').replaceAll('/', '_');
  return new Headers({ 'x-amzn-oidc-data': `${signedInput}.${signature}` });
}

describe('AWS ALB business login', () => {
  it('verifies padded ALB assertions, scopes the subject to the issuer, and reuses a public key', async () => {
    const fetchKey = vi.fn(async () => new Response(pem));
    const readIdentity = createAlbIdentityVerifier(config, { fetchKey, now: () => now });
    const [identity, renamed] = await Promise.all([
      readIdentity(assertion()),
      readIdentity(assertion({}, { email: 'other@example.com', email_verified: true, name: '' })),
    ]);
    expect(identity).toMatchObject({ email: 'buyer@example.com', displayName: '采购负责人' });
    expect(identity?.id).toMatch(/^aws-alb:/u);
    expect(renamed).toEqual({ id: identity?.id, email: 'other@example.com', displayName: 'other' });
    expect((await readIdentity(assertion({}, { sub: 'another-user' })))?.id).not.toBe(identity?.id);
    expect(fetchKey).toHaveBeenCalledExactlyOnceWith(
      `https://public-keys.auth.elb.ap-southeast-1.amazonaws.com/${keyId}`,
      { redirect: 'error', signal: expect.any(AbortSignal) },
    );
  });

  it('rejects spoofed claims, authentication headers from other providers, and unsigned headers', async () => {
    const fetchKey = vi.fn(async () => new Response(pem));
    const readIdentity = createAlbIdentityVerifier(config, { fetchKey, now: () => now });
    const wrongKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey;
    const unsigned = new Headers({
      'x-amzn-oidc-identity': 'provider-user-42',
      'oai-authenticated-user-id': 'provider-user-42',
      'oai-authenticated-user-email': 'owner@example.com',
    });
    const modified = assertion();
    const [header, , signature] = modified.get('x-amzn-oidc-data')!.split('.');
    modified.set('x-amzn-oidc-data', `${header}.${headerSegment({
      sub: 'provider-user-42', email: 'owner@example.com', email_verified: true,
    })}.${signature}`);
    for (const headers of [
      unsigned, modified, assertion({}, {}, wrongKey), assertion({}, { email_verified: false }),
      assertion({}, { email_verified: undefined }), assertion({}, { sub: '' }),
      assertion({}, { email: 'owner@example.com,other@example.com' }),
    ]) {
      await expect(readIdentity(headers)).resolves.toBeNull();
    }
  });

  it('rejects invalid metadata and expired assertions before contacting AWS', async () => {
    const fetchKey = vi.fn(async () => new Response(pem));
    const readIdentity = createAlbIdentityVerifier(config, { fetchKey, now: () => now });
    for (const patch of [
      { alg: 'none' }, { signer: config.signerArn.replace('yicang-gz', 'yicang-sz') },
      { client: 'other-client' }, { iss: 'https://other.example.com/yicang' }, { exp: now / 1000 },
      { exp: '1800000000e100' }, { exp: undefined }, { kid: '../elsewhere' },
    ]) {
      await expect(readIdentity(assertion(patch))).resolves.toBeNull();
    }
    expect(fetchKey).not.toHaveBeenCalled();
  });

  it('fails closed when a key is unavailable, while allowing a later successful lookup', async () => {
    const fetchKey = vi.fn<() => Promise<Response>>()
      .mockResolvedValueOnce(new Response('missing', { status: 404 }))
      .mockResolvedValueOnce(new Response('x'.repeat(5000)))
      .mockResolvedValueOnce(new Response(pem));
    const readIdentity = createAlbIdentityVerifier(config, { fetchKey, now: () => now });
    await expect(readIdentity(assertion())).resolves.toBeNull();
    await expect(readIdentity(assertion())).resolves.toBeNull();
    await expect(readIdentity(assertion())).resolves.toMatchObject({ email: 'buyer@example.com' });
  });

  it('refuses invalid startup configuration', () => {
    expect(() => createAlbIdentityVerifier({ ...config, signerArn: 'https://example.com/path' })).toThrow('ERP_AWS_ALB_ARN');
    expect(() => createAlbIdentityVerifier({ ...config, issuer: 'http://identity.example.com' })).toThrow('ERP_AWS_OIDC_ISSUER');
    expect(() => createAlbIdentityVerifier({ ...config, clientId: '' })).toThrow('ERP_AWS_OIDC_CLIENT_ID');
  });
});
