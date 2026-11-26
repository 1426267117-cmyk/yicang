import { z } from 'zod';
import { HttpError } from '../../db';
import { stableId } from '../stable';
import { amazonOrderId } from './mapper';
import { isAmazonMarketplaceId, type AmazonOrderSourceConfig } from './orders';

const stores = [
  { key: 'amazon-senyu', name: '森语', prefix: 'ERP_AMAZON_SENYU' },
  { key: 'amazon-kaguyasu', name: 'Kaguyasu', prefix: 'ERP_AMAZON_KAGUYASU' },
  { key: 'amazon-zhongcheng', name: '中诚', prefix: 'ERP_AMAZON_ZHONGCHENG' },
  { key: 'amazon-genji', name: 'Genji', prefix: 'ERP_AMAZON_GENJI' },
] as const;
export const amazonStoreKeySchema = z.enum(stores.map((store) => store.key));
export type AmazonStoreKey = z.infer<typeof amazonStoreKeySchema>;

const credentialSchema = z.strictObject({
  sellerId: z.string().regex(/^[A-Z0-9]{8,32}$/u),
  verificationOrderId: z.string().regex(amazonOrderId),
  marketplaceId: z.string().refine(isAmazonMarketplaceId),
  clientId: z.string().regex(/^[!-~]{1,2048}$/u),
  clientSecret: z.string().regex(/^[!-~]{1,2048}$/u),
  refreshToken: z.string().regex(/^[!-~]{1,2048}$/u),
});

export type AmazonStoreConfig = AmazonOrderSourceConfig & {
  key: AmazonStoreKey; name: string; sellerId: string; verificationOrderId: string;
};
type StoreSettings = {
  key: AmazonStoreKey;
  name: string;
  configuration: 'unconfigured' | 'invalid' | 'duplicate' | 'configured';
  config: AmazonStoreConfig | null;
};

export const amazonOrdersApiVersion = '2026-01-01';

function value(env: Record<string, unknown>, key: string) {
  const candidate = env[key];
  return typeof candidate === 'string' ? candidate.trim() : '';
}

export function getAmazonStoreSettings(env: Record<string, unknown>, tenantId: string): StoreSettings[] {
  const configuredTenant = value(env, 'ERP_AMAZON_ORDERS_TENANT_ID');
  const settings = stores.map(({ key, name, prefix }): StoreSettings => {
    if (!configuredTenant || configuredTenant !== tenantId) {
      return { key, name, configuration: 'unconfigured', config: null };
    }
    const sellerId = value(env, `${prefix}_SELLER_ID`);
    const marketplaceId = value(env, `${prefix}_MARKETPLACE_ID`);
    const verificationOrderId = value(env, `${prefix}_VERIFY_ORDER_ID`);
    const refreshToken = value(env, `${prefix}_REFRESH_TOKEN`);
    const clientId = value(env, `${prefix}_CLIENT_ID`) || value(env, 'ERP_AMAZON_CLIENT_ID');
    const clientSecret = value(env, `${prefix}_CLIENT_SECRET`) || value(env, 'ERP_AMAZON_CLIENT_SECRET');
    if (!sellerId && !marketplaceId && !verificationOrderId && !refreshToken) {
      return { key, name, configuration: 'unconfigured', config: null };
    }
    const parsed = credentialSchema.safeParse({ sellerId, marketplaceId, verificationOrderId, refreshToken, clientId, clientSecret });
    return parsed.success
      ? { key, name, configuration: 'configured', config: { key, name, ...parsed.data } }
      : { key, name, configuration: 'invalid', config: null };
  });
  return settings.map((store) => {
    if (!store.config) return store;
    const duplicate = settings.some((other) => other.key !== store.key && other.config && (
      other.config.sellerId === store.config?.sellerId
      || other.config.refreshToken === store.config?.refreshToken
      || other.config.verificationOrderId === store.config?.verificationOrderId
    ));
    return duplicate ? { ...store, configuration: 'duplicate', config: null } : store;
  });
}

