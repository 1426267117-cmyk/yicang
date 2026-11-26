import { pathToFileURL } from 'node:url';
import { countOrderJobValue as count, postLocalConnectorJob } from './local-connector-order-job.mjs';

const jobs = {
  webhook: { path: '/api/connectors/shopify/webhooks/process', body: { maxEvents: 10 }, timeout: 180_000 },
  reconcile: { path: '/api/connectors/shopify/reconcile', body: { maxPages: 100 }, timeout: 540_000 },
};

export async function runShopifyOrderJob(kind, origin, token, request = fetch) {
  const job = Object.hasOwn(jobs, kind) ? jobs[kind] : undefined;
  if (!job) return { ok: false, code: 'SHOPIFY_JOB_CONFIGURATION_INVALID' };
  const { error, status, result } = await postLocalConnectorJob({ origin, token, request, ...job });
  if (error === 'configuration') return { ok: false, code: 'SHOPIFY_JOB_CONFIGURATION_INVALID' };
  if (error) return { ok: false, job: kind, code: 'SHOPIFY_JOB_TRANSPORT_FAILED' };
  if (kind === 'webhook' && status === 200 && result?.ok === true && result.stats && typeof result.stats === 'object') {
    const stats = result.stats;
    return { ok: true, job: kind, processed: count(stats?.processed), retrying: count(stats?.retried), failed: count(stats?.failed) };
  }
  if (kind === 'reconcile') {
    if (status === 422 && result?.noConfiguredStores === true && result.skipReason === 'SHOPIFY_NO_CONFIGURED_STORES') {
      return { ok: true, job: kind, skipped: 'SHOPIFY_NO_CONFIGURED_STORES' };
    }
    if ((status === 200 || status === 207) && Array.isArray(result?.synced) && Array.isArray(result.failed)) {
      return {
        ok: status === 200 && result.ok === true, job: kind,
        syncedStores: result.synced.length, failedStores: result.failed.length,
        initialImportRequired: result.failed.filter((failure) => failure?.code === 'SHOPIFY_INITIAL_RANGE_REQUIRED').length,
        insertedOrders: result.synced.reduce((sum, store) => sum + count(store?.ordersInserted), 0),
        updatedOrders: result.synced.reduce((sum, store) => sum + count(store?.ordersUpdated), 0),
      };
    }
  }
  return { ok: false, job: kind, status, code: 'SHOPIFY_JOB_ENDPOINT_FAILED' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await runShopifyOrderJob(process.argv[2], process.argv[3], process.env.ERP_INTERNAL_JOB_TOKEN);
  console.log(JSON.stringify(result));
  process.exitCode = result.ok ? 0 : 1;
}
