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
  acceptedDomains: ['346c85.myshopify.com'], authMode: 'oauth', credentialRef: 'env:SHOPIFY_ZIMASYA',
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
      updatedAt: '2026-10-30T23:00:00Z', cancelledAt: '2026-10-30T23:00:00Z',
      displayFinancialStatus: 'REFUNDED',
    });
    const incrementalWindows: Array<{ from: string; to: string }> = [];
    const incrementalConnector = fakeConnector(
      new Map([[changed.sourceOrderId, changed]]),
      async (_after, input) => {
        incrementalWindows.push({ from: input.updatedFrom, to: input.updatedTo });
        return { nodes: [{ id: changed.sourceOrderId, updatedAt: changed.sourceUpdatedAt }], hasNextPage: false, endCursor: null };
      },
    );
    const incremental = await runShopifyOrderSync({
      request: { storeKey: 'zimasya', mode: 'incremental', maxPages: 100 },
      config, connector: incrementalConnector, repository,
      now: fixedClock('2026-10-31T00:00:00.000Z'),
    });
    expect(incremental.stats.ordersUpdated).toBe(1);
    expect(incrementalWindows[0]).toEqual({
      from: '2026-10-22T18:00:00.000Z',
      to: '2026-10-31T00:00:00.000Z',
    });
    expect(await count(db, 'platform_orders')).toBe(2);
    expect(await count(db, 'platform_order_snapshots')).toBe(3);

    const repeated = await runShopifyOrderSync({
      request: { storeKey: 'zimasya', mode: 'incremental', maxPages: 100 },
      config, connector: incrementalConnector, repository,
      now: fixedClock('2026-11-01T00:00:00.000Z'),
    });
    expect(repeated.stats.ordersUnchanged).toBe(1);
    expect(incrementalWindows[1]).toEqual({
      from: '2026-10-30T18:00:00.000Z',
      to: '2026-11-01T00:00:00.000Z',
    });
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

  it('失败后从保存的游标继续同一窗口，完成后清空断点并推进水位', async () => {
    const first = shopifyOrderFixture();
    const second = shopifyOrderFixture({
      id: 'gid://shopify/Order/1002', name: '#1002',
      createdAt: '2026-10-22T10:00:00Z', updatedAt: '2026-10-22T11:00:00Z',
      refunds: [], fulfillments: [],
    });
    const firstConnector = fakeConnector(
      new Map([[first.sourceOrderId, first]]),
      async (after) => {
        if (after === null) {
          return {
            nodes: [{ id: first.sourceOrderId, updatedAt: first.sourceUpdatedAt }],
            hasNextPage: true,
            endCursor: 'resume-cursor',
          };
        }
        throw new Error('simulated page failure');
      },
    );

    await expect(runShopifyOrderSync({
      request: {
        storeKey: 'zimasya', mode: 'backfill',
        from: '2026-10-20T00:00:00.000Z', to: '2026-10-23T00:00:00.000Z', maxPages: 100,
      },
      config, connector: firstConnector, repository,
      now: fixedClock('2026-10-30T00:00:00.000Z'),
    })).rejects.toThrow('simulated page failure');

    const resumedInputs: Array<{ after: string | null; from: string; to: string }> = [];
    const resumedConnector = fakeConnector(
      new Map([[second.sourceOrderId, second]]),
      async (after, input) => {
        resumedInputs.push({ after, from: input.updatedFrom, to: input.updatedTo });
        return {
          nodes: [{ id: second.sourceOrderId, updatedAt: second.sourceUpdatedAt }],
          hasNextPage: false,
          endCursor: null,
        };
      },
    );
    const resumed = await runShopifyOrderSync({
      request: { storeKey: 'zimasya', mode: 'backfill', maxPages: 100 },
      config, connector: resumedConnector, repository,
      now: fixedClock('2026-10-30T01:00:00.000Z'),
    });

    expect(resumedInputs).toEqual([{
      after: 'resume-cursor',
      from: '2026-10-20T00:00:00.000Z',
      to: '2026-10-23T00:00:00.000Z',
    }]);
    expect(resumed.stats).toMatchObject({ pagesCompleted: 1, ordersInserted: 1 });
    expect(await count(db, 'platform_orders')).toBe(2);
    const store = await db.prepare(`
      SELECT id FROM platform_stores WHERE connector_key = 'zimasya' LIMIT 1
    `).first<{ id: string }>();
    const state = store ? await repository.getSyncState(store.id) : null;
    expect(state).toMatchObject({
      status: 'idle',
      completedWatermark: '2026-10-23T00:00:00.000Z',
      activeWindowStart: null,
      activeWindowEnd: null,
      nextPageCursor: null,
    });
  });

  it('订单更新删除子事实时保留历史记录但只标记最新事实为 current', async () => {
    const original = shopifyOrderFixture();
    const changed = shopifyOrderFixture({
      updatedAt: '2026-10-30T23:00:00Z',
      lineItems: {
        nodes: [{
          id: 'gid://shopify/LineItem/1', sku: ' ABC-01 ', title: 'Desk', name: 'Desk',
          quantity: 2, currentQuantity: 1, unfulfilledQuantity: 1,
          originalUnitPriceSet: { shopMoney: { amount: '50.00', currencyCode: 'USD' } },
          originalTotalSet: { shopMoney: { amount: '100.00', currencyCode: 'USD' } },
          discountedTotalSet: { shopMoney: { amount: '95.00', currencyCode: 'USD' } },
          totalDiscountSet: { shopMoney: { amount: '5.00', currencyCode: 'USD' } },
        }],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
      refunds: [],
      fulfillments: [],
    });
    const firstConnector = fakeConnector(
      new Map([[original.sourceOrderId, original]]),
      async () => ({
        nodes: [{ id: original.sourceOrderId, updatedAt: original.sourceUpdatedAt }],
        hasNextPage: false,
        endCursor: null,
      }),
    );
    await runShopifyOrderSync({
      request: {
        storeKey: 'zimasya', mode: 'backfill',
        from: '2026-10-20T00:00:00.000Z', to: '2026-10-23T00:00:00.000Z', maxPages: 100,
      },
      config, connector: firstConnector, repository,
      now: fixedClock('2026-10-30T00:00:00.000Z'),
    });
    const changedConnector = fakeConnector(
      new Map([[changed.sourceOrderId, changed]]),
      async () => ({
        nodes: [{ id: changed.sourceOrderId, updatedAt: changed.sourceUpdatedAt }],
        hasNextPage: false,
        endCursor: null,
      }),
    );
    await runShopifyOrderSync({
      request: { storeKey: 'zimasya', mode: 'incremental', maxPages: 100 },
      config, connector: changedConnector, repository,
      now: fixedClock('2026-10-31T00:00:00.000Z'),
    });

    expect(await currentCount(db, 'platform_order_lines')).toBe(1);
    expect(await currentCount(db, 'platform_refunds')).toBe(0);
    expect(await currentCount(db, 'platform_refund_lines')).toBe(0);
    expect(await currentCount(db, 'platform_order_transactions')).toBe(0);
    expect(await currentCount(db, 'platform_fulfillments')).toBe(0);
    expect(await currentCount(db, 'platform_fulfillment_lines')).toBe(0);
    expect(await currentCount(db, 'platform_fulfillment_tracking')).toBe(0);
    expect(await count(db, 'platform_order_lines')).toBe(2);
    expect(await count(db, 'platform_fulfillments')).toBe(2);
  });
});

function fakeConnector(
  orders: Map<string, CanonicalOrderGraph>,
  fetchPage: (
    after: string | null,
    input: { updatedFrom: string; updatedTo: string; after: string | null; first?: number },
  ) => Promise<{ nodes: Array<{ id: string; updatedAt: string }>; hasNextPage: boolean; endCursor: string | null }>,
) {
  return {
    async getShopContext() { return context; },
    async fetchOrdersPage(input: { updatedFrom: string; updatedTo: string; after: string | null; first?: number }) {
      return fetchPage(input.after, input);
    },
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
  ]) {
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

async function currentCount(db: D1Database, table: string) {
  const row = await db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE is_current = 1`)
    .first<{ count: number }>();
  return Number(row?.count ?? 0);
}
