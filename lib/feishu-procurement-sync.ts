import {
  feishuProcurementPreviewInsertValues,
  type FeishuProcurementPreview,
} from './feishu-procurement-preview-contract';

export const FEISHU_SYNC_TENANT_ID = 'tenant_yicang_primary';
export const FEISHU_SYNC_ERROR_CODES = [
  'SOURCE_FAILED', 'SOURCE_TIMEOUT', 'INVALID_SNAPSHOT', 'WORKER_STOPPED',
] as const;
type SyncError = typeof FEISHU_SYNC_ERROR_CODES[number];

const syncErrorMessage: Record<SyncError, string> = {
  SOURCE_FAILED: '读取飞书数据失败',
  SOURCE_TIMEOUT: '同步超时',
  INVALID_SNAPSHOT: '来源数据未通过校验',
  WORKER_STOPPED: '同步任务已中止',
};

const intervalMs = 5 * 60 * 1000;
const leaseMs = 270 * 1000;

type State = {
  queued: number;
  lease_expires_at: string | null;
  last_attempt_at: string | null;
  last_success_at: string | null;
  last_error: SyncError | null;
};

type SyncRuntime = Record<string, unknown>;

export function isContinuousFeishuMode(runtime: SyncRuntime) {
  return runtime.ERP_FEISHU_MODE === 'continuous';
}

function configuredWorkerToken(runtime: SyncRuntime) {
  if (!isContinuousFeishuMode(runtime)) return null;
  const enabled = runtime.ERP_HOST_RUNTIME === 'aws'
    ? runtime.ERP_FEISHU_SYNC_AWS_ENABLED === 'true' && awsWorkerOrigin(runtime) !== null
    : runtime.ERP_FEISHU_SYNC_ENABLED === 'true';
  if (!enabled) return null;
  const token = runtime.ERP_FEISHU_SYNC_WORKER_TOKEN;
  return typeof token === 'string' && /^[A-Za-z0-9_-]{32,128}$/u.test(token) ? token : null;
}

export function feishuSyncBrowserOrigin(request: Request, runtime: SyncRuntime) {
  if (!configuredWorkerToken(runtime)) return null;
  const url = new URL(request.url);
  if (runtime.ERP_HOST_RUNTIME !== 'aws') return isDevelopmentLoopback(url) ? url.origin : null;
  const publicOrigin = runtime.ERP_PUBLIC_ORIGIN;
  if (typeof publicOrigin !== 'string') return null;
  const expected = URL.parse(publicOrigin);
  // The AWS proxy terminates HTTPS. Vinext can see an HTTP request URL while
  // the browser's exact public Origin is still HTTPS.
  return expected?.protocol === 'https:' && expected.origin === publicOrigin && expected.host === url.host
    ? expected.origin
    : null;
}

export function feishuSyncWorkerToken(request: Request, runtime: SyncRuntime) {
  const token = configuredWorkerToken(runtime);
  if (!token) return null;
  const url = new URL(request.url);
  if (runtime.ERP_HOST_RUNTIME !== 'aws') return isDevelopmentLoopback(url) ? token : null;
  if (url.origin !== awsWorkerOrigin(runtime)) return null;
  for (const name of request.headers.keys()) {
    if (name === 'origin' || name === 'forwarded' || name.startsWith('x-forwarded-')) return null;
  }
  return token;
}

function awsWorkerOrigin(runtime: SyncRuntime) {
  const host = runtime.HOST === '::1' ? '[::1]' : runtime.HOST;
  if (host !== '127.0.0.1' && host !== '[::1]') return null;
  const port = Number(runtime.PORT ?? '3000');
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return new URL(`http://${host}:${port}`).origin;
}

