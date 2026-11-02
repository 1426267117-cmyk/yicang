import { readFileSync } from 'node:fs';
import { Miniflare } from 'miniflare';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({ env: {} }));

import { PlatformOrderRepository } from '../lib/connectors/repository';
import type { ShopifyCredentialConfig } from '../lib/connectors/shopify/config';
import type { ShopifyShopContext } from '../lib/connectors/shopify/connector';
import type { UserContext } from '../lib/db';
import { ROLE_PERMISSIONS } from '../lib/domain';
import {
  createPurchaseOrder,
  createPurchaseReceipt,
  createSupplier,
  executePurchaseOrderAction,
  getProcurementWorkspaceData,
} from '../lib/purchase-order-service';
import {
  createPurchaseRequest,
  executePurchaseRequestAction,
} from '../lib/purchase-workflow-service';
import { shopifyOrderFixture } from './fixtures/shopify-order';

const tenantId = 'tenant_purchase_order';
const user: UserContext = {
  id: 'auth-creator', email: 'creator@example.invalid', displayName: '创建人', role: 'admin',
  permissions: ROLE_PERMISSIONS.admin, tenantId, tenantName: '采购单测试工作区',
};
const config: ShopifyCredentialConfig = {
  key: 'bizfurniz', displayName: 'BizFurniz', domain: 'bizfurniz.myshopify.com',
  expectedDomain: 'bizfurniz.myshopify.com', acceptedDomains: ['bizfurniz.myshopify.com'],
  environmentPrefix: 'SHOPIFY_BIZFURNIZ', authMode: 'oauth', credentialRef: 'env:test',
  adminAccessToken: null, clientId: null, clientSecret: null,
};
const shopContext: ShopifyShopContext = {
  id: 'gid://shopify/Shop/9001', name: 'BizFurniz', domain: 'bizfurniz.myshopify.com',
  timezone: 'America/Los_Angeles', timezoneOffset: '-0700', currency: 'USD',
  scopes: new Set(['read_orders']),
};

