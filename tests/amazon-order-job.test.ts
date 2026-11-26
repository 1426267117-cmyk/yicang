import { describe, expect, it, vi } from 'vitest';
import { runAmazonOrderJob } from '../scripts/run-amazon-order-job.mjs';

const token = 'fixture-token-long-enough-for-dedicated-internal-job';

describe('Lightsail Amazon reconcile runner', () => {
  it('posts only to the local endpoint and emits aggregate outcomes', async () => {
    const request = vi.fn(async () => Response.json({
      ok: false,
      results: [
        { storeKey: 'amazon-senyu', ok: true, complete: true, stats: { ordersInserted: 7, ordersUpdated: 3 } },
        { storeKey: 'amazon-kaguyasu', ok: true, complete: false, stats: { ordersInserted: 4, ordersUpdated: 2 } },
        { storeKey: 'amazon-genji', ok: false, code: 'AMAZON_INITIAL_RANGE_REQUIRED' },
        { storeKey: 'amazon-zhongcheng', ok: false, code: 'AMAZON_RATE_LIMITED', secret: token },
      ],
    }, { status: 207 }));
    const result = await runAmazonOrderJob('http://127.0.0.1:3000', token, request as typeof fetch);
    expect(result).toEqual({
      ok: false, completedStores: 1, pausedStores: 1, setupRequiredStores: 1,
      failedStores: 1, insertedOrders: 11, updatedOrders: 5,
    });
    expect(request).toHaveBeenCalledWith(new URL('http://127.0.0.1:3000/api/connectors/amazon/reconcile'), expect.objectContaining({
      method: 'POST', redirect: 'error', headers: expect.objectContaining({ Authorization: `Bearer ${token}` }),
    }));
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it('rejects other hosts, and the explicitly disabled endpoint is an observable skip', async () => {
    const request = vi.fn(async () => Response.json({ code: 'AMAZON_RECONCILE_DISABLED' }, { status: 409 }));
    expect(await runAmazonOrderJob('https://example.invalid', token, request as typeof fetch))
      .toEqual({ ok: false, code: 'AMAZON_JOB_CONFIGURATION_INVALID' });
    expect(request).not.toHaveBeenCalled();
    expect(await runAmazonOrderJob('http://127.0.0.1:3000', token, request as typeof fetch))
      .toEqual({ ok: true, skipped: 'AMAZON_RECONCILE_DISABLED' });
  });
});