export function chooseAmazonStore(env: Record<string, unknown>, tenantId: string, key: AmazonStoreKey) {
  const store = getAmazonStoreSettings(env, tenantId).find((candidate) => candidate.key === key);
  if (store?.config) return store.config;
  if (store?.configuration === 'duplicate') {
    throw new HttpError(409, '两家 Amazon 店铺配置使用了相同卖家、授权或核验订单，请核对店铺归属', 'AMAZON_DUPLICATE_STORE');
  }
  throw new HttpError(409, '该 Amazon 店铺尚未配置完整的授权和来源核验资料', 'AMAZON_CONFIGURATION_REQUIRED');
}

export function amazonStoreId(tenantId: string, config: AmazonStoreConfig) {
  return stableId('store', tenantId, 'amazon', config.sellerId);
}

export async function saveVerifiedAmazonStore(db: D1Database, tenantId: string, config: AmazonStoreConfig, now: string) {
  const storeId = await amazonStoreId(tenantId, config);
  const identityRef = `amazon-orders:${config.key}:${config.marketplaceId}`;
  const inserted = await db.prepare(`
    INSERT INTO platform_stores
      (id, tenant_id, platform, connector_key, display_name, official_store_id, api_version,
       credential_ref, identity_verified_at, active, created_at, updated_at)
    SELECT ?, ?, 'amazon', ?, ?, ?, ?, ?, ?, 1, ?, ?
    WHERE NOT EXISTS (
      SELECT 1 FROM platform_stores WHERE tenant_id = ? AND platform = 'amazon'
      AND ((connector_key = ? AND (official_store_id <> ? OR credential_ref <> ?)) OR (official_store_id = ? AND connector_key <> ?))
    )
    ON CONFLICT(id) DO UPDATE SET display_name = excluded.display_name, api_version = excluded.api_version,
      identity_verified_at = excluded.identity_verified_at, updated_at = excluded.updated_at, active = 1
    WHERE platform_stores.tenant_id = excluded.tenant_id AND platform_stores.platform = 'amazon'
      AND platform_stores.connector_key = excluded.connector_key
      AND platform_stores.official_store_id = excluded.official_store_id AND platform_stores.credential_ref = excluded.credential_ref
  `).bind(storeId, tenantId, config.key, config.name, config.sellerId, amazonOrdersApiVersion,
    identityRef, now, now, now, tenantId, config.key, config.sellerId, identityRef, config.sellerId, config.key).run();
  if (Number(inserted.meta.changes) !== 1) {
    throw new HttpError(409, 'Amazon 卖家或站点与已有店铺记录冲突，订单同步已停止', 'AMAZON_STORE_BINDING_CONFLICT');
  }
  return storeId;
}

export async function readAmazonStoreStatuses(db: D1Database, tenantId: string, env: Record<string, unknown>) {
  const settings = getAmazonStoreSettings(env, tenantId);
  const stored = await db.prepare(`
    SELECT s.connector_key, s.last_successful_sync_at, c.completed_watermark, c.status, c.last_error_code,
      c.active_window_start, c.active_window_end
    FROM platform_stores s
    LEFT JOIN connector_sync_state c ON c.platform_store_id = s.id AND c.tenant_id = s.tenant_id
      AND c.connector = 'amazon' AND c.resource = 'orders'
    WHERE s.tenant_id = ? AND s.platform = 'amazon'
  `).bind(tenantId).all<{
    connector_key: string; last_successful_sync_at: string | null; completed_watermark: string | null;
    status: string | null; last_error_code: string | null; active_window_start: string | null; active_window_end: string | null;
  }>();
  const byKey = new Map(stored.results.map((store) => [store.connector_key, store]));
  return settings.map(({ key, name, configuration }) => {
    const store = byKey.get(key);
    return {
      key, name, configuration,
      sourceVerified: Boolean(store),
      syncStatus: store?.status ?? 'idle',
      resumable: Boolean(store?.active_window_start && store.active_window_end),
      lastSuccessfulSyncAt: store?.last_successful_sync_at ?? null,
      completedWatermark: store?.completed_watermark ?? null,
      lastErrorCode: store?.last_error_code?.startsWith('AMAZON_') ? store.last_error_code : null,
    };
  });
}

export type AmazonStoreStatus = Awaited<ReturnType<typeof readAmazonStoreStatuses>>[number];
