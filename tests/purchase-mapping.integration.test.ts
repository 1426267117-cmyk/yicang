import { readFileSync } from 'node:fs';
import { Miniflare } from 'miniflare';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlatformOrderRepository } from '../lib/connectors/repository';
import type { ShopifyCredentialConfig } from '../lib/connectors/shopify/config';
import type { ShopifyShopContext } from '../lib/connectors/shopify/connector';
import type { UserContext } from '../lib/db';
import type { Permission } from '../lib/domain';
import { mapPurchaseSku } from '../lib/purchase-mapping-service';
import { shopifyOrderFixture } from './fixtures/shopify-order';

vi.mock('cloudflare:workers', () => ({ env: {} }));

const tenantId = 'tenant_purchase_mapping_test';
const config: ShopifyCredentialConfig = {
  key: 'bizfurniz', displayName: 'BizFurniz', domain: 'fixture-bizfurniz-alias.myshopify.com',
  expectedDomain: 'fixture-bizfurniz-alias.myshopify.com', environmentPrefix: 'SHOPIFY_BIZFURNIZ',
  acceptedDomains: ['fixture-bizfurniz-alias.myshopify.com'], authMode: 'oauth', credentialRef: 'env:SHOPIFY_BIZFURNIZ',
  adminAccessToken: null, clientId: null, clientSecret: null,
};
const context: ShopifyShopContext = {
  id: 'gid://shopify/Shop/9010', name: 'BizFurniz', domain: 'fixture-bizfurniz-alias.myshopify.com',
  timezone: 'America/Los_Angeles', timezoneOffset: '-0700', currency: 'USD',
  scopes: new Set(['read_orders']),
};
const user: UserContext = {
  id: 'mapping-user',
  email: 'mapping-user@example.invalid',
  displayName: 'Mapping User',
  role: 'admin',
  permissions: ['purchase:mapping'] as Permission[],
  tenantId,
  tenantName: 'Purchase Mapping Test',
};

