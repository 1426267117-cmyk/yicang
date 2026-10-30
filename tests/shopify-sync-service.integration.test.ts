import { readFileSync } from 'node:fs';
import { Miniflare } from 'miniflare';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PlatformOrderRepository } from '../lib/connectors/repository';
import type { ShopifyCredentialConfig } from '../lib/connectors/shopify/config';
import type { ShopifyShopContext } from '../lib/connectors/shopify/connector';
import { runShopifyOrderSync } from '../lib/connectors/shopify/sync-service';
import type { CanonicalOrderGraph } from '../lib/connectors/types';
import { shopifyOrderFixture } from './fixtures/shopify-order';

const tenantId = 'tenant_sync_test';
const config: ShopifyCredentialConfig = {
  key: 'zimasya', displayName: 'ZIMASYA', domain: '346c85.myshopify.com',
  expectedDomain: '346c85.myshopify.com', environmentPrefix: 'SHOPIFY_ZIMASYA',
  adminAccessToken: 'not-used', clientId: null, clientSecret: null,
};
const context: ShopifyShopContext = {
  id: 'gid://shopify/Shop/1', name: 'ZIMASYA', domain: '346c85.myshopify.com',
  timezone: 'America/Los_Angeles', timezoneOffset: '-0700', currency: 'USD',
  scopes: new Set(['read_orders', 'read_all_orders']),
};

describe('Shopify 同步编排', () => {
  let mf: Miniflare;
  let db: D1Database;
  let repository: PlatformOrderRepository;

  beforeEach(async () => {
    mf = new Miniflare({ modules: true, script: 'export default { fetch(){ return new Response("ok") } }', d1Databases: ['DB'] });
    db = await mf.getD1Database('DB');
    await applyMigrations(db);
    await db.prepare('INSERT INTO tenants (id, name, created_at) VALUES (?, ?, ?)').bind(tenantId, 'Test', '2026-10-30T00:00:00.000Z').run();
    repository = new PlatformOrderRepository(db, tenantId);
  });

  afterEach(async () => { await mf.dispose(); });

  it('完成外层分页、增量更新，并在重复增量时保持记录数不变', async () => {
    const first = shopifyOrderFixture();
    const second = shopifyOrderFixture({
      id: 'gid://shopify/Order/1002', name: '#1002',
      createdAt: '2026-10-22T10:00:00Z', updatedAt: '2026-10-22T11:00:00Z',
      refunds: [], fulfillments: [],
    });
    const outerCursors: Array<string | null> = [];
    const firstConnector = fakeConnector(
      new Map([[first.sourceOrderId, first], [second.sourceOrderId, second]]),
      async (after) => {
        outerCursors.push(after);
        return after === null
          ? { nodes: [{ id: first.sourceOrderId, updatedAt: first.sourceUpdatedAt }], hasNextPage: true, endCursor: 'cursor-1' }
          : { nodes: [{ id: second.sourceOrderId, updatedAt: second.sourceUpdatedAt }], hasNextPage: false, endCursor: null };
      },
    );
    const firstRun = await runShopifyOrderSync({
      request: { storeKey: 'zimasya', mode: 'backfill', from: '2026-10-20T00:00:00.000Z', to: '2026-10-23T00:00:00.000Z', maxPages: 100 },
      config, connector: firstConnector, repository,
      now: fixedClock('2026-10-30T00:00:00.000Z'),
    });
    expect(firstRun.stats).toMatchObject({ pagesCompleted: 2, ordersSeen: 2, ordersInserted: 2 });
    expect(outerCursors).toEqual([null, 'cursor-1']);
    expect(await count(db, 'platform_orders')).toBe(2);

    const changed = shopifyOrderFixture({
      updatedAt: '2026-10-24T00:00:00Z', cancelledAt: '2026-10-24T00:00:00Z',
      displayFinancialStatus: 'REFUNDED',
    });
    const incrementalConnector = fakeConnector(
      new Map([[changed.sourceOrderId, changed]]),
      async () => ({ nodes: [{ id: changed.sourceOrderId, updatedAt: changed.sourceUpdatedAt }], hasNextPage: false, endCursor: null }),
    );
    const incremental = await runShopifyOrderSync({
      request: { storeKey: 'zimasya', mode: 'incremental', maxPages: 100 },
      config, connector: incrementalConnector, repository,
      now: fixedClock('2026-10-31T00:00:00.000Z'),
    });
    expect(incremental.stats.ordersUpdated).toBe(1);
    expect(await count(db, 'platform_orders')).toBe(2);
    expect(await count(db, 'platform_order_snapshots')).toBe(3);

    const repeated = await runShopifyOrderSync({
      request: { storeKey: 'zimasya', mode: 'incremental', maxPages: 100 },
      config, connector: incrementalConnector, repository,
      now: fixedClock('2026-11-01T00:00:00.000Z'),
    });
    expect(repeated.stats.ordersUnchanged).toBe(1);
    expect(await count(db, 'platform_orders')).toBe(2);
    expect(await count(db, 'platform_order_snapshots')).toBe(3);
  });

  it('外层订单分页返回重复游标时停止并保留已确认断点', async () => {
    const connector = fakeConnector(
      new Map(),
      async () => ({ nodes: [], hasNextPage: true, endCursor: 'loop-cursor' }),
    );
    await expect(runShopifyOrderSync({
      request: {
        storeKey: 'zimasya', mode: 'backfill',
        from: '2026-10-20T00:00:00.000Z', to: '2026-10-23T00:00:00.000Z', maxPages: 100,
      },
      config, connector, repository,
      now: fixedClock('2026-10-30T00:00:00.000Z'),
    })).rejects.toMatchObject({ code: 'SHOPIFY_INVALID_CURSOR' });

    const store = await db.prepare(`
      SELECT id FROM platform_stores WHERE connector_key = 'zimasya' LIMIT 1
    `).first<{ id: string }>();
    const state = store ? await repository.getSyncState(store.id) : null;
    expect(state?.status).toBe('failed');
    expect(state?.nextPageCursor).toBe('loop-cursor');
    expect(state?.completedWatermark).toBeNull();
  });
});

function fakeConnector(
  orders: Map<string, CanonicalOrderGraph>,
  fetchPage: (after: string | null) => Promise<{ nodes: Array<{ id: string; updatedAt: string }>; hasNextPage: boolean; endCursor: string | null }>,
) {
  return {
    async getShopContext() { return context; },
    async fetchOrdersPage(input: { after: string | null }) { return fetchPage(input.after); },
    async fetchOrder(id: string) {
      const order = orders.get(id);
      if (!order) throw new Error(`Missing fixture ${id}`);
      return order;
    },
  };
}

function fixedClock(value: string) {
  let offset = 0;
  return () => new Date(new Date(value).getTime() + offset++ * 1000);
}

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
