import type { MukuFreshnessReport } from './muku-freshness-service';
import { resolveMukuConfig } from './connectors/muku/config';
import {
  isShopifyStoreKey,
  readyShopifyEnvironmentStoreKeys,
} from './connectors/shopify/config';

const INTERNAL_JOB_TOKEN_MIN_LENGTH = 32;
const MUKU_REFRESH_ENDPOINT = '/api/connectors/muku/refresh';
const SHOPIFY_RECONCILE_ENDPOINT = '/api/connectors/shopify/reconcile';

type PlanningOrderSource = {
  storeId: string;
  platform: string;
  storeKey: string;
  storeName: string;
  official: boolean;
  ready: boolean;
  lastSuccessAt: string | null;
  ageMinutes: number | null;
  syncStatus: string;
  lastErrorCode: string | null;
  reasons: string[];
};

export type ProcurementOperationsStatus = ReturnType<typeof buildProcurementOperationsStatus>;

export function buildProcurementOperationsStatus(input: {
  freshness: MukuFreshnessReport;
  orderSources: PlanningOrderSource[];
  shopifyAuthorizedStoreKeys?: readonly string[];
  orderSyncMaxAgeMinutes: number;
  runtimeEnv: Record<string, unknown>;
}) {
  const internalJobAuthConfigured = hasSecureInternalJobToken(input.runtimeEnv);
  const mukuSourceConfigured = hasMukuSourceConfiguration(input.runtimeEnv);
  const mukuExternalScheduleConfigured = explicitTrue(
    input.runtimeEnv.ERP_MUKU_EXTERNAL_SCHEDULE_CONFIGURED,
  );
  const shopifyExternalScheduleConfigured = explicitTrue(
    input.runtimeEnv.ERP_SHOPIFY_RECONCILE_SCHEDULE_CONFIGURED,
  );
  const inventory = input.freshness.datasets.find((dataset) => dataset.dataset === 'inventory') ?? null;
  const officialShopifySources = input.orderSources.filter((source) => (
    source.official && source.platform.toLowerCase() === 'shopify'
  ));
  const configuredShopifyStoreKeys = new Set([
    ...readyShopifyEnvironmentStoreKeys(input.runtimeEnv),
    ...(input.shopifyAuthorizedStoreKeys ?? []).filter(isShopifyStoreKey),
  ]);
  const shopifySourceConfigured = configuredShopifyStoreKeys.size > 0;
  const mukuEndpointReady = internalJobAuthConfigured && mukuSourceConfigured;
  const shopifyEndpointReady = internalJobAuthConfigured && shopifySourceConfigured;

  const mukuConfigurationBlockers = [
    !mukuSourceConfigured
      ? 'MUKU 看板只读密钥未配置，受保护刷新任务无法读取数据。'
      : null,
    !internalJobAuthConfigured
      ? 'ERP 内部任务密钥未安全配置，调度器不能调用刷新入口。'
      : null,
    !mukuExternalScheduleConfigured
      ? '尚未确认外部调度器会定期调用 MUKU 刷新入口。'
      : null,
  ].filter((reason): reason is string => reason !== null);
  const shopifyConfigurationBlockers = [
    !shopifySourceConfigured
      ? '尚未发现 Shopify OAuth 授权或服务端 ADMIN_ACCESS_TOKEN。'
      : null,
    !internalJobAuthConfigured
      ? 'ERP 内部任务密钥未安全配置，调度器不能调用 Shopify 补漏入口。'
      : null,
    !shopifyExternalScheduleConfigured
      ? '尚未确认外部调度器会定期调用 Shopify 增量补漏入口。'
      : null,
  ].filter((reason): reason is string => reason !== null);

  const shopifyStores = officialShopifySources.map((source) => ({
    storeId: source.storeId,
    storeKey: source.storeKey,
    storeName: source.storeName,
    ready: source.ready,
    lastSuccessAt: source.lastSuccessAt,
    ageMinutes: source.ageMinutes,
    freshUntil: addMinutes(source.lastSuccessAt, input.orderSyncMaxAgeMinutes),
    syncStatus: source.syncStatus,
    lastErrorCode: source.lastErrorCode,
    reasons: source.reasons,
  }));

  return {
    checkedAt: input.freshness.checkedAt,
    browserRefresh: {
      guaranteedCollection: false as const,
      shopifySyncTriggered: false as const,
      mukuDueRefreshMayTrigger: mukuSourceConfigured,
      note: '页面刷新只重新读取当前状态；MUKU 状态到期时可能顺带触发一次后台更新，但这不等于已配置持续采集，Shopify 也不会因刷新页面而同步。',
    },
    internalJobAuthConfigured,
    automationReady: mukuEndpointReady
      && shopifyEndpointReady
      && mukuExternalScheduleConfigured
      && shopifyExternalScheduleConfigured,
    muku: {
      protectedEndpoint: MUKU_REFRESH_ENDPOINT,
      endpointReady: mukuEndpointReady,
      sourceConfigured: mukuSourceConfigured,
      externalScheduleConfigured: mukuExternalScheduleConfigured,
      automationReady: mukuEndpointReady && mukuExternalScheduleConfigured,
      recommendedIntervalMinutes: input.freshness.minRefreshIntervalMinutes,
      dataReady: input.freshness.readyForProcurement,
      sourceGeneratedAt: inventory?.generatedAt ?? null,
      lastSuccessAt: inventory?.lastSuccessAt ?? null,
      freshUntil: freshUntil(
        [inventory?.generatedAt ?? null, inventory?.lastSuccessAt ?? null],
        input.freshness.maxAgeMinutes,
      ),
      nextRefreshDueAt: input.freshness.nextRefreshAt,
      configurationBlockers: mukuConfigurationBlockers,
      dataBlockers: input.freshness.blockingReasons.map((reason) => reason.message),
    },
    shopify: {
      protectedEndpoint: SHOPIFY_RECONCILE_ENDPOINT,
      endpointReady: shopifyEndpointReady,
      sourceConfigured: shopifySourceConfigured,
      externalScheduleConfigured: shopifyExternalScheduleConfigured,
      automationReady: shopifyEndpointReady && shopifyExternalScheduleConfigured,
      recommendedIntervalMinutes: recommendedShopifyInterval(input.orderSyncMaxAgeMinutes),
      maxAgeMinutes: input.orderSyncMaxAgeMinutes,
      lastSuccessAt: latestTimestamp(shopifyStores.map((store) => store.lastSuccessAt)),
      nextExpiryAt: earliestTimestamp(shopifyStores.map((store) => store.freshUntil)),
      configurationBlockers: shopifyConfigurationBlockers,
      stores: shopifyStores,
    },
  };
}

