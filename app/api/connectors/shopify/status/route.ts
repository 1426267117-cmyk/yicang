import { env } from 'cloudflare:workers';
import {
  hasShopifyAppCredentials,
  hasShopifyCredentials,
  resolveShopifyStoreConfig,
  SHOPIFY_API_VERSION,
  SHOPIFY_STORE_CANDIDATES,
} from '../../../../../lib/connectors/shopify/config';
import { hasValidCredentialEncryptionKey } from '../../../../../lib/connectors/shopify/credential-store';
import { jsonError, requestContext, requirePermission } from '../../../../../lib/db';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const { db, user } = await requestContext(request);
    requirePermission(user, 'connectors:read');
    const runtimeEnv = env as unknown as Record<string, unknown>;
    const stored = await db.prepare(`
      SELECT s.connector_key, s.display_name, s.official_store_id, s.source_domain,
             s.identity_verified_at, s.last_successful_sync_at,
             c.completed_watermark, c.status AS sync_status, c.last_error_code
      FROM platform_stores s
      LEFT JOIN connector_sync_state c
        ON c.platform_store_id = s.id AND c.connector = 'shopify' AND c.resource = 'orders'
      WHERE s.tenant_id = ? AND s.platform = 'shopify'
    `).bind(user.tenantId).all<{
      connector_key: string;
      display_name: string;
      official_store_id: string;
      source_domain: string | null;
      identity_verified_at: string;
      last_successful_sync_at: string | null;
      completed_watermark: string | null;
      sync_status: string | null;
      last_error_code: string | null;
    }>();
    const byKey = new Map(stored.results.map((row) => [row.connector_key, row]));
    const oauthCredentials = await db.prepare(`
      SELECT store_key, official_store_id, shop_domain, access_token_expires_at,
             refresh_token_expires_at, updated_at
      FROM connector_credentials
      WHERE tenant_id = ? AND platform = 'shopify'
    `).bind(user.tenantId).all<{
      store_key: string;
      official_store_id: string;
      shop_domain: string;
      access_token_expires_at: string | null;
      refresh_token_expires_at: string | null;
      updated_at: string;
    }>();
    const credentialByKey = new Map(oauthCredentials.results.map((row) => [row.store_key, row]));
    const stores = SHOPIFY_STORE_CANDIDATES.map((candidate) => {
      const config = resolveShopifyStoreConfig(runtimeEnv, candidate.key);
      const row = byKey.get(candidate.key);
      const oauth = credentialByKey.get(candidate.key);
      const appConfigured = hasShopifyAppCredentials(config);
      const encryptionReady = hasValidCredentialEncryptionKey(runtimeEnv);
      const credentialsConfigured = hasShopifyCredentials(config) || Boolean(oauth);
      return {
        key: candidate.key,
        displayName: row?.display_name ?? candidate.displayName,
        expectedDomain: config.domain,
        appConfigured,
        encryptionReady,
        credentialsConfigured,
        authorizationRequired: config.authMode === 'oauth' && !credentialsConfigured,
        authorizationStartUrl: appConfigured && encryptionReady && config.authMode === 'oauth' && !credentialsConfigured
          ? `/api/connectors/shopify/oauth/${candidate.key}/start`
          : null,
        authorizationVerified: Boolean(oauth),
        authorizationUpdatedAt: oauth?.updated_at ?? null,
        accessTokenExpiresAt: oauth?.access_token_expires_at ?? null,
        refreshTokenExpiresAt: oauth?.refresh_token_expires_at ?? null,
        identityVerified: Boolean(row),
        officialStoreId: row?.official_store_id ?? oauth?.official_store_id ?? null,
        verifiedDomain: row?.source_domain ?? oauth?.shop_domain ?? null,
        identityVerifiedAt: row?.identity_verified_at ?? null,
        lastSuccessfulSyncAt: row?.last_successful_sync_at ?? null,
        completedWatermark: row?.completed_watermark ?? null,
        syncStatus: row?.sync_status ?? 'not_started',
        lastErrorCode: row?.last_error_code ?? null,
      };
    });
    return Response.json({ ok: true, apiVersion: SHOPIFY_API_VERSION, readOnly: true, stores }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    return jsonError(error);
  }
}