describe('采购需求 SKU 映射', () => {
  let mf: Miniflare;
  let db: D1Database;
  let demandId: string;

  beforeEach(async () => {
    mf = new Miniflare({ modules: true, script: 'export default { fetch(){ return new Response("ok") } }', d1Databases: ['DB'] });
    db = await mf.getD1Database('DB');
    await applyMigrations(db);
    await db.prepare('INSERT INTO tenants (id, name, created_at) VALUES (?, ?, ?)')
      .bind(tenantId, 'Purchase Mapping Test', '2026-11-02T00:00:00.000Z').run();
    const repository = new PlatformOrderRepository(db, tenantId);
    const storeId = (await repository.upsertVerifiedShopifyStore(config, context, '2026-11-02T00:00:01.000Z')).id;
    const graph = shopifyOrderFixture({
      displayFulfillmentStatus: 'UNFULFILLED',
      fulfillments: [],
      refunds: [],
    });
    graph.lines[0].rawSku = ' SERVICE-01 ';
    graph.lines[0].normalizedSku = 'SERVICE-01';
    graph.lines[1].rawSku = ' SERVICE-01 ';
    graph.lines[1].normalizedSku = 'SERVICE-01';
    await repository.upsertOrderGraph({
      storeId,
      graph,
      apiVersion: '2026-07',
      runId: null,
      fetchedAt: '2026-11-02T00:00:02.000Z',
    });
    const demand = await db.prepare(`
      SELECT id FROM purchase_demands
      WHERE tenant_id = ? AND status = 'needs_mapping'
      LIMIT 1
    `).bind(tenantId).first<{ id: string }>();
    if (!demand) throw new Error('mapping demand fixture missing');
    demandId = demand.id;
  });

  afterEach(async () => { await mf.dispose(); });

  it('映射已有 SKU 后开放需求，保持无需采购行关闭且重复请求不重复写审计', async () => {
    await db.prepare(`
      INSERT INTO skus (id, tenant_id, code, name, active, created_at)
      VALUES ('sku_existing', ?, 'SERVICE-01', 'Existing service SKU', 1, ?)
    `).bind(tenantId, '2026-11-02T00:00:03.000Z').run();

    const first = await mapPurchaseSku(
      db,
      user,
      { demandId, skuId: 'sku_existing' },
      'mapping-existing-0001',
    );
    expect(first).toEqual({
      replayed: false,
      mapping: expect.objectContaining({
        demandId,
        rawSku: ' SERVICE-01 ',
        demandStatus: 'open',
        skuId: 'sku_existing',
        skuCode: 'SERVICE-01',
      }),
    });

    const demands = await db.prepare(`
      SELECT status, required_quantity, reason_code, mapped_sku_id
      FROM purchase_demands
      WHERE tenant_id = ? AND raw_sku = ' SERVICE-01 '
      ORDER BY required_quantity
    `).bind(tenantId).all<{
      status: string; required_quantity: number; reason_code: string | null; mapped_sku_id: string | null;
    }>();
    expect(demands.results).toEqual([
      expect.objectContaining({ status: 'not_required', required_quantity: 0, mapped_sku_id: 'sku_existing' }),
      expect.objectContaining({ status: 'open', required_quantity: 1, reason_code: null, mapped_sku_id: 'sku_existing' }),
    ]);
    const lines = await db.prepare(`
      SELECT mapping_status, mapped_sku_id FROM platform_order_lines
      WHERE tenant_id = ? AND raw_sku = ' SERVICE-01 '
    `).bind(tenantId).all<{ mapping_status: string; mapped_sku_id: string }>();
    expect(lines.results).toHaveLength(2);
    expect(lines.results.every((line) => line.mapping_status === 'mapped' && line.mapped_sku_id === 'sku_existing')).toBe(true);

    const replay = await mapPurchaseSku(
      db,
      user,
      { demandId, skuId: 'sku_existing' },
      'mapping-existing-0001',
    );
    expect(replay.replayed).toBe(true);
    expect(await count(db, 'audit_logs')).toBe(1);
  });

  it('可以幂等新建 ERP SKU 并建立映射', async () => {
    const result = await mapPurchaseSku(
      db,
      user,
      { demandId, newSku: { code: ' service-new ', name: 'New service SKU' } },
      'mapping-new-sku-0001',
    );
    expect(result.replayed).toBe(false);
    expect(result.mapping).toEqual(expect.objectContaining({
      demandId,
      demandStatus: 'open',
      skuCode: 'SERVICE-NEW',
      skuName: 'New service SKU',
    }));
    const sku = await db.prepare(`
      SELECT code, name, active FROM skus WHERE tenant_id = ? AND code = 'SERVICE-NEW'
    `).bind(tenantId).first<{ code: string; name: string; active: number }>();
    expect(sku).toEqual({ code: 'SERVICE-NEW', name: 'New service SKU', active: 1 });
  });

  it('同一幂等键不能改成不同映射参数', async () => {
    await db.prepare(`
      INSERT INTO skus (id, tenant_id, code, name, active, created_at)
      VALUES ('sku_a', ?, 'SKU-A', 'SKU A', 1, ?), ('sku_b', ?, 'SKU-B', 'SKU B', 1, ?)
    `).bind(tenantId, '2026-11-02T00:00:03.000Z', tenantId, '2026-11-02T00:00:03.000Z').run();
    await mapPurchaseSku(db, user, { demandId, skuId: 'sku_a' }, 'mapping-conflict-0001');
    await expect(mapPurchaseSku(
      db,
      user,
      { demandId, skuId: 'sku_b' },
      'mapping-conflict-0001',
    )).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(await count(db, 'audit_logs')).toBe(1);
  });
});

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
    '../drizzle/0007_worried_stone_men.sql',
  ]) {
    const sql = readFileSync(new URL(migration, import.meta.url), 'utf8');
    for (const statement of sql.split('--> statement-breakpoint').map((item) => item.trim()).filter(Boolean)) {
      await db.prepare(statement).run();
    }
  }
}
