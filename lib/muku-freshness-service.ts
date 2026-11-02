import type { MukuDashboardClient } from './connectors/muku/client';
import type { MukuSyncDataset } from './muku-sync-service';
import { MUKU_SYNC_DATASETS, syncMukuDatasets } from './muku-sync-service';
import { ROLE_PERMISSIONS } from './domain';
import type { UserContext } from './db';

export const MUKU_PROCUREMENT_REQUIRED_DATASETS = ['inventory'] as const satisfies readonly MukuSyncDataset[];
export const DEFAULT_MUKU_FRESHNESS_MAX_AGE_MINUTES = 30;
export const DEFAULT_MUKU_AUTO_REFRESH_MIN_INTERVAL_MINUTES = 10;

type MukuClient = Pick<MukuDashboardClient, 'verifyManifest' | 'getAllPages'>;

type DatasetStateRow = {
  dataset: string;
  active_snapshot_id: string | null;
  status: string;
  generated_at: string | null;
  last_success_at: string | null;
  last_error_code: string | null;
  last_error_at: string | null;
  record_count: number | null;
  updated_at: string;
};

export type MukuFreshnessReason = {
  code:
    | 'MISSING_DATASET_STATE'
    | 'NO_ACTIVE_SNAPSHOT'
    | 'STATE_NOT_READY'
    | 'LAST_SYNC_FAILED'
    | 'SOURCE_TIME_UNKNOWN'
    | 'SOURCE_TIME_INVALID'
    | 'SOURCE_TOO_OLD'
    | 'ERP_SYNC_TIME_UNKNOWN'
    | 'ERP_SYNC_TIME_INVALID'
    | 'ERP_SYNC_TOO_OLD';
  dataset: MukuSyncDataset;
  message: string;
};

export type MukuDatasetFreshness = {
  dataset: MukuSyncDataset;
  requiredForProcurement: boolean;
  fresh: boolean;
  stateStatus: string | null;
  activeSnapshotId: string | null;
  generatedAt: string | null;
  lastSuccessAt: string | null;
  sourceAgeMinutes: number | null;
  erpSyncAgeMinutes: number | null;
  recordCount: number | null;
  lastErrorCode: string | null;
  lastErrorAt: string | null;
  reasons: MukuFreshnessReason[];
};

export type MukuFreshnessReport = {
  checkedAt: string;
  status: 'fresh' | 'refreshing' | 'stale' | 'missing';
  readyForProcurement: boolean;
  maxAgeMinutes: number;
  minRefreshIntervalMinutes: number;
  datasets: MukuDatasetFreshness[];
  blockingReasons: MukuFreshnessReason[];
  needsRefresh: boolean;
  refreshDue: boolean;
  refreshInProgress: boolean;
  lastAttemptAt: string | null;
  nextRefreshAt: string | null;
};

export function resolveMukuFreshnessOptions(runtimeEnv: Record<string, unknown>) {
  return {
    maxAgeMinutes: boundedEnvInteger(
      runtimeEnv.MUKU_FRESHNESS_MAX_AGE_MINUTES,
      DEFAULT_MUKU_FRESHNESS_MAX_AGE_MINUTES,
      5,
      24 * 60,
    ),
    minRefreshIntervalMinutes: boundedEnvInteger(
      runtimeEnv.MUKU_AUTO_REFRESH_MIN_INTERVAL_MINUTES,
      DEFAULT_MUKU_AUTO_REFRESH_MIN_INTERVAL_MINUTES,
      1,
      24 * 60,
    ),
  };
}

