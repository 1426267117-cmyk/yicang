import { readFileSync } from 'node:fs';
import { Miniflare } from 'miniflare';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({ env: {} }));

import type {
  MukuBusinessDatasetId,
  MukuDatasetExport,
  MukuExportFilters,
  MukuManifestResponse,
  MukuRecord,
} from '../lib/connectors/muku/types';
import {
  evaluateMukuFreshness,
  refreshMukuIfDue,
  resolveMukuFreshnessOptions,
} from '../lib/muku-freshness-service';
import { syncMukuDatasets, type MukuSyncDataset } from '../lib/muku-sync-service';
import { ROLE_PERMISSIONS } from '../lib/domain';

const tenantId = 'tenant_muku_freshness';
const user = {
  id: 'muku-freshness-admin',
  email: 'muku-freshness-admin@example.invalid',
  displayName: 'muku-freshness-admin',
  role: 'admin' as const,
  permissions: ROLE_PERMISSIONS.admin,
  tenantId,
  tenantName: tenantId,
};

describe('MUKU 新鲜度与安全刷新', () => {
  let mf: Miniflare;
  let db: D1Database;
  let client: FreshMukuClient;

  beforeEach(async () => {
    mf = new Miniflare({
      modules: true,
      script: 'export default { fetch(){ return new Response("ok") } }',
      d1Databases: ['DB'],
    });
    db = await mf.getD1Database('DB');
    await applyMigrations(db);
    await db.prepare('INSERT INTO tenants (id, name, created_at) VALUES (?, ?, ?)')
      .bind(tenantId, tenantId, new Date().toISOString()).run();
    client = new FreshMukuClient(new Date().toISOString());
  });

  afterEach(async () => { await mf.dispose(); });

  it('缺少有效库存快照时阻断采购，并明确标记刷新到期', async () => {
    const result = await evaluateMukuFreshness(db, tenantId);

    expect(result).toEqual(expect.objectContaining({
      status: 'missing',
      readyForProcurement: false,
      maxAgeMinutes: 30,
      needsRefresh: true,
      refreshDue: true,
    }));
    expect(result.blockingReasons.map((item) => item.code)).toEqual(expect.arrayContaining([
      'MISSING_DATASET_STATE',
      'SOURCE_TIME_UNKNOWN',
      'ERP_SYNC_TIME_UNKNOWN',
    ]));
  });

  it('到期刷新全部只读数据集，并在限频窗口内不重复拉取', async () => {
    const first = await refreshMukuIfDue({ db, tenantId, client });

    expect(first).toEqual(expect.objectContaining({ attempted: true, ok: true }));
    expect('after' in first && first.after?.readyForProcurement).toBe(true);
    expect(client.requested).toEqual([
      'inventory',
      'inventory-details',
      'inventory-risk',
      'source-status',
    ]);

    const second = await refreshMukuIfDue({ db, tenantId, client });
    expect(second).toEqual(expect.objectContaining({
      attempted: false,
      skipReason: 'not_due',
    }));
    expect(client.requested).toHaveLength(4);
  });

  it('上游库存生成时间过旧时即使刚同步也阻断采购', async () => {
    const now = new Date();
    client = new FreshMukuClient(new Date(now.getTime() - 31 * 60_000).toISOString());
    await syncMukuDatasets({
      db,
      user,
      client,
      datasets: ['inventory'],
      idempotencyKey: 'muku-freshness-stale-source',
    });

    const result = await evaluateMukuFreshness(db, tenantId, { now });
    expect(result.readyForProcurement).toBe(false);
    expect(result.blockingReasons).toEqual(expect.arrayContaining([
      expect.objectContaining({ dataset: 'inventory', code: 'SOURCE_TOO_OLD' }),
    ]));
  });

  it('刷新运行中继续使用新鲜 active 快照，但不触发重叠任务', async () => {
    await syncMukuDatasets({
      db,
      user,
      client,
      datasets: ['inventory'],
      idempotencyKey: 'muku-freshness-running-base',
    });
    const now = new Date();
    await db.batch([
      db.prepare(`
        INSERT INTO muku_sync_runs (
          id, tenant_id, dataset, snapshot_id, status, idempotency_key, request_hash,
          lease_id, lease_expires_at, page_count, record_count, content_hash,
          error_code, error_message, started_at, finished_at
        ) VALUES (
          'freshness-live-run', ?, 'inventory', NULL, 'running',
          'muku-freshness-live-run', 'request-hash', 'freshness-live-lease', ?,
          0, 0, NULL, NULL, NULL, ?, NULL
        )
      `).bind(
        tenantId,
        new Date(now.getTime() + 10 * 60_000).toISOString(),
        now.toISOString(),
      ),
      db.prepare(`
        UPDATE muku_dataset_state SET status = 'running', updated_at = ?
        WHERE tenant_id = ? AND dataset = 'inventory'
      `).bind(now.toISOString(), tenantId),
    ]);

    const result = await evaluateMukuFreshness(db, tenantId, { now });
    expect(result).toEqual(expect.objectContaining({
      status: 'refreshing',
      readyForProcurement: true,
      refreshInProgress: true,
      refreshDue: false,
    }));
  });

  it('失败状态保留 active 快照但关闭采购安全门', async () => {
    await syncMukuDatasets({
      db,
      user,
      client,
      datasets: ['inventory'],
      idempotencyKey: 'muku-freshness-delayed-base',
    });
    const before = await db.prepare(`
      SELECT active_snapshot_id FROM muku_dataset_state
      WHERE tenant_id = ? AND dataset = 'inventory'
    `).bind(tenantId).first<{ active_snapshot_id: string }>();
    await db.prepare(`
      UPDATE muku_dataset_state
      SET status = 'delayed', last_error_code = 'MUKU_UPSTREAM_UNAVAILABLE', last_error_at = ?
      WHERE tenant_id = ? AND dataset = 'inventory'
    `).bind(new Date().toISOString(), tenantId).run();

    const result = await evaluateMukuFreshness(db, tenantId);
    const after = await db.prepare(`
      SELECT active_snapshot_id FROM muku_dataset_state
      WHERE tenant_id = ? AND dataset = 'inventory'
    `).bind(tenantId).first<{ active_snapshot_id: string }>();
    expect(after?.active_snapshot_id).toBe(before?.active_snapshot_id);
    expect(result.readyForProcurement).toBe(false);
    expect(result.blockingReasons).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'LAST_SYNC_FAILED' }),
    ]));
  });

  it('环境变量仅接受安全范围内的整数', () => {
    expect(resolveMukuFreshnessOptions({})).toEqual({
      maxAgeMinutes: 30,
      minRefreshIntervalMinutes: 10,
    });
    expect(resolveMukuFreshnessOptions({
      MUKU_FRESHNESS_MAX_AGE_MINUTES: '45',
      MUKU_AUTO_REFRESH_MIN_INTERVAL_MINUTES: '5',
    })).toEqual({ maxAgeMinutes: 45, minRefreshIntervalMinutes: 5 });
    expect(resolveMukuFreshnessOptions({
      MUKU_FRESHNESS_MAX_AGE_MINUTES: '0',
      MUKU_AUTO_REFRESH_MIN_INTERVAL_MINUTES: 'forever',
    })).toEqual({ maxAgeMinutes: 30, minRefreshIntervalMinutes: 10 });
  });
});