describe('正式采购单与到货入库闭环', () => {
  let mf: Miniflare;
  let db: D1Database;
  let approvedRequestId: string;

  beforeEach(async () => {
    mf = new Miniflare({
      modules: true,
      script: 'export default { fetch(){ return new Response("ok") } }',
      d1Databases: ['DB'],
    });
    db = await mf.getD1Database('DB');
    await applyMigrations(db);
    await seedFoundation(db);
    const demandId = await seedMappedDemand(db);
    approvedRequestId = await approveRequest(db, demandId);
  });

  afterEach(async () => { await mf.dispose(); });

  it('供应商和采购单幂等创建，且同一批准申请不能重复转单', async () => {
    const supplier = await createSupplier(db, user, {
      code: ' sup-01 ', name: '测试供应商', note: '真实供应商主数据',
    }, 'supplier-create-0001');
    expect(supplier.replayed).toBe(false);
    expect(supplier.supplier).toEqual(expect.objectContaining({ code: 'SUP-01', active: true }));

    const supplierReplay = await createSupplier(db, user, {
      code: 'SUP-01', name: '测试供应商', note: '真实供应商主数据',
    }, 'supplier-create-0001');
    expect(supplierReplay.replayed).toBe(true);
    expect(supplierReplay.supplier.id).toBe(supplier.supplier.id);

    const created = await createPurchaseOrder(db, user, {
      purchaseRequestId: approvedRequestId,
      supplierId: supplier.supplier.id,
      currency: 'usd',
      lineCosts: [{
        purchaseRequestLineId: await requestLineId(db, approvedRequestId),
        unitCostMinor: 1250,
      }],
      note: '按批准申请下单',
    }, 'purchase-order-create-0001');
    expect(created.replayed).toBe(false);
    expect(created.purchaseOrder).toEqual(expect.objectContaining({
      status: 'draft', purchaseRequestId: approvedRequestId,
      currency: 'USD', orderedQuantity: 5, receivedQuantity: 0,
      supplier: expect.objectContaining({ code: 'SUP-01' }),
    }));
    expect(created.purchaseOrder.lines[0]).toEqual(expect.objectContaining({
      orderedQuantity: 5, remainingQuantity: 5, unitCostMinor: 1250,
    }));

    const replay = await createPurchaseOrder(db, user, {
      purchaseRequestId: approvedRequestId,
      supplierId: supplier.supplier.id,
      currency: 'USD',
      lineCosts: [{
        purchaseRequestLineId: await requestLineId(db, approvedRequestId),
        unitCostMinor: 1250,
      }],
      note: '按批准申请下单',
    }, 'purchase-order-create-0001');
    expect(replay.replayed).toBe(true);
    expect(replay.purchaseOrder.id).toBe(created.purchaseOrder.id);

    await expect(createPurchaseOrder(db, user, {
      purchaseRequestId: approvedRequestId,
      supplierId: supplier.supplier.id,
    }, 'purchase-order-create-0002')).rejects.toMatchObject({ code: 'PURCHASE_ORDER_ALREADY_EXISTS' });
  });

  it('确认下单后支持分批收货，幂等重放不重复增加库存', async () => {
    const supplier = await createSupplier(db, user, {
      code: 'SUP-02', name: '分批到货供应商',
    }, 'supplier-create-1001');
    const created = await createPurchaseOrder(db, user, {
      purchaseRequestId: approvedRequestId,
      supplierId: supplier.supplier.id,
      currency: 'USD',
    }, 'purchase-order-create-1001');
    const issued = await executePurchaseOrderAction(db, user, created.purchaseOrder.id, {
      action: 'issue', note: '确认发给供应商',
    }, 'purchase-order-issue-1001');
    expect(issued.purchaseOrder.status).toBe('issued');
    const lineId = issued.purchaseOrder.lines[0].id;

    const first = await createPurchaseReceipt(db, user, created.purchaseOrder.id, {
      warehouseId: 'warehouse-main',
      note: '第一批到货',
      lines: [{ purchaseOrderLineId: lineId, quantity: 2 }],
    }, 'purchase-receipt-create-1001');
    expect(first.purchaseOrder).toEqual(expect.objectContaining({
      status: 'partially_received', receivedQuantity: 2,
    }));
    expect(first.receipt).toEqual(expect.objectContaining({ totalQuantity: 2, status: 'posted' }));
    expect(await inventoryOnHand(db)).toBe(2);

    const replay = await createPurchaseReceipt(db, user, created.purchaseOrder.id, {
      warehouseId: 'warehouse-main',
      note: '第一批到货',
      lines: [{ purchaseOrderLineId: lineId, quantity: 2 }],
    }, 'purchase-receipt-create-1001');
    expect(replay.replayed).toBe(true);
    expect(replay.receipt.id).toBe(first.receipt.id);
    expect(await inventoryOnHand(db)).toBe(2);

    await expect(createPurchaseReceipt(db, user, created.purchaseOrder.id, {
      warehouseId: 'warehouse-main',
      lines: [{ purchaseOrderLineId: lineId, quantity: 4 }],
    }, 'purchase-receipt-create-1002')).rejects.toMatchObject({
      code: 'PURCHASE_RECEIPT_EXCEEDS_REMAINING',
    });
    expect(await inventoryOnHand(db)).toBe(2);

    const final = await createPurchaseReceipt(db, user, created.purchaseOrder.id, {
      warehouseId: 'warehouse-main',
      receivedAt: '2026-11-02T10:30:00+08:00',
      note: '尾批到货',
      lines: [{ purchaseOrderLineId: lineId, quantity: 3 }],
    }, 'purchase-receipt-create-1003');
    expect(final.purchaseOrder).toEqual(expect.objectContaining({
      status: 'received', receivedQuantity: 5,
    }));
    expect(await inventoryOnHand(db)).toBe(5);

    const inbound = await db.prepare(`
      SELECT COUNT(*) AS count, SUM(on_hand_delta) AS quantity
      FROM inventory_inbound_movements WHERE tenant_id = ?
    `).bind(tenantId).first<{ count: number; quantity: number }>();
    expect(Number(inbound?.count)).toBe(2);
    expect(Number(inbound?.quantity)).toBe(5);

    const workspace = await getProcurementWorkspaceData(db, user);
    expect(workspace.procurementSummary).toEqual(expect.objectContaining({
      receivedOrders: 1, receiptCount: 2, receivedQuantity: 5, pendingReceiptQuantity: 0,
    }));
    expect(workspace.purchaseReceipts).toHaveLength(2);
  });

  it('来源需求变化、错误仓库和未下单收货都会被拒绝且不留下业务记录', async () => {
    const supplier = await createSupplier(db, user, {
      code: 'SUP-03', name: '约束测试供应商',
    }, 'supplier-create-2001');

    await db.prepare(`
      UPDATE purchase_demands
      SET source_updated_at = ?, updated_at = ?
      WHERE tenant_id = ?
    `).bind('2026-11-02T12:00:00.000Z', '2026-11-02T12:00:00.000Z', tenantId).run();
    await expect(createPurchaseOrder(db, user, {
      purchaseRequestId: approvedRequestId,
      supplierId: supplier.supplier.id,
    }, 'purchase-order-create-2001')).rejects.toMatchObject({ code: 'PURCHASE_REQUEST_NEEDS_ATTENTION' });

    await db.prepare(`
      UPDATE purchase_request_lines
      SET source_updated_at = '2026-11-02T12:00:00.000Z'
      WHERE tenant_id = ? AND request_id = ?
    `).bind(tenantId, approvedRequestId).run();
    const created = await createPurchaseOrder(db, user, {
      purchaseRequestId: approvedRequestId,
      supplierId: supplier.supplier.id,
    }, 'purchase-order-create-2002');
    await expect(createPurchaseReceipt(db, user, created.purchaseOrder.id, {
      warehouseId: 'warehouse-main',
      lines: [{ purchaseOrderLineId: created.purchaseOrder.lines[0].id, quantity: 1 }],
    }, 'purchase-receipt-create-2001')).rejects.toMatchObject({ code: 'PURCHASE_ORDER_NOT_RECEIVABLE' });

    await executePurchaseOrderAction(db, user, created.purchaseOrder.id, {
      action: 'issue',
    }, 'purchase-order-issue-2001');
    await expect(createPurchaseReceipt(db, user, created.purchaseOrder.id, {
      warehouseId: 'warehouse-other-tenant',
      lines: [{ purchaseOrderLineId: created.purchaseOrder.lines[0].id, quantity: 1 }],
    }, 'purchase-receipt-create-2002')).rejects.toMatchObject({ code: 'RECEIPT_WAREHOUSE_NOT_FOUND' });

    const counts = await db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM purchase_receipts WHERE tenant_id = ?) AS receipts,
        (SELECT COUNT(*) FROM inventory_inbound_movements WHERE tenant_id = ?) AS movements
    `).bind(tenantId, tenantId).first<{ receipts: number; movements: number }>();
    expect(Number(counts?.receipts)).toBe(0);
    expect(Number(counts?.movements)).toBe(0);
  });
});

async function approveRequest(db: D1Database, demandId: string) {
  const created = await createPurchaseRequest(db, user, {
    demandIds: [demandId], purchaserMemberId: 'member-buyer', reviewerMemberId: 'member-reviewer',
  }, `request-create-${crypto.randomUUID()}`);
  await executePurchaseRequestAction(db, user, created.request.id, { action: 'submit' }, `request-submit-${crypto.randomUUID()}`);
  const approved = await executePurchaseRequestAction(db, user, created.request.id, { action: 'approve' }, `request-approve-${crypto.randomUUID()}`);
  return approved.request.id;
}

async function seedFoundation(db: D1Database) {
  const now = '2026-11-02T00:00:00.000Z';
  await db.batch([
    db.prepare('INSERT INTO tenants (id, name, created_at) VALUES (?, ?, ?)')
      .bind(tenantId, '采购单测试工作区', now),
    db.prepare(`INSERT INTO members (id, tenant_id, auth_user_id, email, display_name, role, created_at)
      VALUES ('member-creator', ?, ?, ?, '创建人', 'admin', ?)`).bind(tenantId, user.id, user.email, now),
    db.prepare(`INSERT INTO members (id, tenant_id, auth_user_id, email, display_name, role, created_at)
      VALUES ('member-buyer', ?, 'auth-buyer', 'buyer@example.invalid', '采购员', 'operator', ?)`).bind(tenantId, now),
    db.prepare(`INSERT INTO members (id, tenant_id, auth_user_id, email, display_name, role, created_at)
      VALUES ('member-reviewer', ?, 'auth-reviewer', 'reviewer@example.invalid', '复审员', 'admin', ?)`).bind(tenantId, now),
    db.prepare(`INSERT INTO warehouses (id, tenant_id, code, name, created_at)
      VALUES ('warehouse-main', ?, 'MAIN', '主仓', ?)`).bind(tenantId, now),
    db.prepare(`INSERT INTO tenants (id, name, created_at)
      VALUES ('tenant-other', '其他租户', ?)`).bind(now),
    db.prepare(`INSERT INTO warehouses (id, tenant_id, code, name, created_at)
      VALUES ('warehouse-other-tenant', 'tenant-other', 'OTHER', '其他租户仓', ?)`).bind(now),
  ]);
}

async function seedMappedDemand(db: D1Database) {
  const repository = new PlatformOrderRepository(db, tenantId);
  const storeId = (await repository.upsertVerifiedShopifyStore(config, shopContext, '2026-11-02T00:00:01.000Z')).id;
  const graph = shopifyOrderFixture({
    updatedAt: '2026-11-02T01:00:00Z',
    displayFinancialStatus: 'PAID',
    displayFulfillmentStatus: 'UNFULFILLED',
    refunds: [],
    fulfillments: [],
  });
  graph.lines[1].rawSku = 'SERVICE-PO-01';
  graph.lines[1].normalizedSku = 'SERVICE-PO-01';
  graph.lines[1].orderedQuantity = 5;
  graph.lines[1].currentQuantity = 5;
  graph.lines[1].unfulfilledQuantity = 5;
  await repository.upsertOrderGraph({
    storeId, graph, apiVersion: '2026-07', runId: null, fetchedAt: '2026-11-02T01:00:01.000Z',
  });
  await db.prepare(`
    INSERT INTO skus (id, tenant_id, code, name, active, created_at)
    VALUES ('sku-service-po', ?, 'SERVICE-PO-01', '采购服务商品', 1, ?)
  `).bind(tenantId, '2026-11-02T01:00:02.000Z').run();
  await db.prepare(`
    UPDATE platform_sku_mappings
    SET sku_id = 'sku-service-po', status = 'mapped', mapping_source = 'purchase_order_test', updated_at = ?
    WHERE tenant_id = ? AND platform_store_id = ? AND raw_sku = 'SERVICE-PO-01'
  `).bind('2026-11-02T01:00:02.000Z', tenantId, storeId).run();
  await repository.upsertOrderGraph({
    storeId, graph, apiVersion: '2026-07', runId: null, fetchedAt: '2026-11-02T01:00:03.000Z',
  });
  const demand = await db.prepare(`
    SELECT id FROM purchase_demands
    WHERE tenant_id = ? AND raw_sku = 'SERVICE-PO-01' AND status = 'open'
    LIMIT 1
  `).bind(tenantId).first<{ id: string }>();
  if (!demand) throw new Error('purchase order test demand missing');
  return demand.id;
}

async function requestLineId(db: D1Database, requestId: string) {
  const row = await db.prepare(`
    SELECT id FROM purchase_request_lines WHERE tenant_id = ? AND request_id = ? LIMIT 1
  `).bind(tenantId, requestId).first<{ id: string }>();
  if (!row) throw new Error('purchase request line missing');
  return row.id;
}

async function inventoryOnHand(db: D1Database) {
  const row = await db.prepare(`
    SELECT on_hand_qty FROM inventory_balances
    WHERE tenant_id = ? AND sku_id = 'sku-service-po' AND warehouse_id = 'warehouse-main'
    LIMIT 1
  `).bind(tenantId).first<{ on_hand_qty: number }>();
  return Number(row?.on_hand_qty ?? 0);
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
