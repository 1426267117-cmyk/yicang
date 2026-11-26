import { pathToFileURL } from 'node:url';
import { countOrderJobValue as count, postLocalConnectorJob } from './local-connector-order-job.mjs';

const stores = new Set(['zimasya', 'kaguyasu', 'anzhap', 'bizfurniz']);

export async function runShopifyInventoryMirrorJob(storeKey, origin, token, request = fetch) {
  if (!stores.has(storeKey)) return { ok: false, code: 'SHOPIFY_MIRROR_JOB_CONFIGURATION_INVALID' };
  const { error, status, result } = await postLocalConnectorJob({
    origin, token, request, path: '/api/connectors/shopify/inventory-mirror/run', body: { storeKey }, timeout: 240_000,
  });
  if (error) return { ok: false, storeKey, code: error === 'configuration' ? 'SHOPIFY_MIRROR_JOB_CONFIGURATION_INVALID' : 'SHOPIFY_MIRROR_JOB_TRANSPORT_FAILED' };
  if (![200, 207, 409].includes(status) || result?.storeKey !== storeKey || typeof result.ok !== 'boolean') {
    return { ok: false, storeKey, status, code: 'SHOPIFY_MIRROR_JOB_ENDPOINT_FAILED' };
  }
  return { ok: status === 200 && result.ok, storeKey, lookedUp: count(result.lookedUp), verified: count(result.verified),
    notFound: count(result.notFound), ambiguous: count(result.ambiguous), untracked: count(result.untracked), unavailable: count(result.unavailable),
    finishedCycle: result.finishedCycle === true, code: /^SHOPIFY_[A-Z0-9_]{1,80}$/u.test(result.code ?? '') ? result.code : null };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await runShopifyInventoryMirrorJob(process.argv[2], process.argv[3], process.env.ERP_INTERNAL_JOB_TOKEN);
  console.log(JSON.stringify(result));
  process.exitCode = result.ok ? 0 : 1;
}