export function hasSecureInternalJobToken(runtimeEnv: Record<string, unknown>) {
  const value = runtimeEnv.ERP_INTERNAL_JOB_TOKEN;
  return typeof value === 'string' && value.trim().length >= INTERNAL_JOB_TOKEN_MIN_LENGTH;
}

export function externalScheduleConfigured(
  runtimeEnv: Record<string, unknown>,
  name: 'muku' | 'shopify',
) {
  return explicitTrue(name === 'muku'
    ? runtimeEnv.ERP_MUKU_EXTERNAL_SCHEDULE_CONFIGURED
    : runtimeEnv.ERP_SHOPIFY_RECONCILE_SCHEDULE_CONFIGURED);
}

function hasMukuSourceConfiguration(runtimeEnv: Record<string, unknown>) {
  try {
    resolveMukuConfig(runtimeEnv);
    return true;
  } catch {
    return false;
  }
}

function explicitTrue(value: unknown) {
  if (value === true) return true;
  if (typeof value !== 'string') return false;
  return value.trim().toLowerCase() === 'true';
}

function recommendedShopifyInterval(maxAgeMinutes: number) {
  return Math.max(5, Math.min(15, Math.floor(maxAgeMinutes / 2)));
}

function freshUntil(values: Array<string | null>, maxAgeMinutes: number) {
  if (values.some((value) => validTime(value) === null)) return null;
  const earliest = Math.min(...values.map((value) => validTime(value) as number));
  return new Date(earliest + maxAgeMinutes * 60_000).toISOString();
}

function addMinutes(value: string | null, minutes: number) {
  const timestamp = validTime(value);
  return timestamp === null ? null : new Date(timestamp + minutes * 60_000).toISOString();
}

function latestTimestamp(values: Array<string | null>) {
  const timestamps = values
    .map(validTime)
    .filter((value): value is number => value !== null);
  return timestamps.length ? new Date(Math.max(...timestamps)).toISOString() : null;
}

function earliestTimestamp(values: Array<string | null>) {
  if (!values.length || values.some((value) => validTime(value) === null)) return null;
  return new Date(Math.min(...values.map((value) => validTime(value) as number))).toISOString();
}

function validTime(value: string | null) {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
