import { readFileSync } from 'node:fs';
import { Miniflare } from 'miniflare';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({ env: {} }));

import { MukuConnectorError } from '../lib/connectors/muku/errors';
import type {
  MukuBusinessDatasetId,
  MukuDatasetExport,
  MukuExportFilters,
  MukuManifestResponse,
  MukuRecord,
} from '../lib/connectors/muku/types';
import type { UserContext } from '../lib/db';
import { ROLE_PERMISSIONS } from '../lib/domain';
import {
  getMukuInventory,
  getMukuInventoryRisk,
  getMukuRuns,
  getMukuStatus,
  syncMukuDatasets,
  testMukuConnection,
  type MukuSyncDataset,
} from '../lib/muku-sync-service';

const tenantId = 'tenant_muku_sync';
const user = buildUser(tenantId, 'muku-admin');

describe('MUKU 只读快照同步', () => {
  let mf: Miniflare;
  let db: D1Database;
  let client: FakeMukuClient;

  beforeEach(async () => {
    mf = new Miniflare({
      modules: true,
      script: 'export default { fetch(){ return new Response("ok") } }',
      d1Databases: ['DB'],
    });
    db = await mf.getD1Database('DB');
    await applyMigrations(db);
    await seedTenant(db, tenantId);
    client = new FakeMukuClient();
  });

  afterEach(async () => { await mf.dispose(); });

  it('完整分页后原子启用快照，保留 null/0 语义并隐藏 raw JSON', async () => {
    client.set('inventory', [
      inventoryRecord('inventory-a', 'SKU-A', { availableQty: null, lockedQty: 0 }),
      inventoryRecord('inventory-b', 'SKU-B', { availableQty: 7, lockedQty: null }),
    ], { pageCount: 2, pageSize: 1 });

    const result = await syncMukuDatasets({
      db, user, client, datasets: ['inventory'], idempotencyKey: 'muku-inventory-first',
    });
    expect(result).toEqual(expect.objectContaining({
      ok: true,
      readOnly: true,
      results: [expect.objectContaining({ status: 'succeeded', pageCount: 2, recordCount: 2 })],
    }));

    const inventory = await getMukuInventory(db, user, { page: 1, pageSize: 20 });
    expect(inventory.pagination).toEqual(expect.objectContaining({ total: 2, totalPages: 1 }));
    const bySku = new Map(inventory.data.map((row) => [row.sku, row]));
    expect(bySku.get('SKU-A')).toEqual(expect.objectContaining({ availableQty: null, lockedQty: 0 }));
    expect(bySku.get('SKU-B')).toEqual(expect.objectContaining({ availableQty: 7, lockedQty: null }));
    expect(inventory.data.every((row) => !('rawJson' in row))).toBe(true);

    const state = await db.prepare(`
      SELECT status, record_count, page_count, active_snapshot_id
      FROM muku_dataset_state WHERE tenant_id = ? AND dataset = 'inventory'
    `).bind(tenantId).first<{
      status: string; record_count: number; page_count: number; active_snapshot_id: string | null;
    }>();
    expect(state).toEqual(expect.objectContaining({ status: 'ready', record_count: 2, page_count: 2 }));
    expect(state?.active_snapshot_id).toBeTruthy();
  });

  it('相同内容标记 unchanged，相同幂等键只重放而不新增记录', async () => {
    client.set('inventory', [inventoryRecord('inventory-a', 'SKU-A')]);
    const first = await syncMukuDatasets({
      db, user, client, datasets: ['inventory'], idempotencyKey: 'muku-idempotent-0001',
    });
    const unchanged = await syncMukuDatasets({
      db, user, client, datasets: ['inventory'], idempotencyKey: 'muku-idempotent-0002',
    });
    const replay = await syncMukuDatasets({
      db, user, client, datasets: ['inventory'], idempotencyKey: 'muku-idempotent-0001',
    });

    expect(first.results[0]).toEqual(expect.objectContaining({ status: 'succeeded', replayed: false }));
    expect(unchanged.results[0]).toEqual(expect.objectContaining({ status: 'unchanged', replayed: false }));
    expect(replay.results[0]).toEqual(expect.objectContaining({
      id: first.results[0].id, status: 'succeeded', replayed: true,
    }));
    expect(await scalarCount(db, 'muku_snapshots', tenantId)).toBe(1);
    expect(await scalarCount(db, 'muku_inventory_records', tenantId)).toBe(1);
    expect(await scalarCount(db, 'muku_sync_runs', tenantId)).toBe(2);
    expect(await scalarCount(db, 'audit_logs', tenantId)).toBe(2);
  });

  it('上游失败或空数据都保留旧 active 快照和旧有效记录', async () => {
    client.set('inventory', [inventoryRecord('inventory-old', 'OLD-SKU', { availableQty: 12 })]);
    await syncMukuDatasets({
      db, user, client, datasets: ['inventory'], idempotencyKey: 'muku-retain-old-0001',
    });
    const before = await activeSnapshotId(db, tenantId, 'inventory');

    client.fail('inventory', new MukuConnectorError(
      'MUKU_UPSTREAM_UNAVAILABLE',
      'MUKU 暂时不可用',
      true,
      503,
    ));
    const failed = await syncMukuDatasets({
      db, user, client, datasets: ['inventory'], idempotencyKey: 'muku-retain-old-0002',
    });
    expect(failed).toEqual(expect.objectContaining({
      ok: false,
      results: [expect.objectContaining({ status: 'failed', errorCode: 'MUKU_UPSTREAM_UNAVAILABLE' })],
    }));
    expect(await activeSnapshotId(db, tenantId, 'inventory')).toBe(before);

    client.set('inventory', []);
    const empty = await syncMukuDatasets({
      db, user, client, datasets: ['inventory'], idempotencyKey: 'muku-retain-old-0003',
    });
    expect(empty.results[0]).toEqual(expect.objectContaining({
      status: 'failed', errorCode: 'MUKU_EMPTY_DATASET',
    }));
    expect(await activeSnapshotId(db, tenantId, 'inventory')).toBe(before);

    const inventory = await getMukuInventory(db, user, { page: 1, pageSize: 20 });
    expect(inventory.data).toEqual([expect.objectContaining({ sku: 'OLD-SKU', availableQty: 12 })]);
    const state = await db.prepare(`
      SELECT status, last_error_code FROM muku_dataset_state
      WHERE tenant_id = ? AND dataset = 'inventory'
    `).bind(tenantId).first<{ status: string; last_error_code: string }>();
    expect(state).toEqual({ status: 'delayed', last_error_code: 'MUKU_EMPTY_DATASET' });
  });

  it('映射风险和来源状态的 nullable 字段，状态 API 只读取 active 快照', async () => {
    client.set('inventory-risk', [{
      sku: 'RISK-01', sales30d: 0, available: null, locked: 3, onHand: 3, inbound: null,
      warehouseCount: 1, maxAgeDays: null, slowMoving: true, overAge: false,
      activeLowStock: null, matchedBy: 'raw-sku', sourceUpdatedAt: '2026-11-02T01:00:00Z',
    }]);
    client.set('source-status', [{
      sourceKind: 'shopify', sourceId: 'store-one', status: 'ready', businessDate: null,
      message: null, recordCount: 0, sourceUpdatedAt: '2026-11-02T01:00:00Z',
      ingestedAt: '2026-11-02T01:01:00Z',
    }]);
    await syncMukuDatasets({
      db,
      user,
      client,
      datasets: ['inventory-risk', 'source-status'],
      idempotencyKey: 'muku-risk-status-0001',
    });

    const risk = await getMukuInventoryRisk(db, user, { page: 1, pageSize: 20 });
    expect(risk.data[0]).toEqual(expect.objectContaining({
      sku: 'RISK-01', sales30d: 0, availableQty: null, lockedQty: 3,
      inboundQty: null, maxAgeDays: null, slowMoving: 1, overAge: 0, activeLowStock: null,
    }));
    const status = await getMukuStatus(db, user);
    expect(status.sourceStatuses).toEqual([expect.objectContaining({
      sourceKind: 'shopify', sourceId: 'store-one', businessDate: null, recordCount: 0,
    })]);
  });

  it('拒绝同租户同数据集重叠运行，并自动回收过期租约', async () => {
    const now = new Date();
    await insertRunningRun(db, tenantId, {
      id: 'run-live', key: 'muku-overlap-existing',
      leaseExpiresAt: new Date(now.getTime() + 60_000).toISOString(),
    });
    client.set('inventory', [inventoryRecord('inventory-a', 'SKU-A')]);
    await expect(syncMukuDatasets({
      db, user, client, datasets: ['inventory'], idempotencyKey: 'muku-overlap-new-run',
    })).rejects.toMatchObject({ status: 409, code: 'MUKU_SYNC_ALREADY_RUNNING' });

    await db.prepare(`
      UPDATE muku_sync_runs SET lease_expires_at = ? WHERE id = 'run-live'
    `).bind(new Date(now.getTime() - 60_000).toISOString()).run();
    const recovered = await syncMukuDatasets({
      db, user, client, datasets: ['inventory'], idempotencyKey: 'muku-overlap-recovered',
    });
    expect(recovered.results[0]).toEqual(expect.objectContaining({ status: 'succeeded' }));
    const expired = await db.prepare(`
      SELECT status, error_code FROM muku_sync_runs WHERE id = 'run-live'
    `).first<{ status: string; error_code: string }>();
    expect(expired).toEqual({ status: 'failed', error_code: 'MUKU_SYNC_LEASE_EXPIRED' });
  });

  it('所有查询和幂等键都按 tenant 隔离', async () => {
    const otherTenant = 'tenant_muku_other';
    const otherUser = buildUser(otherTenant, 'other-admin');
    await seedTenant(db, otherTenant);

    client.set('inventory', [inventoryRecord('same-key', 'TENANT-A')]);
    await syncMukuDatasets({
      db, user, client, datasets: ['inventory'], idempotencyKey: 'muku-shared-key-0001',
    });
    client.set('inventory', [inventoryRecord('same-key', 'TENANT-B')]);
    await syncMukuDatasets({
      db, user: otherUser, client, datasets: ['inventory'], idempotencyKey: 'muku-shared-key-0001',
    });

    const first = await getMukuInventory(db, user, { page: 1, pageSize: 20 });
    const second = await getMukuInventory(db, otherUser, { page: 1, pageSize: 20 });
    expect(first.data.map((row) => row.sku)).toEqual(['TENANT-A']);
    expect(second.data.map((row) => row.sku)).toEqual(['TENANT-B']);
    const firstRuns = await getMukuRuns(db, user, { page: 1, pageSize: 20 });
    const secondRuns = await getMukuRuns(db, otherUser, { page: 1, pageSize: 20 });
    expect(firstRuns.pagination.total).toBe(1);
    expect(secondRuns.pagination.total).toBe(1);
  });

  it('manifest 测试只返回数据集摘要，不返回连接地址或凭证', async () => {
    const result = await testMukuConnection(client);
    expect(result).toEqual(expect.objectContaining({
      ok: true, apiVersion: 'v1', readOnly: true,
      datasets: expect.arrayContaining(['inventory', 'inventory-details', 'inventory-risk', 'source-status']),
    }));
    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(/api.?key|authorization|bearer|baseUrl/i);
  });
});

