import { readFileSync } from 'node:fs';
import { Miniflare } from 'miniflare';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PlatformOrderRepository } from '../lib/connectors/repository';
import type { ShopifyCredentialConfig } from '../lib/connectors/shopify/config';
import type { ShopifyShopContext } from '../lib/connectors/shopify/connector';
import { shopifyOrderFixture } from './fixtures/shopify-order';

const tenantId = 'tenant_test';
const config: ShopifyCredentialConfig = {
  key: 'zimasya', displayName: 'ZIMASYA', domain: '346c85.myshopify.com',
  expectedDomain: '346c85.myshopify.com', environmentPrefix: 'SHOPIFY_ZIMASYA',
  adminAccessToken: null, clientId: null, clientSecret: null,
};
const context: ShopifyShopContext = {
  id: 'gid://shopify/Shop/1', name: 'ZIMASYA', domain: '346c85.myshopify.com',
  timezone: 'America/Los_Angeles', timezoneOffset: '-0700', currency: 'USD',
  scopes: new Set(['read_orders', 'read_all_orders']),
};

describe('平台订单 D1 幂等入库', () => {
  let mf: Miniflare;
  let db: D1Database;
  let repository: PlatformOrderRepository;
  let storeId: string;
  let runId: string;

  beforeEach(async () => {
    mf = new Miniflare({ modules: true, script: 'export default { fetch(){ return new Response("ok") } }', d1Databases: ['DB'] });
    db = await mf.getD1Database('DB');
    await applyMigrations(db);
    await db.prepare('INSERT INTO tenants (id, name, created_at) VALUES (?, ?, ?)').bind(tenantId, 'Test', '2026-10-30T00:00:00.000Z').run();
    repository = new PlatformOrderRepository(db, tenantId);
    const store = await repository.upsertVerifiedShopifyStore(config, context, '2026-10-30T00:00:00.000Z');
    storeId = store.id;
    runId = await repository.beginSyncRun({
      storeId, mode: 'backfill', windowStart: '2026-10-20T00:00:00.000Z',
      windowEnd: '2026-10-22T00:00:00.000Z', startingCursor: null,
      overlapSeconds: 21_600, expectedLastRunId: null, expectedCompletedWatermark: null,
      now: '2026-10-30T00:00:01.000Z',
    });
  });

  afterEach(async () => { await mf.dispose(); });

  it('同一订单重复采集不新增，状态变化只追加新快照', async () => {
    const first = shopifyOrderFixture();
    expect(await repository.upsertOrderGraph({ storeId, graph: first, apiVersion: '2026-07', runId, fetchedAt: '2026-10-30T00:00:02.000Z' })).toBe('inserted');
    expect(await repository.upsertOrderGraph({ storeId, graph: first, apiVersion: '2026-07', runId, fetchedAt: '2026-10-30T00:00:03.000Z' })).toBe('unchanged');
    expect(await count(db, 'platform_orders')).toBe(1);
    expect(await count(db, 'platform_order_lines')).toBe(2);
    expect(await count(db, 'platform_refunds')).toBe(1);
    expect(await count(db, 'platform_order_transactions')).toBe(2);
    expect(await count(db, 'platform_fulfillments')).toBe(2);
    expect(await count(db, 'platform_fulfillment_tracking')).toBe(2);
    expect(await count(db, 'platform_order_snapshots')).toBe(1);

    const changed = shopifyOrderFixture({
      updatedAt: '2026-10-22T01:00:00Z',
      cancelledAt: '2026-10-22T01:00:00Z',
      displayFinancialStatus: 'REFUNDED',
    });
    expect(await repository.upsertOrderGraph({ storeId, graph: changed, apiVersion: '2026-07', runId, fetchedAt: '2026-10-30T00:00:04.000Z' })).toBe('updated');
    expect(await count(db, 'platform_orders')).toBe(1);
    expect(await count(db, 'platform_order_snapshots')).toBe(2);
    const row = await db.prepare('SELECT financial_status, source_cancelled_at, received_minor FROM platform_orders LIMIT 1').first<{ financial_status: string; source_cancelled_at: string; received_minor: number | null }>();
    expect(row).toEqual({ financial_status: 'REFUNDED', source_cancelled_at: '2026-10-22T01:00:00Z', received_minor: null });
  });

  it('失败只保留断点，不推进完成水位，也不清空旧事实', async () => {
    const graph = shopifyOrderFixture();
    await repository.upsertOrderGraph({ storeId, graph, apiVersion: '2026-07', runId, fetchedAt: '2026-10-30T00:00:02.000Z' });
    const stats = { pagesCompleted: 1, ordersSeen: 1, ordersInserted: 1, ordersUpdated: 0, ordersUnchanged: 0 };
    await repository.checkpointPage({ runId, storeId, nextCursor: 'cursor-1', stats, now: '2026-10-30T00:00:03.000Z' });
    await repository.failSyncRun({ runId, storeId, errorCode: 'TEST_FAILURE', errorMessage: 'sanitized', stats, now: '2026-10-30T00:00:04.000Z' });
    const state = await repository.getSyncState(storeId);
    expect(state?.completedWatermark).toBeNull();
    expect(state?.nextPageCursor).toBe('cursor-1');
    expect(state?.status).toBe('failed');
    expect(await count(db, 'platform_orders')).toBe(1);
  });

  it('拒绝并发运行，租约接管后旧任务不能覆盖新游标', async () => {
    await expect(repository.beginSyncRun({
      storeId, mode: 'incremental', windowStart: '2026-10-20T00:00:00.000Z',
      windowEnd: '2026-10-22T00:00:00.000Z', startingCursor: null,
      overlapSeconds: 21_600, expectedLastRunId: runId, expectedCompletedWatermark: null,
      now: '2026-10-30T00:10:00.000Z',
    })).rejects.toMatchObject({ code: 'SHOPIFY_SYNC_ALREADY_RUNNING' });

    await db.prepare(`
      UPDATE connector_sync_state SET updated_at = '2026-10-29T23:00:00.000Z'
      WHERE platform_store_id = ?
    `).bind(storeId).run();
    const takeoverRunId = await repository.beginSyncRun({
      storeId, mode: 'incremental', windowStart: '2026-10-20T00:00:00.000Z',
      windowEnd: '2026-10-22T00:00:00.000Z', startingCursor: 'new-cursor',
      overlapSeconds: 21_600, expectedLastRunId: runId, expectedCompletedWatermark: null,
      now: '2026-10-30T02:00:00.000Z',
    });

    const stats = { pagesCompleted: 1, ordersSeen: 0, ordersInserted: 0, ordersUpdated: 0, ordersUnchanged: 0 };
    await expect(repository.checkpointPage({
      runId, storeId, nextCursor: 'old-cursor', stats, now: '2026-10-30T02:00:01.000Z',
    })).rejects.toMatchObject({ code: 'SHOPIFY_SYNC_LEASE_LOST' });
    const state = await repository.getSyncState(storeId);
    expect(state?.lastRunId).toBe(takeoverRunId);
    expect(state?.nextPageCursor).toBe('new-cursor');
  });

  it('较旧的订单详情不会覆盖已保存的新版本', async () => {
    const newest = shopifyOrderFixture({
      updatedAt: '2026-10-22T02:00:00Z',
      displayFinancialStatus: 'REFUNDED',
    });
    const stale = shopifyOrderFixture({
      updatedAt: '2026-10-21T02:00:00Z',
      displayFinancialStatus: 'PENDING',
    });
    await repository.upsertOrderGraph({
      storeId, graph: newest, apiVersion: '2026-07', runId, fetchedAt: '2026-10-30T00:00:02.000Z',
    });
    expect(await repository.upsertOrderGraph({
      storeId, graph: stale, apiVersion: '2026-07', runId, fetchedAt: '2026-10-30T00:00:03.000Z',
    })).toBe('unchanged');

    const row = await db.prepare(`
      SELECT source_updated_at, financial_status FROM platform_orders LIMIT 1
    `).first<{ source_updated_at: string; financial_status: string }>();
    expect(row).toEqual({ source_updated_at: '2026-10-22T02:00:00Z', financial_status: 'REFUNDED' });
    expect(await count(db, 'platform_order_snapshots')).toBe(1);
  });

  it('同一官方 Shop ID 不能跨 ERP 店铺配置重复绑定', async () => {
    const otherConfig = { ...config, key: 'kaguyasu' as const, displayName: 'Kaguyasu' };
    await expect(repository.upsertVerifiedShopifyStore(
      otherConfig,
      context,
      '2026-10-30T00:00:02.000Z',
    )).rejects.toMatchObject({ code: 'SHOPIFY_IDENTITY_ALREADY_BOUND' });
  });
});

async function applyMigrations(db: D1Database) {
  for (const migration of ['../drizzle/0000_wooden_deathstrike.sql', '../drizzle/0001_premium_the_stranger.sql']) {
    const sql = readFileSync(new URL(migration, import.meta.url), 'utf8');
    for (const statement of sql.split('--> statement-breakpoint').map((item) => item.trim()).filter(Boolean)) {
      await db.prepare(statement).run();
    }
  }
}

async function count(db: D1Database, table: string) {
  const row = await db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<{ count: number }>();
  return Number(row?.count ?? 0);
}
