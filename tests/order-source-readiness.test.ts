import { describe, expect, it } from 'vitest';
import { evaluateOrderSourceReadiness } from '../lib/order-source-readiness';

const checkedAt = '2026-11-02T10:00:00.000Z';

describe('shared official order source readiness', () => {
  it('uses the same official, identity and freshness gate for procurement and MCP', () => {
    expect(evaluateOrderSourceReadiness(source(), {
      checkedAt,
      maxAgeMinutes: 30,
    })).toEqual({
      official: true,
      ready: true,
      identityVerified: true,
      lastSuccessAt: '2026-11-02T09:50:00.000Z',
      ageMinutes: 10,
      reasons: [],
    });
  });

  it('excludes local QA and rejects every future success timestamp', () => {
    expect(evaluateOrderSourceReadiness(source({
      credentialRef: 'local:qa',
      connectorKey: 'local_qa',
      lastSuccessfulSyncAt: '2099-01-01T00:00:00.000Z',
    }), { checkedAt, maxAgeMinutes: 30 })).toMatchObject({
      official: false,
      ready: false,
      reasons: ['local_qa_excluded'],
    });

    expect(evaluateOrderSourceReadiness(source({
      lastSuccessfulSyncAt: '2026-11-02T10:00:00.001Z',
    }), { checkedAt, maxAgeMinutes: 30 })).toMatchObject({
      official: true,
      ready: false,
      reasons: ['order_sync_time_in_future'],
    });
  });

  it('blocks missing or invalid identity verification and invalid success times', () => {
    expect(evaluateOrderSourceReadiness(source({
      identityVerifiedAt: 'invalid',
    }), { checkedAt, maxAgeMinutes: 30 })).toMatchObject({
      identityVerified: false,
      ready: false,
      reasons: ['identity_verification_invalid'],
    });

    expect(evaluateOrderSourceReadiness(source({
      lastSuccessfulSyncAt: 'invalid',
    }), { checkedAt, maxAgeMinutes: 30 })).toMatchObject({
      ready: false,
      lastSuccessAt: null,
      reasons: ['order_sync_time_invalid'],
    });
  });
});

function source(overrides: Partial<{
  credentialRef: string;
  connectorKey: string;
  identityVerifiedAt: string | null;
  lastSuccessfulSyncAt: string | null;
  syncLastSuccessAt: string | null;
  syncStatus: string | null;
}> = {}) {
  return {
    credentialRef: 'd1:shopify:bizfurniz',
    connectorKey: 'bizfurniz',
    identityVerifiedAt: '2026-11-02T09:00:00.000Z',
    lastSuccessfulSyncAt: '2026-11-02T09:50:00.000Z',
    syncLastSuccessAt: null,
    syncStatus: 'idle',
    ...overrides,
  };
}