function isDevelopmentLoopback(url: URL) {
  return ['http:', 'https:'].includes(url.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}

export async function getFeishuSyncStatus(
  db: D1Database,
  canManage: boolean,
  snapshotImportedAt: string | null,
  now = new Date(),
) {
  const state = await db.prepare(`
    SELECT queued, lease_expires_at, last_attempt_at, last_success_at, last_error
    FROM feishu_procurement_sync_state WHERE tenant_id = ?
  `).bind(FEISHU_SYNC_TENANT_ID).first<State>();
  const active = Boolean(state?.lease_expires_at && state.lease_expires_at > now.toISOString());
  const expired = Boolean(state?.lease_expires_at && !active);
  const errorCode = expired ? 'SOURCE_TIMEOUT' : state?.last_error;
  const busy = Boolean(state?.queued) || active;
  const status = busy ? 'running' : errorCode ? 'failed' : state?.last_success_at ? 'success' : 'idle';
  return {
    enabled: true,
    status,
    lastAttemptAt: state?.last_attempt_at ?? null,
    lastSuccessAt: state?.last_success_at ?? null,
    snapshotImportedAt,
    error: !busy && errorCode ? syncErrorMessage[errorCode] : null,
    canTrigger: canManage,
  };
}

export async function queueFeishuSync(db: D1Database, now = new Date()) {
  const { meta } = await db.prepare(`
    INSERT INTO feishu_procurement_sync_state (tenant_id, queued)
    VALUES (?, 1)
    ON CONFLICT (tenant_id) DO UPDATE SET queued = 1
    WHERE feishu_procurement_sync_state.queued = 0
      AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
  `).bind(FEISHU_SYNC_TENANT_ID, now.toISOString()).run();
  return Number(meta.changes) === 1;
}

export async function claimFeishuSync(db: D1Database, now = new Date()) {
  const id = crypto.randomUUID();
  const started = now.toISOString();
  const expires = new Date(now.getTime() + leaseMs).toISOString();
  const due = new Date(now.getTime() - intervalMs).toISOString();
  const { meta } = await db.prepare(`
    INSERT INTO feishu_procurement_sync_state (tenant_id, queued, lease_id, lease_expires_at, last_attempt_at)
    SELECT ?, 0, ?, ?, ?
    WHERE EXISTS (SELECT 1 FROM tenants WHERE id = ?)
    ON CONFLICT (tenant_id) DO UPDATE SET
      queued = 0, lease_id = excluded.lease_id,
      lease_expires_at = excluded.lease_expires_at, last_attempt_at = excluded.last_attempt_at
    WHERE (feishu_procurement_sync_state.lease_expires_at IS NULL
           OR feishu_procurement_sync_state.lease_expires_at <= excluded.last_attempt_at)
      AND (feishu_procurement_sync_state.queued = 1
           OR feishu_procurement_sync_state.last_attempt_at IS NULL
           OR feishu_procurement_sync_state.last_attempt_at <= ?)
  `).bind(FEISHU_SYNC_TENANT_ID, id, expires, started, FEISHU_SYNC_TENANT_ID, due).run();
  return Number(meta.changes) === 1 ? { id } : null;
}

export async function completeFeishuSync(db: D1Database, id: string, snapshot: FeishuProcurementPreview) {
  const values = await feishuProcurementPreviewInsertValues(FEISHU_SYNC_TENANT_ID, 'feishu-sync', snapshot);
  const now = new Date().toISOString();
  const [insert, finish] = await db.batch([
    db.prepare(`
      INSERT INTO feishu_procurement_previews
        (tenant_id, snapshot_date, payload_hash, payload_json, imported_by, imported_at)
      SELECT ?, ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM feishu_procurement_sync_state
        WHERE tenant_id = ? AND lease_id = ? AND lease_expires_at > ?
      )
      ON CONFLICT (tenant_id, payload_hash) DO NOTHING
    `).bind(...values, FEISHU_SYNC_TENANT_ID, id, now),
    db.prepare(`
      UPDATE feishu_procurement_sync_state
      SET lease_id = NULL, lease_expires_at = NULL, last_success_at = ?, last_error = NULL
      WHERE tenant_id = ? AND lease_id = ? AND lease_expires_at > ?
    `).bind(now, FEISHU_SYNC_TENANT_ID, id, now),
  ]);
  return Number(finish.meta.changes) === 1
    ? { replayed: Number(insert.meta.changes) === 0 }
    : null;
}

export async function failFeishuSync(db: D1Database, id: string, error: SyncError) {
  const { meta } = await db.prepare(`
    UPDATE feishu_procurement_sync_state
    SET lease_id = NULL, lease_expires_at = NULL, last_error = ?
    WHERE tenant_id = ? AND lease_id = ? AND lease_expires_at > ?
  `).bind(error, FEISHU_SYNC_TENANT_ID, id, new Date().toISOString()).run();
  return Number(meta.changes) === 1;
}