class FakeMukuClient {
  readonly exports = new Map<MukuSyncDataset, MukuDatasetExport<MukuRecord>>();
  readonly failures = new Map<MukuSyncDataset, Error>();

  async verifyManifest(): Promise<MukuManifestResponse> {
    return {
      ok: true,
      apiVersion: 'v1',
      dataset: 'manifest',
      generatedAt: '2026-11-02T02:00:00.000Z',
      source: 'muku-dashboard-readonly',
      grain: 'dataset',
      businessTimezone: 'America/Los_Angeles',
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
    const failure = this.failures.get(supported);
    if (failure) throw failure;
    const exported = this.exports.get(supported);
    if (!exported) throw new Error(`fake export missing: ${dataset}`);
    return exported as MukuDatasetExport<T>;
  }

  set(
    dataset: MukuSyncDataset,
    data: MukuRecord[],
    pagination: { pageCount?: number; pageSize?: number } = {},
  ) {
    this.failures.delete(dataset);
    this.exports.set(dataset, {
      ok: true,
      apiVersion: 'v1',
      dataset,
      generatedAt: '2026-11-02T02:00:00.000Z',
      source: 'muku-dashboard-readonly',
      grain: dataset === 'source-status' ? 'source/business-date' : 'record',
      businessTimezone: 'America/Los_Angeles',
      refreshCadence: '15m',
      zeroSemantics: 'null-is-unknown',
      filters: {},
      data,
      pageCount: pagination.pageCount ?? 1,
      pageSize: pagination.pageSize ?? 500,
      total: data.length,
    });
  }

  fail(dataset: MukuSyncDataset, error: Error) {
    this.failures.set(dataset, error);
  }
}

function inventoryRecord(
  recordKey: string,
  sku: string,
  override: Partial<MukuRecord> = {},
): MukuRecord {
  return {
    recordKey,
    sourceId: 'inventory-source',
    snapshotId: 'source-snapshot-1',
    inventoryKind: 'warehouse',
    warehouseCode: 'WH-US',
    warehouseName: '美国仓',
    region: 'US',
    sku,
    availableQty: 4,
    lockedQty: 1,
    onHandQty: 5,
    inboundQty: 2,
    ageDays: 10,
    sourceUpdatedAt: '2026-11-02T01:00:00Z',
    ingestedAt: '2026-11-02T01:01:00Z',
    ...override,
  };
}

function buildUser(id: string, authId: string): UserContext {
  return {
    id: authId,
    email: `${authId}@example.invalid`,
    displayName: authId,
    role: 'admin',
    permissions: ROLE_PERMISSIONS.admin,
    tenantId: id,
    tenantName: id,
  };
}

async function seedTenant(db: D1Database, id: string) {
  await db.prepare('INSERT INTO tenants (id, name, created_at) VALUES (?, ?, ?)')
    .bind(id, id, '2026-11-02T00:00:00.000Z').run();
}

async function scalarCount(db: D1Database, table: string, id: string) {
  const row = await db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE tenant_id = ?`)
    .bind(id).first<{ count: number }>();
  return Number(row?.count ?? 0);
}

async function activeSnapshotId(db: D1Database, id: string, dataset: MukuSyncDataset) {
  const row = await db.prepare(`
    SELECT active_snapshot_id FROM muku_dataset_state WHERE tenant_id = ? AND dataset = ?
  `).bind(id, dataset).first<{ active_snapshot_id: string | null }>();
  return row?.active_snapshot_id ?? null;
}

async function insertRunningRun(
  db: D1Database,
  id: string,
  input: { id: string; key: string; leaseExpiresAt: string },
) {
  await db.prepare(`
    INSERT INTO muku_sync_runs (
      id, tenant_id, dataset, snapshot_id, status, idempotency_key, request_hash,
      lease_id, lease_expires_at, page_count, record_count, content_hash,
      error_code, error_message, started_at, finished_at
    ) VALUES (?, ?, 'inventory', NULL, 'running', ?, 'request-hash', ?, ?, 0, 0, NULL, NULL, NULL, ?, NULL)
  `).bind(
    input.id,
    id,
    input.key,
    `${input.id}-lease`,
    input.leaseExpiresAt,
    '2026-11-02T00:00:00.000Z',
  ).run();
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
