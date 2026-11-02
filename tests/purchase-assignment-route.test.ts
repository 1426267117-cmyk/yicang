import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requestContext: vi.fn(),
  reassign: vi.fn(),
}));

vi.mock('cloudflare:workers', () => ({ env: {} }));
vi.mock('../lib/db', () => {
  class HttpError extends Error {
    constructor(public status: number, message: string, public code: string) {
      super(message);
    }
  }
  return {
    HttpError,
    requestContext: mocks.requestContext,
    jsonError: (error: unknown) => {
      const failure = error as { status?: number; code?: string; message?: string };
      return Response.json({ ok: false, code: failure.code, message: failure.message }, {
        status: failure.status ?? 500,
      });
    },
  };
});
vi.mock('../lib/purchase-assignment-service', () => ({
  reassignPurchaseRequest: mocks.reassign,
}));

import { POST } from '../app/api/purchase/requests/[id]/assignment/route';

describe('采购重新指派路由', () => {
  beforeEach(() => {
    mocks.requestContext.mockReset();
    mocks.reassign.mockReset();
    mocks.requestContext.mockResolvedValue({
      db: { marker: 'db' },
      user: { tenantId: 'tenant-route', permissions: ['members:manage'] },
    });
    mocks.reassign.mockResolvedValue({ assignment: { requestId: 'request-route' }, replayed: false });
  });

  it('把版本、原因和幂等键交给受控交接服务', async () => {
    const request = new Request('https://erp.example/api/purchase/requests/request-route/assignment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'route-assignment-key' },
      body: JSON.stringify({
        purchaserMemberId: 'buyer-next',
        reviewerMemberId: 'reviewer-next',
        reason: '值班交接',
        expectedVersion: 7,
      }),
    });
    const response = await POST(request, { params: Promise.resolve({ id: 'request-route' }) });

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(mocks.reassign).toHaveBeenCalledWith(
      { marker: 'db' },
      expect.objectContaining({ tenantId: 'tenant-route' }),
      'request-route',
      {
        purchaserMemberId: 'buyer-next',
        reviewerMemberId: 'reviewer-next',
        reason: '值班交接',
        expectedVersion: 7,
      },
      'route-assignment-key',
      { developmentOpenAccess: false },
    );
  });

  it('原因不足两字时在路由层拒绝', async () => {
    const request = new Request('https://erp.example/api/purchase/requests/request-route/assignment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'route-invalid-key' },
      body: JSON.stringify({
        purchaserMemberId: 'buyer-next',
        reviewerMemberId: 'reviewer-next',
        reason: '换',
        expectedVersion: 7,
      }),
    });
    const response = await POST(request, { params: Promise.resolve({ id: 'request-route' }) });
    const body = await response.json() as { code: string };

    expect(response.status).toBe(400);
    expect(body.code).toBe('INVALID_PURCHASE_ASSIGNMENT');
    expect(mocks.reassign).not.toHaveBeenCalled();
  });
});
