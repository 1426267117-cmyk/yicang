import type { Session } from '@shopify/shopify-api';
import {
  hasShopifyCredentials,
  resolveShopifyStoreConfig,
  type ShopifyCredentialConfig,
  type ShopifyStoreKey,
  withShopifyAdminAccessToken,
} from './config';
import { ShopifyConnectorError } from './errors';
import { createShopifyOAuthApi } from './oauth';

const KEY_VERSION = 1;
const REFRESH_EARLY_MILLISECONDS = 5 * 60 * 1000;
const REFRESH_LEASE_MILLISECONDS = 5 * 60 * 1000;

type StoredCredentialRow = {
  id: string;
  store_key: ShopifyStoreKey;
  shop_domain: string;
  official_store_id: string;
  access_token_ciphertext: string;
  refresh_token_ciphertext: string | null;
  granted_scopes: string;
  access_token_expires_at: string | null;
  refresh_token_expires_at: string | null;
  key_version: number;
  created_by: string;
  created_at: string;
  updated_at: string;
};

export type ShopifyOAuthCredential = {
  id: string;
  storeKey: ShopifyStoreKey;
  shopDomain: string;
  officialStoreId: string;
  accessToken: string;
  refreshToken: string | null;
  grantedScopes: string;
  accessTokenExpiresAt: string | null;
  refreshTokenExpiresAt: string | null;
  keyVersion: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

export async function resolveShopifyRuntimeConfig(input: {
  db: D1Database;
  tenantId: string;
  runtimeEnv: Record<string, unknown>;
  storeKey: ShopifyStoreKey;
  requestUrl: string;
  now?: Date;
}): Promise<ShopifyCredentialConfig> {
  const base = resolveShopifyStoreConfig(input.runtimeEnv, input.storeKey);
  if (base.authMode !== 'oauth' && hasShopifyCredentials(base)) return base;
  let stored = await loadShopifyOAuthCredential(
    input.db,
    input.tenantId,
    input.storeKey,
    input.runtimeEnv,
  );
  if (!stored) return base;
  if (needsRefresh(stored, input.now ?? new Date())) {
    stored = await refreshShopifyOAuthCredential({
      ...input,
      config: base,
      credential: stored,
    });
  }
  return withShopifyAdminAccessToken(base, {
    token: stored.accessToken,
    domain: stored.shopDomain,
    credentialRef: `d1:shopify:${stored.storeKey}`,
  });
}

export async function loadShopifyOAuthCredential(
  db: D1Database,
  tenantId: string,
  storeKey: ShopifyStoreKey,
  runtimeEnv: Record<string, unknown>,
): Promise<ShopifyOAuthCredential | null> {
  const row = await db.prepare(`
    SELECT id, store_key, shop_domain, official_store_id, access_token_ciphertext,
           refresh_token_ciphertext, granted_scopes, access_token_expires_at,
           refresh_token_expires_at, key_version, created_by, created_at, updated_at
    FROM connector_credentials
    WHERE tenant_id = ? AND platform = 'shopify' AND store_key = ?
    LIMIT 1
  `).bind(tenantId, storeKey).first<StoredCredentialRow>();
  if (!row) return null;
  const key = encryptionKey(runtimeEnv);
  const aad = credentialAad(tenantId, row.store_key, row.shop_domain, row.official_store_id, row.key_version);
  try {
    return {
      id: row.id,
      storeKey: row.store_key,
      shopDomain: row.shop_domain,
      officialStoreId: row.official_store_id,
      accessToken: await decryptShopifySecret(row.access_token_ciphertext, key, aad),
      refreshToken: row.refresh_token_ciphertext
        ? await decryptShopifySecret(row.refresh_token_ciphertext, key, aad)
        : null,
      grantedScopes: row.granted_scopes,
      accessTokenExpiresAt: row.access_token_expires_at,
      refreshTokenExpiresAt: row.refresh_token_expires_at,
      keyVersion: row.key_version,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  } catch {
    throw new ShopifyConnectorError(
      'SHOPIFY_CREDENTIAL_DECRYPT_FAILED',
      'Shopify 授权凭证无法安全解密，请重新授权该店铺',
    );
  }
}

export async function saveShopifyOAuthCredential(input: {
  db: D1Database;
  tenantId: string;
  runtimeEnv: Record<string, unknown>;
  storeKey: ShopifyStoreKey;
  shopDomain: string;
  officialStoreId: string;
  grantedScopes: string;
  session: Pick<Session, 'accessToken' | 'refreshToken' | 'expires' | 'refreshTokenExpires'>;
  createdBy: string;
  now?: Date;
}) {
  if (!input.session.accessToken) {
    throw new ShopifyConnectorError('SHOPIFY_AUTH_INVALID_RESPONSE', 'Shopify 授权响应缺少访问令牌');
  }
  const now = input.now ?? new Date();
  const key = encryptionKey(input.runtimeEnv);
  const aad = credentialAad(
    input.tenantId,
    input.storeKey,
    input.shopDomain,
    input.officialStoreId,
    KEY_VERSION,
  );
  const accessTokenCiphertext = await encryptShopifySecret(input.session.accessToken, key, aad);
  const refreshTokenCiphertext = input.session.refreshToken
    ? await encryptShopifySecret(input.session.refreshToken, key, aad)
    : null;
  const timestamp = now.toISOString();
  await input.db.prepare(`
    INSERT INTO connector_credentials (
      id, tenant_id, platform, store_key, shop_domain, official_store_id,
      access_token_ciphertext, refresh_token_ciphertext, granted_scopes,
      access_token_expires_at, refresh_token_expires_at, key_version,
      created_by, created_at, updated_at
    ) VALUES (?, ?, 'shopify', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(tenant_id, platform, store_key) DO UPDATE SET
      shop_domain = excluded.shop_domain,
      official_store_id = excluded.official_store_id,
      access_token_ciphertext = excluded.access_token_ciphertext,
      refresh_token_ciphertext = excluded.refresh_token_ciphertext,
      granted_scopes = excluded.granted_scopes,
      access_token_expires_at = excluded.access_token_expires_at,
      refresh_token_expires_at = excluded.refresh_token_expires_at,
      refresh_started_at = NULL,
      key_version = excluded.key_version,
      updated_at = excluded.updated_at
  `).bind(
    crypto.randomUUID(),
    input.tenantId,
    input.storeKey,
    input.shopDomain,
    input.officialStoreId,
    accessTokenCiphertext,
    refreshTokenCiphertext,
    input.grantedScopes,
    input.session.expires?.toISOString() ?? null,
    input.session.refreshTokenExpires?.toISOString() ?? null,
    KEY_VERSION,
    input.createdBy,
    timestamp,
    timestamp,
  ).run();
}

async function refreshShopifyOAuthCredential(input: {
  db: D1Database;
  tenantId: string;
  runtimeEnv: Record<string, unknown>;
  storeKey: ShopifyStoreKey;
  requestUrl: string;
  config: ShopifyCredentialConfig;
  credential: ShopifyOAuthCredential;
}) {
  if (!input.credential.refreshToken) {
    throw new ShopifyConnectorError(
      'SHOPIFY_REAUTHORIZATION_REQUIRED',
      `${input.config.displayName} 的 Shopify 授权已过期，请重新授权`,
    );
  }
  if (
    input.credential.refreshTokenExpiresAt
    && Date.parse(input.credential.refreshTokenExpiresAt) <= Date.now()
  ) {
    throw new ShopifyConnectorError(
      'SHOPIFY_REAUTHORIZATION_REQUIRED',
      `${input.config.displayName} 的 Shopify 刷新凭证已过期，请重新授权`,
    );
  }
  const api = createShopifyOAuthApi(input.config, input.requestUrl);
  const refreshStartedAt = new Date().toISOString();
  const leaseExpiredBefore = new Date(Date.now() - REFRESH_LEASE_MILLISECONDS).toISOString();
  const lease = await input.db.prepare(`
    UPDATE connector_credentials
    SET refresh_started_at = ?
    WHERE id = ? AND tenant_id = ? AND platform = 'shopify' AND store_key = ?
      AND (refresh_started_at IS NULL OR refresh_started_at < ?)
  `).bind(
    refreshStartedAt,
    input.credential.id,
    input.tenantId,
    input.storeKey,
    leaseExpiredBefore,
  ).run();
  if (Number(lease.meta?.changes ?? 0) !== 1) {
    throw new ShopifyConnectorError(
      'SHOPIFY_CREDENTIAL_REFRESH_BUSY',
      `${input.config.displayName} 的 Shopify 授权正在刷新，请稍后重试`,
      true,
    );
  }
  let session: Session;
  try {
    ({ session } = await api.auth.refreshToken({
      shop: input.credential.shopDomain,
      refreshToken: input.credential.refreshToken,
    }));
    await saveShopifyOAuthCredential({
      db: input.db,
      tenantId: input.tenantId,
      runtimeEnv: input.runtimeEnv,
      storeKey: input.storeKey,
      shopDomain: input.credential.shopDomain,
      officialStoreId: input.credential.officialStoreId,
      grantedScopes: session.scope ?? input.credential.grantedScopes,
      session,
      createdBy: input.credential.createdBy,
    });
  } catch {
    await input.db.prepare(`
      UPDATE connector_credentials SET refresh_started_at = NULL
      WHERE id = ? AND tenant_id = ? AND refresh_started_at = ?
    `).bind(input.credential.id, input.tenantId, refreshStartedAt).run();
    throw new ShopifyConnectorError(
      'SHOPIFY_REAUTHORIZATION_REQUIRED',
      `${input.config.displayName} 的 Shopify 授权无法刷新，请重新授权`,
    );
  }
  const refreshed = await loadShopifyOAuthCredential(
    input.db,
    input.tenantId,
    input.storeKey,
    input.runtimeEnv,
  );
  if (!refreshed) {
    throw new ShopifyConnectorError('SHOPIFY_AUTH_INVALID_RESPONSE', 'Shopify 刷新凭证未能安全保存');
  }
  return refreshed;
}

function needsRefresh(credential: ShopifyOAuthCredential, now: Date) {
  if (!credential.accessTokenExpiresAt) return false;
  return Date.parse(credential.accessTokenExpiresAt) <= now.getTime() + REFRESH_EARLY_MILLISECONDS;
}

function encryptionKey(runtimeEnv: Record<string, unknown>) {
  assertCredentialEncryptionKey(runtimeEnv);
  return String(runtimeEnv.ERP_CONNECTOR_CREDENTIALS_KEY).trim();
}

export function hasValidCredentialEncryptionKey(runtimeEnv: Record<string, unknown>) {
  try {
    assertCredentialEncryptionKey(runtimeEnv);
    return true;
  } catch {
    return false;
  }
}

export function assertCredentialEncryptionKey(runtimeEnv: Record<string, unknown>) {
  const value = runtimeEnv.ERP_CONNECTOR_CREDENTIALS_KEY;
  if (typeof value !== 'string' || !value.trim()) {
    throw new ShopifyConnectorError(
      'ERP_CREDENTIAL_ENCRYPTION_KEY_MISSING',
      'ERP 尚未配置连接器凭证加密密钥',
    );
  }
  try {
    if (base64ToBytes(value.trim()).byteLength !== 32) throw new Error('INVALID_KEY_LENGTH');
  } catch {
    throw new ShopifyConnectorError(
      'ERP_CREDENTIAL_ENCRYPTION_KEY_INVALID',
      'ERP 连接器凭证加密密钥格式无效',
    );
  }
}

function credentialAad(
  tenantId: string,
  storeKey: ShopifyStoreKey,
  shopDomain: string,
  officialStoreId: string,
  keyVersion: number,
) {
  return `${tenantId}|shopify|${storeKey}|${shopDomain}|${officialStoreId}|v${keyVersion}`;
}

export async function encryptShopifySecret(value: string, base64Key: string, aad: string) {
  const key = await importAesKey(base64Key, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(aad) },
    key,
    new TextEncoder().encode(value),
  );
  return `v1:${bytesToBase64Url(iv)}:${bytesToBase64Url(new Uint8Array(ciphertext))}`;
}

export async function decryptShopifySecret(value: string, base64Key: string, aad: string) {
  const [version, ivValue, cipherValue, extra] = value.split(':');
  if (version !== 'v1' || !ivValue || !cipherValue || extra) throw new Error('INVALID_CIPHERTEXT');
  const key = await importAesKey(base64Key, ['decrypt']);
  const plaintext = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: base64UrlToBytes(ivValue),
      additionalData: new TextEncoder().encode(aad),
    },
    key,
    base64UrlToBytes(cipherValue),
  );
  return new TextDecoder().decode(plaintext);
}

async function importAesKey(base64Key: string, usages: KeyUsage[]) {
  const raw = base64ToBytes(base64Key);
  if (raw.byteLength !== 32) throw new Error('INVALID_ENCRYPTION_KEY');
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, usages);
}

function base64ToBytes(value: string) {
  const binary = atob(value.replace(/\s+/g, ''));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function bytesToBase64Url(value: Uint8Array) {
  let binary = '';
  value.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToBytes(value: string) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  return base64ToBytes(base64);
}
