import { pathToFileURL } from 'node:url';
import { countOrderJobValue as count, postLocalConnectorJob } from './local-connector-order-job.mjs';

export async function runAmazonOrderJob(origin, token, request = fetch) {
  const { error, status, result } = await postLocalConnectorJob({
    origin, token, request, path: '/api/connectors/amazon/reconcile', body: {}, timeout: 540_000,
  });
  if (error === 'configuration') return { ok: false, code: 'AMAZON_JOB_CONFIGURATION_INVALID' };
  if (error) return { ok: false, code: 'AMAZON_JOB_TRANSPORT_FAILED' };
  if (status === 409 && result?.code === 'AMAZON_RECONCILE_DISABLED') {
    return { ok: true, skipped: 'AMAZON_RECONCILE_DISABLED' };
  }
  if ((status !== 200 && status !== 207) || !Array.isArray(result?.results)) {
    return { ok: false, status, code: 'AMAZON_JOB_ENDPOINT_FAILED' };
  }
  const completed = result.results.filter((row) => row?.ok === true && row.complete === true).length;
  const paused = result.results.filter((row) => row?.ok === true && row.complete === false).length;
  const initialRangeRequired = result.results.filter((row) => row?.code === 'AMAZON_INITIAL_RANGE_REQUIRED').length;
  const failed = result.results.length - completed - paused - initialRangeRequired;
  return {
    ok: failed === 0,
    completedStores: completed, pausedStores: paused, setupRequiredStores: initialRangeRequired, failedStores: failed,
    insertedOrders: result.results.reduce((sum, row) => sum + count(row?.stats?.ordersInserted), 0),
    updatedOrders: result.results.reduce((sum, row) => sum + count(row?.stats?.ordersUpdated), 0),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await runAmazonOrderJob(process.argv[2], process.env.ERP_INTERNAL_JOB_TOKEN);
  console.log(JSON.stringify(result));
  process.exitCode = result.ok ? 0 : 1;
}