export async function evaluateMukuFreshness(
  db: D1Database,
  tenantId: string,
  input: {
    runtimeEnv?: Record<string, unknown>;
    now?: Date;
    maxAgeMinutes?: number;
    minRefreshIntervalMinutes?: number;
  } = {},
): Promise<MukuFreshnessReport> {
  const now = input.now ?? new Date();
  const configured = resolveMukuFreshnessOptions(input.runtimeEnv ?? {});
  const maxAgeMinutes = input.maxAgeMinutes ?? configured.maxAgeMinutes;
  const minRefreshIntervalMinutes = input.minRefreshIntervalMinutes
    ?? configured.minRefreshIntervalMinutes;
  const [states, runState] = await Promise.all([
    db.prepare(`
      SELECT dataset, active_snapshot_id, status, generated_at, last_success_at,
             last_error_code, last_error_at, record_count, updated_at
      FROM muku_dataset_state
      WHERE tenant_id = ?
    `).bind(tenantId).all<DatasetStateRow>(),
    db.prepare(`
      SELECT MAX(started_at) AS last_attempt_at,
             SUM(CASE
               WHEN status = 'running' AND lease_expires_at > ? THEN 1
               ELSE 0
             END) AS running_count
      FROM muku_sync_runs
      WHERE tenant_id = ?
    `).bind(now.toISOString(), tenantId)
      .first<{ last_attempt_at: string | null; running_count: number | null }>(),
  ]);
  const byDataset = new Map(states.results.map((row) => [row.dataset, row]));
  const datasets = MUKU_SYNC_DATASETS.map((dataset) => datasetFreshness(
    dataset,
    byDataset.get(dataset) ?? null,
    now,
    maxAgeMinutes,
  ));
  const blockingReasons = datasets
    .filter((dataset) => dataset.requiredForProcurement)
    .flatMap((dataset) => dataset.reasons);
  const requiredRows = datasets.filter((dataset) => dataset.requiredForProcurement);
  const refreshInProgress = Number(runState?.running_count ?? 0) > 0;
  const lastAttemptAt = validTimestamp(runState?.last_attempt_at ?? null);
  const cooldownExpiresAt = lastAttemptAt
    ? new Date(Date.parse(lastAttemptAt) + minRefreshIntervalMinutes * 60_000)
    : null;
  const anyDatasetNeedsRefresh = datasets.some((dataset) => !dataset.fresh);
  const oldestSuccessfulSync = datasets
    .map((dataset) => validTimestamp(dataset.lastSuccessAt))
    .filter((value): value is string => value !== null)
    .map((value) => Date.parse(value))
    .sort((left, right) => left - right)[0] ?? null;
  const periodicRefreshDue = oldestSuccessfulSync === null
    || now.getTime() - oldestSuccessfulSync >= minRefreshIntervalMinutes * 60_000;
  const needsRefresh = anyDatasetNeedsRefresh || periodicRefreshDue;
  const cooldownComplete = cooldownExpiresAt === null || cooldownExpiresAt.getTime() <= now.getTime();
  const refreshDue = needsRefresh && !refreshInProgress && cooldownComplete;
  const missingRequired = requiredRows.some((dataset) => !dataset.activeSnapshotId);
  const refreshingRequired = requiredRows.some((dataset) => dataset.stateStatus === 'running');
  const readyForProcurement = requiredRows.length > 0 && requiredRows.every((dataset) => dataset.fresh);

  return {
    checkedAt: now.toISOString(),
    status: readyForProcurement
      ? (refreshingRequired ? 'refreshing' : 'fresh')
      : missingRequired
        ? 'missing'
        : refreshInProgress
          ? 'refreshing'
          : 'stale',
    readyForProcurement,
    maxAgeMinutes,
    minRefreshIntervalMinutes,
    datasets,
    blockingReasons,
    needsRefresh,
    refreshDue,
    refreshInProgress,
    lastAttemptAt,
    nextRefreshAt: refreshInProgress
      ? null
      : cooldownExpiresAt && cooldownExpiresAt.getTime() > now.getTime()
        ? cooldownExpiresAt.toISOString()
        : needsRefresh
          ? now.toISOString()
          : oldestSuccessfulSync === null
            ? now.toISOString()
            : new Date(oldestSuccessfulSync + minRefreshIntervalMinutes * 60_000).toISOString(),
  };
}

export async function refreshMukuIfDue(input: {
  db: D1Database;
  tenantId: string;
  tenantName?: string;
  client: MukuClient;
  runtimeEnv?: Record<string, unknown>;
  now?: Date;
  force?: boolean;
}) {
  const now = input.now ?? new Date();
  const before = await evaluateMukuFreshness(input.db, input.tenantId, {
    runtimeEnv: input.runtimeEnv,
    now,
  });
  if (before.refreshInProgress) {
    return { ok: true as const, attempted: false, skipReason: 'refresh_in_progress' as const, before };
  }
  if (!input.force && !before.refreshDue) {
    return {
      ok: true as const,
      attempted: false,
      skipReason: before.needsRefresh ? 'refresh_cooldown' as const : 'not_due' as const,
      before,
    };
  }

  const intervalMilliseconds = before.minRefreshIntervalMinutes * 60_000;
  const bucket = Math.floor(now.getTime() / intervalMilliseconds);
  const user = systemUser(input.tenantId, input.tenantName ?? input.tenantId);
  const sync = await syncMukuDatasets({
    db: input.db,
    user,
    client: input.client,
    datasets: [...MUKU_SYNC_DATASETS],
    idempotencyKey: `muku-auto-${bucket}`,
  });
  const after = await evaluateMukuFreshness(input.db, input.tenantId, {
    runtimeEnv: input.runtimeEnv,
    now: new Date(),
  });
  return { ok: sync.ok, attempted: true, skipReason: null, before, after, sync };
}

