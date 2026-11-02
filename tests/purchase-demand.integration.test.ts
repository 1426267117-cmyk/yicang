import { readFileSync } from 'node:fs';
import { Miniflare } from 'miniflare';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PlatformOrderRepository } from '../lib/connectors/repository';
import type { ShopifyCredentialConfig } from '../lib/connectors/shopify/config';
import type { ShopifyShopContext } from '../lib/connectors/shopify/connector';
import { shopifyOrderFixture } from './fixtures/shopify-order';

const tenantId = 'tenant_purchase_test';
const config: ShopifyCredentialConfig = {
  key: 'bizfurniz', displayName: 'BizFurniz', domain: 'bizfurniz.myshopify.com',
  expectedDomain: 'bizfurniz.myshopify.com', environmentPrefix: 'SHOPIFY_BIZFURNIZ',
  acceptedDomains: ['bizfurniz.myshopify.com'], authMode: 'oauth', credentialRef: 'env:SHOPIFY_BIZFURNIZ',
  adminAccessToken: null, clientId: null, clientSecret: null,
};
const context: ShopifyShopContext = {
  id: 'gid://shopify/Shop/9001', name: 'BizFurniz', domain: 'bizfurniz.myshopify.com',
  timezone: 'America/Los_Angeles', timezoneOffset: '-0700', currency: 'USD',
  scopes: new Set(['read_orders', 'read_all_orders']),
};

