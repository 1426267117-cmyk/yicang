import { execFile } from 'node:child_process';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

if (process.env.ERP_FEISHU_MODE !== 'continuous') process.exit(0);

const run = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const stateDir = process.env.ERP_FEISHU_SYNC_STATE_DIR ?? join(root, '.wrangler', 'feishu-procurement-sync');
const config = process.env.ERP_FEISHU_SYNC_SOURCE_CONFIG ?? join(root, 'outputs', 'feishu-procurement-preview', 'sync-config.json');
const collector = join(root, 'scripts', 'sync-feishu-procurement-snapshot.py');
const orderConfig = process.env.ERP_FEISHU_ORDERS_SOURCE_CONFIG;
const orderCollector = join(root, 'scripts', 'sync-feishu-nine-store-orders.py');
const token = process.env.ERP_FEISHU_SYNC_WORKER_TOKEN;
const origin = new URL(process.argv[2]);
if (!isAbsolute(stateDir) || !isAbsolute(config)
  || origin.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(origin.hostname)
  || origin.href !== `${origin.origin}/` || !/^[A-Za-z0-9_-]{32,128}$/.test(token ?? '')) {
  throw new Error('本机飞书采购同步配置无效');
}

const endpoint = new URL('/api/purchase/feishu-preview/worker', origin);
const orderEndpoint = new URL('/api/purchase/feishu-preview/worker/orders', origin);
const shutdown = new AbortController();
process.on('disconnect', () => shutdown.abort());
process.on('SIGINT', () => shutdown.abort());
process.on('SIGTERM', () => shutdown.abort());
await mkdir(stateDir, { recursive: true });
const orderWorker = orderConfig && isAbsolute(orderConfig) ? runOrderFeed(orderConfig) : null;

while (!shutdown.signal.aborted) {
  try {
    const { claim } = await workerRequest({ action: 'claim' });
    if (claim && /^[0-9a-f-]{36}$/i.test(claim.id)) await synchronize(claim.id);
  } catch {
    // A restart or a pending migration can temporarily make the local endpoint unavailable.
  }
  await delay(5_000, undefined, { signal: shutdown.signal }).catch(() => undefined);
}
await orderWorker;

async function runOrderFeed(sourceConfig) {
  let retriedSourceChange = false;
  const statusPath = join(stateDir, 'orders-status.json');
  const statusCandidate = join(stateDir, `orders-status-${process.pid}.tmp`);
  while (!shutdown.signal.aborted) {
    const observed = Date.now();
    const candidate = join(stateDir, `orders-${process.pid}.json`);
    let retryAfterChange = false;
    let result;
    try {
      const collectorEnv = { ...process.env };
      delete collectorEnv.ERP_FEISHU_SYNC_WORKER_TOKEN;
      await run(process.platform === 'win32' ? 'python' : 'python3', [
        '-B', orderCollector, '--config', sourceConfig, '--output', candidate,
      ], { cwd: root, env: collectorEnv, maxBuffer: 256 * 1024, signal: shutdown.signal, timeout: 240_000, windowsHide: true });
      const source = await stat(candidate);
      if (!source.isFile() || source.size > 2_500_000) throw new Error('NINE_STORE_SNAPSHOT_TOO_LARGE');
      const response = await fetch(orderEndpoint, {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: await readFile(candidate), redirect: 'error', signal: AbortSignal.timeout(60_000),
      });
      const reply = await response.json().catch(() => null);
      if (response.ok && reply?.ok === true && typeof reply.observedAt === 'string') {
        result = { ok: true, observedAt: reply.observedAt };
      } else {
        const code = safeOrderFailureCode(reply?.code) ?? 'NINE_STORE_IMPORT_FAILED';
        result = { ok: false, code, status: response.status };
        console.warn(`九店订单快照未更新（${code}），保留上一轮已校验数据。`);
      }
    } catch (error) {
      if (!shutdown.signal.aborted) {
        let collectorReply;
        if (typeof error?.stdout === 'string') {
          try { collectorReply = JSON.parse(error.stdout); } catch { /* Collector stdout is not used as a log. */ }
        }
        const code = safeOrderFailureCode(collectorReply?.code) ?? safeOrderFailureCode(error?.message) ?? 'NINE_STORE_COLLECTION_FAILED';
        retryAfterChange = code === 'NINE_STORE_SOURCE_REVISION_CHANGED' && !retriedSourceChange;
        result = { ok: false, code };
        console.warn(`九店订单快照未更新（${code}），保留上一轮已校验数据。`);
      }
    } finally {
      await unlink(candidate).catch(() => undefined);
    }
    if (result) {
      try {
        await writeFile(statusCandidate, JSON.stringify({ ...result, finishedAt: new Date().toISOString() }), { mode: 0o600 });
        await rename(statusCandidate, statusPath);
      } catch {
        console.warn('无法记录九店订单后台同步状态。');
      } finally {
        await unlink(statusCandidate).catch(() => undefined);
      }
    }
    retriedSourceChange = retryAfterChange;
    const nextDelay = retryAfterChange ? 30_000 : Math.max(5_000, 300_000 - (Date.now() - observed));
    await delay(nextDelay, undefined, { signal: shutdown.signal }).catch(() => undefined);
  }
}

function safeOrderFailureCode(code) {
  return typeof code === 'string' && /^NINE_STORE_[A-Z0-9_]{1,64}$/.test(code) ? code : null;
}

async function synchronize(id) {
  const candidate = join(stateDir, `candidate-${id}.json`);
  let errorCode = 'SOURCE_FAILED';
  try {
    const collectorEnv = { ...process.env };
    delete collectorEnv.ERP_FEISHU_SYNC_WORKER_TOKEN;
    try {
      await run(process.platform === 'win32' ? 'python' : 'python3', [
        '-B', collector, '--config', config, '--output', candidate,
      ], {
        cwd: root,
        env: collectorEnv,
        maxBuffer: 512 * 1024,
        signal: shutdown.signal,
        timeout: 240_000,
        windowsHide: true,
      });
    } catch (error) {
      errorCode = shutdown.signal.aborted ? 'WORKER_STOPPED'
        : error?.killed ? 'SOURCE_TIMEOUT' : 'SOURCE_FAILED';
      throw error;
    }
    errorCode = 'INVALID_SNAPSHOT';
    const metadata = await stat(candidate);
    if (!metadata.isFile() || metadata.size > 768 * 1024) throw new Error('快照大小不符合要求');
    const snapshot = JSON.parse(await readFile(candidate, 'utf8'));
    errorCode = 'SOURCE_FAILED';
    await workerRequest({ action: 'complete', id, snapshot });
  } catch (error) {
    if (error?.status === 400 || error?.status === 413) errorCode = 'INVALID_SNAPSHOT';
    await workerRequest({ action: 'fail', id, error: errorCode }).catch(() => undefined);
  } finally {
    await unlink(candidate).catch(() => undefined);
  }
}

async function workerRequest(body) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    const error = new Error('本机飞书采购同步请求失败');
    error.status = response.status;
    throw error;
  }
  const result = await response.json();
  if (!result.ok) throw new Error('本机飞书采购同步请求失败');
  return result;
}