function datasetFreshness(
  dataset: MukuSyncDataset,
  row: DatasetStateRow | null,
  now: Date,
  maxAgeMinutes: number,
): MukuDatasetFreshness {
  const reasons: MukuFreshnessReason[] = [];
  const requiredForProcurement = (MUKU_PROCUREMENT_REQUIRED_DATASETS as readonly string[]).includes(dataset);
  if (!row) {
    reasons.push(reason('MISSING_DATASET_STATE', dataset, '尚未建立数据集状态'));
  } else {
    if (!row.active_snapshot_id) {
      reasons.push(reason('NO_ACTIVE_SNAPSHOT', dataset, '尚无有效快照'));
    }
    if (row.status === 'failed' || row.status === 'delayed') {
      reasons.push(reason('LAST_SYNC_FAILED', dataset, '最近同步失败或延迟，仍保留上一份有效快照'));
    } else if (row.status !== 'ready' && row.status !== 'running') {
      reasons.push(reason('STATE_NOT_READY', dataset, '数据集尚未进入可用状态'));
    }
  }

  const generatedAt = row?.generated_at ?? null;
  const lastSuccessAt = row?.last_success_at ?? null;
  const sourceAgeMinutes = ageMinutes(generatedAt, now);
  const erpSyncAgeMinutes = ageMinutes(lastSuccessAt, now);
  appendTimeReasons(reasons, dataset, 'source', generatedAt, sourceAgeMinutes, maxAgeMinutes);
  appendTimeReasons(reasons, dataset, 'erp', lastSuccessAt, erpSyncAgeMinutes, maxAgeMinutes);

  return {
    dataset,
    requiredForProcurement,
    fresh: reasons.length === 0,
    stateStatus: row?.status ?? null,
    activeSnapshotId: row?.active_snapshot_id ?? null,
    generatedAt,
    lastSuccessAt,
    sourceAgeMinutes,
    erpSyncAgeMinutes,
    recordCount: row?.record_count ?? null,
    lastErrorCode: row?.last_error_code ?? null,
    lastErrorAt: row?.last_error_at ?? null,
    reasons,
  };
}

function appendTimeReasons(
  reasons: MukuFreshnessReason[],
  dataset: MukuSyncDataset,
  kind: 'source' | 'erp',
  value: string | null,
  age: number | null,
  maxAgeMinutes: number,
) {
  if (!value) {
    reasons.push(reason(
      kind === 'source' ? 'SOURCE_TIME_UNKNOWN' : 'ERP_SYNC_TIME_UNKNOWN',
      dataset,
      kind === 'source' ? '上游生成时间未知' : 'ERP 最近成功同步时间未知',
    ));
    return;
  }
  if (age === null || age < -5) {
    reasons.push(reason(
      kind === 'source' ? 'SOURCE_TIME_INVALID' : 'ERP_SYNC_TIME_INVALID',
      dataset,
      kind === 'source' ? '上游生成时间无效' : 'ERP 最近成功同步时间无效',
    ));
    return;
  }
  if (age > maxAgeMinutes) {
    reasons.push(reason(
      kind === 'source' ? 'SOURCE_TOO_OLD' : 'ERP_SYNC_TOO_OLD',
      dataset,
      kind === 'source' ? '上游库存快照已超过允许时效' : 'ERP 同步结果已超过允许时效',
    ));
  }
}

function reason(
  code: MukuFreshnessReason['code'],
  dataset: MukuSyncDataset,
  message: string,
): MukuFreshnessReason {
  return { code, dataset, message };
}

function ageMinutes(value: string | null, now: Date) {
  const valid = validTimestamp(value);
  return valid === null ? null : Math.round(((now.getTime() - Date.parse(valid)) / 60_000) * 10) / 10;
}

function validTimestamp(value: string | null) {
  return value && !Number.isNaN(Date.parse(value)) ? value : null;
}

function systemUser(tenantId: string, tenantName: string): UserContext {
  return {
    id: 'system:muku-auto-refresh',
    email: 'muku-auto-refresh@system.invalid',
    displayName: 'MUKU 自动刷新',
    role: 'admin',
    permissions: ROLE_PERMISSIONS.admin,
    tenantId,
    tenantName,
  };
}

function boundedEnvInteger(value: unknown, fallback: number, minimum: number, maximum: number) {
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) return fallback;
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}