describe('Shopify 订单行采购需求池', () => {
  let mf: Miniflare;
  let db: D1Database;
  let repository: PlatformOrderRepository;
  let storeId: string;

  beforeEach(async () => {
    mf = new Miniflare({ modules: true, script: 'export default { fetch(){ return new Response("ok") } }', d1Databases: ['DB'] });
    db = await mf.getD1Database('DB');
    await applyMigrations(db);
    await db.prepare('INSERT INTO tenants (id, name, created_at) VALUES (?, ?, ?)')
      .bind(tenantId, 'Purchase Test', '2026-11-02T00:00:00.000Z').run();
    repository = new PlatformOrderRepository(db, tenantId);
    storeId = (await repository.upsertVerifiedShopifyStore(config, context, '2026-11-02T00:00:01.000Z')).id;
  });

  afterEach(async () => { await mf.dispose(); });

  it('幂等维护未履约数量，映射后开放，完成/测试/取消后归零且不删除历史', async () => {
    const first = purchaseGraph({
      updatedAt: '2026-11-02T01:00:00Z',
      displayFulfillmentStatus: 'UNFULFILLED',
      fulfillments: [],
    });
    expect(await repository.upsertOrderGraph({
      storeId, graph: first, apiVersion: '2026-07', runId: null,
      fetchedAt: '2026-11-02T01:00:01.000Z',
    })).toBe('inserted');

    expect(await demandRows(db)).toEqual([
      expect.objectContaining({
        source_order_line_id: 'gid://shopify/LineItem/1', status: 'not_required',
        required_quantity: 0, reason_code: 'no_unfulfilled_quantity',
      }),
      expect.objectContaining({
        source_order_line_id: 'gid://shopify/LineItem/2', status: 'needs_mapping',
        required_quantity: 1, reason_code: 'sku_unmapped', mapped_sku_id: null,
      }),
    ]);

    expect(await repository.upsertOrderGraph({
      storeId, graph: first, apiVersion: '2026-07', runId: null,
      fetchedAt: '2026-11-02T01:00:02.000Z',
    })).toBe('unchanged');
    expect(await count(db, 'purchase_demands')).toBe(2);

    await db.prepare(`
      INSERT INTO skus (id, tenant_id, code, name, active, created_at)
      VALUES ('sku_service_01', ?, 'SERVICE-01', 'Service item', 1, ?)
    `).bind(tenantId, '2026-11-02T01:00:03.000Z').run();
    await db.prepare(`
      UPDATE platform_sku_mappings
      SET sku_id = 'sku_service_01', status = 'mapped', mapping_source = 'test_mapping', updated_at = ?
      WHERE tenant_id = ? AND platform_store_id = ? AND raw_sku = 'SERVICE-01'
    `).bind('2026-11-02T01:00:03.000Z', tenantId, storeId).run();

    await repository.upsertOrderGraph({
      storeId, graph: first, apiVersion: '2026-07', runId: null,
      fetchedAt: '2026-11-02T01:00:04.000Z',
    });
    expect(await demandForLine(db, 'gid://shopify/LineItem/2')).toEqual(expect.objectContaining({
      status: 'open', required_quantity: 1, reason_code: null, mapped_sku_id: 'sku_service_01',
    }));

    const fulfilled = purchaseGraph({
      updatedAt: '2026-11-02T02:00:00Z', displayFulfillmentStatus: 'FULFILLED', fulfillments: [],
    });
    await repository.upsertOrderGraph({
      storeId, graph: fulfilled, apiVersion: '2026-07', runId: null,
      fetchedAt: '2026-11-02T02:00:01.000Z',
    });
    expect(await demandForLine(db, 'gid://shopify/LineItem/2')).toEqual(expect.objectContaining({
      status: 'not_required', required_quantity: 0, reason_code: 'fulfilled_order',
    }));

    const testOrder = purchaseGraph({
      updatedAt: '2026-11-02T03:00:00Z', displayFulfillmentStatus: 'UNFULFILLED',
      fulfillments: [], test: true,
    });
    await repository.upsertOrderGraph({
      storeId, graph: testOrder, apiVersion: '2026-07', runId: null,
      fetchedAt: '2026-11-02T03:00:01.000Z',
    });
    expect(await demandForLine(db, 'gid://shopify/LineItem/2')).toEqual(expect.objectContaining({
      status: 'not_required', required_quantity: 0, reason_code: 'test_order',
    }));

    const cancelled = purchaseGraph({
      updatedAt: '2026-11-02T04:00:00Z', displayFulfillmentStatus: 'UNFULFILLED',
      fulfillments: [], test: false, cancelledAt: '2026-11-02T04:00:00Z',
    });
    await repository.upsertOrderGraph({
      storeId, graph: cancelled, apiVersion: '2026-07', runId: null,
      fetchedAt: '2026-11-02T04:00:01.000Z',
    });
    expect(await demandForLine(db, 'gid://shopify/LineItem/2')).toEqual(expect.objectContaining({
      status: 'not_required', required_quantity: 0, reason_code: 'cancelled_order',
    }));
    expect(await count(db, 'purchase_demands')).toBe(2);

    const summary = await db.prepare(`
      SELECT COUNT(*) AS total,
        SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open_count,
        SUM(CASE WHEN status = 'not_required' THEN 1 ELSE 0 END) AS not_required_count
      FROM purchase_demands
    `).first<{ total: number; open_count: number; not_required_count: number }>();
    expect(summary).toEqual({ total: 2, open_count: 0, not_required_count: 2 });
  });
});

function purchaseGraph(overrides: Record<string, unknown>) {
  const graph = shopifyOrderFixture(overrides);
  graph.lines[1].rawSku = 'SERVICE-01';
  graph.lines[1].normalizedSku = 'SERVICE-01';
  return graph;
}

async function demandRows(db: D1Database) {
  return (await db.prepare(`
    SELECT source_order_line_id, status, required_quantity, reason_code, mapped_sku_id
    FROM purchase_demands ORDER BY source_order_line_id
  `).all()).results;
}

async function demandForLine(db: D1Database, lineId: string) {
  return db.prepare(`
    SELECT status, required_quantity, reason_code, mapped_sku_id
    FROM purchase_demands WHERE source_order_line_id = ? LIMIT 1
  `).bind(lineId).first();
}

async function count(db: D1Database, table: string) {
  const row = await db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<{ count: number }>();
  return Number(row?.count ?? 0);
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
  ]) {
    const sql = readFileSync(new URL(migration, import.meta.url), 'utf8');
    for (const statement of sql.split('--> statement-breakpoint').map((item) => item.trim()).filter(Boolean)) {
      await db.prepare(statement).run();
    }
  }
}
