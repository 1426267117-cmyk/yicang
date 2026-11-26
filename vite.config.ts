import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sites } from '@openai/sites-vite-plugin';
import tailwindcss from '@tailwindcss/postcss';
import vinext from 'vinext';
import { defineConfig, loadEnv } from 'vite';
import { feishuLiveSourcesPlugin } from './lib/feishu-live-sources-vite';
import { feishuProcurementSyncPlugin } from './lib/feishu-procurement-sync-vite';
import hostingConfig from './.openai/hosting.json';
import { mukuLocalEgressPlugin } from './lib/connectors/muku/local-egress-vite';

const SITE_CREATOR_PLACEHOLDER_DATABASE_ID =
  '00000000-0000-4000-8000-000000000000';

const { d1, r2 } = hostingConfig;

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === 'seatbelt';

const localBindingConfig = {
  main: 'vinext/server/app-router-entry',
  compatibility_flags: ['nodejs_compat'],
  d1_databases: d1
    ? [
        {
          binding: d1,
          database_name: 'site-creator-d1',
          database_id: SITE_CREATOR_PLACEHOLDER_DATABASE_ID,
        },
      ]
    : [],
  r2_buckets: r2
    ? [
        {
          binding: r2,
          bucket_name: 'site-creator-r2',
        },
      ]
    : [],
};

export default defineConfig(async ({ command, mode }) => {
  const css = { postcss: { plugins: [tailwindcss()] } };
  if (process.env.ERP_DEPLOY_TARGET === 'aws') {
    return {
      css,
      resolve: {
        alias: {
          'cloudflare:workers': fileURLToPath(new URL('./lib/aws/runtime-env.ts', import.meta.url)),
        },
      },
      plugins: [vinext()],
    };
  }

  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= 'false';
  process.env.WRANGLER_LOG_PATH ??= '.wrangler/logs';
  process.env.MINIFLARE_REGISTRY_PATH ??= '.wrangler/registry';

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import('@cloudflare/vite-plugin');
  const localSync = command === 'serve'
    ? loadEnv(mode, process.cwd(), ['ERP_FEISHU_MODE', 'ERP_FEISHU_SYNC_', 'ERP_FEISHU_SOURCES_'])
    : {};
  const syncToken = localSync.ERP_FEISHU_SYNC_WORKER_TOKEN;
  const sourceConfig = fileURLToPath(new URL('./outputs/feishu-procurement-preview/sync-config.json', import.meta.url));
  const liveSourceConfig = fileURLToPath(new URL('./outputs/feishu-live-sources/config.json', import.meta.url));
  const orderSourceConfig = fileURLToPath(new URL('./outputs/nine-store-orders/config.json', import.meta.url));
  const collector = fileURLToPath(new URL('./scripts/sync-feishu-procurement-snapshot.py', import.meta.url));
  const livePreview = fileURLToPath(new URL('./scripts/feishu-live-preview.py', import.meta.url));
  const hasLocalToken = syncToken && /^[A-Za-z0-9_-]{32,128}$/.test(syncToken);
  const continuousFeishu = localSync.ERP_FEISHU_MODE === 'continuous';
  const enableFeishuSync = continuousFeishu && localSync.ERP_FEISHU_SYNC_LOCAL_START === 'true'
    && hasLocalToken && existsSync(sourceConfig) && existsSync(collector);
  const enableFeishuSources = continuousFeishu && hasLocalToken && existsSync(liveSourceConfig) && existsSync(livePreview);
  const enableOrderSync = enableFeishuSync && existsSync(orderSourceConfig)
    && existsSync(fileURLToPath(new URL('./scripts/sync-feishu-nine-store-orders.py', import.meta.url)));

  return {
    css,
    server: {
      fs: { deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/.wrangler/**', '**/outputs/**', '**/work/**'] },
      ...(isCodexSeatbeltSandbox ? { watch: { useFsEvents: false, usePolling: true } } : {}),
    },
    plugins: [
      mukuLocalEgressPlugin(),
      ...(enableFeishuSync ? [feishuProcurementSyncPlugin(syncToken, enableOrderSync ? orderSourceConfig : undefined)] : []),
      ...(enableFeishuSources ? [feishuLiveSourcesPlugin(syncToken, liveSourceConfig)] : []),
      vinext(),
      sites(),
      cloudflare({
        viteEnvironment: { name: 'rsc', childEnvironments: ['ssr'] },
        config: {
          ...localBindingConfig,
          vars: {
            ...(continuousFeishu ? { ERP_FEISHU_MODE: 'continuous' } : {}),
            ...(enableFeishuSync ? { ERP_FEISHU_SYNC_ENABLED: 'true' } : {}),
            ...(enableOrderSync ? { ERP_FEISHU_ORDERS_SYNC_ENABLED: 'true' } : {}),
            ...(enableFeishuSources ? {
              ERP_FEISHU_SOURCES_LOCAL_ENABLED: 'true',
              ERP_FEISHU_SOURCES_LOCAL_ORIGIN: localSync.ERP_FEISHU_SOURCES_LOCAL_ORIGIN || 'http://127.0.0.1:3000',
            } : {}),
          },
        },
      }),
    ],
  };
});
