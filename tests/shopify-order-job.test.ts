import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { runShopifyOrderJob } from '../scripts/run-shopify-order-job.mjs';

const token = 'isolated-test-internal-job-token-long-enough';

describe('Shopify order scheduler transport', () => {
  it('runs the protected webhook batch on loopback and emits only processing counts', async () => {
    const received: { path?: string; auth?: string; body?: string } = {};
    const server = createServer(async (request, response) => {
      received.path = request.url;
      received.auth = request.headers.authorization;
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      received.body = Buffer.concat(chunks).toString('utf8');
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ ok: true, stats: { processed: 2, retried: 1, failed: 0 }, internal: 'must not appear in results' }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const result = await runShopifyOrderJob('webhook', `http://127.0.0.1:${port}`, token);
      expect(received).toEqual({ path: '/api/connectors/shopify/webhooks/process', auth: `Bearer ${token}`, body: '{"maxEvents":10}' });
      expect(result).toEqual({ ok: true, job: 'webhook', processed: 2, retrying: 1, failed: 0 });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('distinguishes partial reconciliation, first import requirements, and unconfigured workspaces', async () => {
    const url = 'http://127.0.0.1:3000';
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({
      ok: false, synced: [{ ordersInserted: 3, ordersUpdated: 4 }],
      failed: [{ code: 'SHOPIFY_INITIAL_RANGE_REQUIRED' }, { code: 'OTHER_STORE_FAILURE' }],
    }, { status: 207 })).mockResolvedValueOnce(Response.json({
      ok: false, noConfiguredStores: true, skipReason: 'SHOPIFY_NO_CONFIGURED_STORES',
    }, { status: 422 }));
    await expect(runShopifyOrderJob('reconcile', url, token, request)).resolves.toEqual({
      ok: false, job: 'reconcile', syncedStores: 1, failedStores: 2, initialImportRequired: 1, insertedOrders: 3, updatedOrders: 4,
    });
    expect(request.mock.calls[0]).toEqual([new URL('/api/connectors/shopify/reconcile', url), expect.objectContaining({
      method: 'POST', body: '{"maxPages":100}', redirect: 'error',
    })]);
    await expect(runShopifyOrderJob('reconcile', url, token, request)).resolves.toEqual({
      ok: true, job: 'reconcile', skipped: 'SHOPIFY_NO_CONFIGURED_STORES',
    });
  });

  it('rejects remote hosts and avoids printing upstream error bodies', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ message: `private ${token}` }, { status: 401 }));
    await expect(runShopifyOrderJob('webhook', 'https://example.com', token, request)).resolves.toEqual({
      ok: false, code: 'SHOPIFY_JOB_CONFIGURATION_INVALID',
    });
    expect(request).not.toHaveBeenCalled();
    await expect(runShopifyOrderJob('webhook', 'http://127.0.0.1', token, request)).resolves.toEqual({
      ok: false, job: 'webhook', status: 401, code: 'SHOPIFY_JOB_ENDPOINT_FAILED',
    });
  });
});