class FreshMukuClient {
  readonly requested: MukuSyncDataset[] = [];

  constructor(private readonly generatedAt: string) {}

  async verifyManifest(): Promise<MukuManifestResponse> {
    return {
      ok: true,
      apiVersion: 'v1',
      dataset: 'manifest',
      generatedAt: this.generatedAt,
      source: 'muku-dashboard-readonly',
      grain: 'dataset',
      businessTimezone: 'Asia/Shanghai',
      refreshCadence: '15m',
      zeroSemantics: 'null-is-unknown',
      filters: {},
      datasets: [
        { id: 'inventory' },
        { id: 'inventory-details' },
        { id: 'inventory-risk' },
        { id: 'source-status' },
      ],
      datasetIds: ['manifest', 'inventory', 'inventory-details', 'inventory-risk', 'source-status'],
    };
  }

  async getAllPages<T extends MukuRecord = MukuRecord>(
    dataset: MukuBusinessDatasetId,
    _filters?: MukuExportFilters,
    _options?: { pageSize?: number; maxPages?: number },
  ): Promise<MukuDatasetExport<T>> {
    void _filters;
    void _options;
    const supported = dataset as MukuSyncDataset;
    this.requested.push(supported);
    const records: Record<MukuSyncDataset, MukuRecord[]> = {
      inventory: [{
        recordKey: 'inventory-freshness-1',
        sku: 'FRESH-1',
        warehouseCode: 'WH-US',
        availableQty: 5,
      }],
      'inventory-details': [{
        recordKey: 'detail-freshness-1',
        sku: 'FRESH-1',
        warehouseCode: 'WH-US',
        quantity: 5,
      }],
      'inventory-risk': [{
        sku: 'FRESH-1',
        available: 5,
        slowMoving: false,
      }],
      'source-status': [{
        sourceKind: 'inventory',
        sourceId: 'muku-readonly',
        status: 'ready',
      }],
    };
    const data = records[supported];
    return {
      ok: true,
      apiVersion: 'v1',
      dataset: supported,
      generatedAt: this.generatedAt,
      source: 'muku-dashboard-readonly',
      grain: 'record',
      businessTimezone: 'Asia/Shanghai',
      refreshCadence: '15m',
      zeroSemantics: 'null-is-unknown',
      filters: {},
      data: data as T[],
      pageCount: 1,
      pageSize: 500,
      total: data.length,
    };
  }
}

async function applyMigrations(db: D1Database) {
  for (const migration of [
    '../drizzle/0000_wooden_deathstrike.sql',
    '../drizzle/0001_premium_the_stranger.sql',
    '../drizzle/0002_organic_titanium_man.sql',
    '../drizzle/0003_fancy_jane_foster.sql',
    '../drizzle/0004_illegal_black_panther.sql',
    '../drizzle/0005_chilly_obadiah_stane.sql',
    '../drizzle/0006_soft_wither.sql',
    '../drizzle/0007_worried_stone_men.sql',
    '../drizzle/0008_nifty_mimic.sql',
    '../drizzle/0009_shocking_iron_lad.sql',
    '../drizzle/0010_mute_eternity.sql',
  ]) {
    const sql = readFileSync(new URL(migration, import.meta.url), 'utf8');
    for (const statement of sql.split('--> statement-breakpoint').map((item) => item.trim()).filter(Boolean)) {
      await db.prepare(statement).run();
    }
  }
}
