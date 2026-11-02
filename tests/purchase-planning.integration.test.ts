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
  createWarehouse,
  executePurchaseOrderAction,
} from '../lib/purchase-order-service';
import { createPurchaseReceiptCorrection } from '../lib/purchase-receipt-correction-service';
import {
  createPurchaseRequestFromPlanning,
  getPurchasePlanning,
  upsertMukuSkuMapping,
  upsertSkuInventoryConfirmation,
  upsertSkuProcurementPolicy,
} from '../lib/purchase-planning-service';
import { executePurchaseRequestAction } from '../lib/purchase-workflow-service';
import { shopifyOrderFixture } from './fixtures/shopify-order';

const tenantId = 'tenant_purchase_planning';
const now = new Date('2026-11-02T10:10:00.000Z');
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
const user: UserContext = {
  id: 'auth-planner', email: 'planner@example.invalid', displayName: '采购计划员', role: 'admin',
  permissions: ROLE_PERMISSIONS.admin, tenantId, tenantName: '采购计划测试工作区',
};
const buyerUser: UserContext = {
  ...user,
  id: 'auth-buyer',
  email: 'buyer@example.invalid',
  displayName: '采购员',
  role: 'operator',
  permissions: ROLE_PERMISSIONS.operator,
};
const reviewerUser: UserContext = {
  ...user,
  id: 'auth-reviewer',
  email: 'reviewer@example.invalid',
  displayName: '复审员',
};

describe('真实订单 + MUKU 库存采购计划', () => {
  let mf: Miniflare;
  let db: D1Database;
  let demandId: string;

  beforeEach(async () => {
    mf = new Miniflare({
      modules: true,
      script: 'export default { fetch(){ return new Response("ok") } }',
      d1Databases: ['DB'],
    });
    db = await mf.getD1Database('DB');
    await applyMigrations(db);
    await seedMembers(db);
    demandId = await seedDemand(db, 9);
    await seedFreshInventory(db, { availableQty: 6, inboundQty: 0 });
  });

  afterEach(async () => { await mf.dispose(); });

  it('没有显式或唯一映射时 fail-closed；人工映射后按订单缺口建议', async () => {
    const blocked = await getPurchasePlanning(db, user, { now });
    expect(blocked.rows).toHaveLength(1);
    expect(blocked.rows[0]).toEqual(expect.objectContaining({
      decision: 'blocked',
      mukuMatchStatus: 'unmapped',
      mukuAvailableQty: null,
      recommendedQty: null,
      blockers: expect.arrayContaining(['muku_sku_unmapped']),
    }));
    expect(blocked.summary).toEqual(expect.objectContaining({
      recommendedQty: null,
      knownRecommendedQty: 0,
      unknownRecommendationRows: 1,
    }));
    expect(blocked.mappingExceptions.muku[0]).toEqual(expect.objectContaining({
      mukuSku: 'MUKU-CHAIR', availableQty: 6, inboundQty: 0,
    }));

    await upsertMukuSkuMapping(db, user, {
      mukuSku: 'MUKU-CHAIR', skuId: 'sku-service',
    }, 'map-muku-chair-0001');
    const mappingReplay = await upsertMukuSkuMapping(db, user, {
      mukuSku: 'MUKU-CHAIR', skuId: 'sku-service',
    }, 'map-muku-chair-0001');
    expect(mappingReplay.replayed).toBe(true);
    await expect(upsertMukuSkuMapping(db, user, {
      mukuSku: 'DIFFERENT-SKU', skuId: 'sku-service',
    }, 'map-muku-chair-0001')).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    const ready = await getPurchasePlanning(db, user, { now });
    expect(ready.storeCoverage).toEqual({
      mode: 'pilot',
      candidateStoreCount: 4,
      activeOfficialStoreCount: 1,
      activeStoreKeys: ['bizfurniz'],
      missingCandidateStoreKeys: ['zimasya', 'kaguyasu', 'anzhap'],
    });
    expect(ready.rows[0]).toEqual(expect.objectContaining({
      decision: 'buy',
      mukuMatchStatus: 'manual',
      orderDemandQty: 9,
      mukuAvailableQty: 6,
      mukuInboundQty: 0,
      sales30d: null,
      safetyStockQty: null,
      recommendedQty: 3,
      warnings: expect.arrayContaining(['safety_unknown']),
    }));
    expect(ready.rows[0].calculationParts).toEqual(expect.objectContaining({
      rawOrderGapQty: 3,
      rawTotalGapQty: 3,
      mukuInboundDeducted: false,
      erpOpenPoDeductedSeparately: false,
    }));
    expect(ready.rows[0].sourceTimes).toEqual(expect.objectContaining({
      inventoryRecordUpdatedAt: '2026-11-02T10:00:00.000Z',
      inventorySourceFreshness: 'fresh',
    }));
    expect(ready.rows[0].conversion).toEqual(expect.objectContaining({
      eligibleOrderQty: 3,
      blockedRecommendationQty: 0,
      conversionBlocked: false,
    }));
    const nextMinute = await getPurchasePlanning(db, user, {
      now: new Date('2026-11-02T10:11:00.000Z'),
    });
    expect(nextMinute.rows[0].recommendationVersion).toBe(ready.rows[0].recommendationVersion);
  });

  it('BGY 无 MUKU 编码时人工确认 0 仅作 24 小时兜底，过期与全局陈旧会恢复阻断', async () => {
    await db.prepare(`
      UPDATE skus SET code = 'BGY-2134-01', name = 'BGY 测试商品'
      WHERE tenant_id = ? AND id = 'sku-service'
    `).bind(tenantId).run();

    const unknown = await getPurchasePlanning(db, user, { now });
    const unknownRow = unknown.rows[0];
    expect(unknownRow).toEqual(expect.objectContaining({
      skuCode: 'BGY-2134-01',
      decision: 'blocked',
      mukuMatchStatus: 'unmapped',
      mukuAvailableQty: null,
      effectiveAvailableQty: null,
      availableQtySource: 'unknown',
      recommendedQty: null,
    }));
    expect(unknownRow.blockers).toEqual(expect.arrayContaining([
      'muku_sku_unmapped',
      'inventory_source_time_unknown',
    ]));

    const input = {
      skuId: 'sku-service',
      confirmedAvailableQty: 0,
      note: '仓库人工核对：BGY 无其他编码，可用库存为 0',
    };
    const created = await upsertSkuInventoryConfirmation(
      db,
      user,
      input,
      'confirm-bgy-zero-0001',
      { now },
    );
    expect(created).toEqual(expect.objectContaining({
      replayed: false,
      confirmation: expect.objectContaining({
        skuCode: 'BGY-2134-01',
        confirmedAvailableQty: 0,
        scope: 'all_warehouses',
        confirmedAt: '2026-11-02T10:10:00.000Z',
        expiresAt: '2026-11-03T10:10:00.000Z',
        confirmedBy: user.id,
        confirmedByEmail: user.email,
      }),
    }));
    const replay = await upsertSkuInventoryConfirmation(
      db,
      user,
      input,
      'confirm-bgy-zero-0001',
      { now },
    );
    expect(replay.replayed).toBe(true);
    await expect(upsertSkuInventoryConfirmation(db, user, {
      ...input,
      confirmedAvailableQty: 1,
    }, 'confirm-bgy-zero-0001', { now })).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });

    const active = await getPurchasePlanning(db, user, { now });
    const activeRow = active.rows[0];
    expect(activeRow).toEqual(expect.objectContaining({
      decision: 'buy',
      mukuMatchStatus: 'unmapped',
      mukuAvailableQty: null,
      effectiveAvailableQty: 0,
      availableQtySource: 'manual_confirmation',
      recommendedQty: 9,
      inventoryConfirmation: expect.objectContaining({
        confirmedAvailableQty: 0,
        active: true,
        used: true,
      }),
    }));
    expect(activeRow.blockers).not.toContain('muku_sku_unmapped');
    expect(activeRow.blockers).not.toContain('inventory_source_time_unknown');
    expect(activeRow.warnings).toContain('manual_inventory_confirmation');
    expect(activeRow.recommendationVersion).not.toBe(unknownRow.recommendationVersion);

    const globallyStale = await getPurchasePlanning(db, user, {
      now: new Date('2026-11-02T12:00:00.000Z'),
      maxAgeMinutes: 30,
    });
    expect(globallyStale.rows[0]).toEqual(expect.objectContaining({
      decision: 'blocked',
      mukuAvailableQty: null,
      effectiveAvailableQty: 0,
      availableQtySource: 'manual_confirmation',
      recommendedQty: null,
    }));
    expect(globallyStale.rows[0].blockers).toContain('inventory_stale');

    const expired = await getPurchasePlanning(db, user, {
      now: new Date('2026-11-03T10:10:00.000Z'),
      maxAgeMinutes: 48 * 60,
    });
    expect(expired.rows[0]).toEqual(expect.objectContaining({
      decision: 'blocked',
      mukuAvailableQty: null,
      effectiveAvailableQty: null,
      availableQtySource: 'unknown',
      recommendedQty: null,
      inventoryConfirmation: expect.objectContaining({ active: false, used: false }),
    }));
    expect(expired.rows[0].blockers).toEqual(expect.arrayContaining([
      'muku_sku_unmapped',
      'inventory_source_time_unknown',
    ]));
    expect(expired.rows[0].warnings).toContain('manual_inventory_confirmation_expired');

    const renewed = await upsertSkuInventoryConfirmation(db, user, {
      ...input,
      confirmedAvailableQty: 1,
    }, 'confirm-bgy-one-0002', {
      now: new Date('2026-11-03T10:11:00.000Z'),
    });
    expect(renewed.confirmation.id).toBe(created.confirmation.id);
    expect(renewed.confirmation.confirmedAvailableQty).toBe(1);
    const historicReplay = await upsertSkuInventoryConfirmation(
      db,
      user,
      input,
      'confirm-bgy-zero-0001',
      { now: new Date('2026-11-03T10:12:00.000Z') },
    );
    expect(historicReplay).toEqual(expect.objectContaining({
      replayed: true,
      confirmation: expect.objectContaining({
        id: created.confirmation.id,
        confirmedAvailableQty: 0,
        confirmedAt: '2026-11-02T10:10:00.000Z',
        expiresAt: '2026-11-03T10:10:00.000Z',
      }),
    }));
    const persisted = await db.prepare(`
      SELECT confirmed_available_qty FROM sku_inventory_confirmations
      WHERE tenant_id = ? AND sku_id = 'sku-service'
    `).bind(tenantId).first<{ confirmed_available_qty: number }>();
    expect(Number(persisted?.confirmed_available_qty)).toBe(1);
  });

  it('MUKU 已知仓库可用量优先于人工 0，仓库源陈旧仍阻断', async () => {
    await upsertMukuSkuMapping(db, user, {
      mukuSku: 'MUKU-CHAIR', skuId: 'sku-service',
    }, 'map-known-muku-0001');
    await upsertSkuInventoryConfirmation(db, user, {
      skuId: 'sku-service',
      confirmedAvailableQty: 0,
      note: '人工核对为零，但 MUKU 已知值必须优先',
    }, 'confirm-known-muku-0001', { now });

    const known = await getPurchasePlanning(db, user, { now });
    expect(known.rows[0]).toEqual(expect.objectContaining({
      decision: 'buy',
      mukuAvailableQty: 6,
      effectiveAvailableQty: 6,
      availableQtySource: 'muku',
      recommendedQty: 3,
      inventoryConfirmation: expect.objectContaining({ active: true, used: false }),
    }));

    await db.prepare(`
      UPDATE muku_inventory_records SET source_updated_at = '2026-10-29T10:00:00.000Z'
      WHERE tenant_id = ? AND snapshot_id = 'snapshot-inventory' AND inventory_kind = 'warehouse'
    `).bind(tenantId).run();
    const staleSource = await getPurchasePlanning(db, user, { now });
    expect(staleSource.rows[0]).toEqual(expect.objectContaining({
      decision: 'blocked',
      mukuAvailableQty: 6,
      effectiveAvailableQty: 6,
      availableQtySource: 'muku',
      recommendedQty: null,
    }));
    expect(staleSource.rows[0].blockers).toContain('inventory_source_stale');
  });

  it('HYZ 仅有 5 件未对账 MUKU 在途时，即使人工确认可用量也阻断自动采购', async () => {
    await db.prepare(`
      UPDATE skus SET code = 'HYZ-046-01', name = 'HYZ 测试商品'
      WHERE tenant_id = ? AND id = 'sku-service'
    `).bind(tenantId).run();
    await upsertMukuSkuMapping(db, user, {
      mukuSku: 'MUKU-CHAIR', skuId: 'sku-service',
    }, 'map-hyz-transit-0001');
    await db.prepare(`
      UPDATE muku_inventory_records
      SET inventory_kind = 'in_transit', available_qty = NULL, on_hand_qty = 0,
          inbound_qty = CASE WHEN id = 'inventory-record-1' THEN 5 ELSE 0 END
      WHERE tenant_id = ? AND snapshot_id = 'snapshot-inventory' AND sku = 'MUKU-CHAIR'
    `).bind(tenantId).run();

    const unknown = await getPurchasePlanning(db, user, { now });
    expect(unknown.rows[0]).toEqual(expect.objectContaining({
      skuCode: 'HYZ-046-01',
      decision: 'blocked',
      mukuAvailableQty: null,
      effectiveAvailableQty: null,
      mukuInboundQty: 5,
      recommendedQty: null,
    }));
    expect(unknown.rows[0].blockers).toEqual(expect.arrayContaining([
      'muku_sku_missing_from_snapshot',
      'muku_available_unknown',
      'inventory_source_time_unknown',
    ]));

    await upsertSkuInventoryConfirmation(db, user, {
      skuId: 'sku-service',
      confirmedAvailableQty: 0,
      note: '仓库人工核对：HYZ 可用库存为 0，在途保持展示',
    }, 'confirm-hyz-zero-0001', { now });
    const confirmed = await getPurchasePlanning(db, user, { now });
    expect(confirmed.rows[0]).toEqual(expect.objectContaining({
      decision: 'blocked',
      mukuAvailableQty: null,
      effectiveAvailableQty: 0,
      availableQtySource: 'manual_confirmation',
      mukuInboundQty: 5,
      recommendedQty: null,
    }));
    expect(confirmed.rows[0].blockers).not.toContain('muku_sku_missing_from_snapshot');
    expect(confirmed.rows[0].blockers).not.toContain('muku_available_unknown');
    expect(confirmed.rows[0].blockers).not.toContain('inventory_source_time_unknown');
    expect(confirmed.rows[0].blockers).toContain('muku_inbound_unreconciled');
    expect(confirmed.rows[0].calculationParts).toEqual(expect.objectContaining({
      effectiveAvailableQty: 0,
      mukuInboundQty: 5,
      mukuInboundDeducted: false,
      rawOrderGapQty: null,
    }));
  });

  it('服务端按建议精确分配部分数量，幂等重放且旧版本拒绝零写入', async () => {
    await upsertMukuSkuMapping(db, user, {
      mukuSku: 'MUKU-CHAIR', skuId: 'sku-service',
    }, 'map-muku-chair-1001');
    const plan = await getPurchasePlanning(db, user, { now });
    const row = plan.rows[0];
    const input = {
      selections: [{
        planRowId: row.planRowId,
        recommendationVersion: row.recommendationVersion,
      }],
      purchaserMemberId: 'member-buyer',
      reviewerMemberId: 'member-reviewer',
      note: '按真实缺口采购',
    };
    const created = await createPurchaseRequestFromPlanning(
      db,
      user,
      input,
      'plan-to-request-0001',
      { now },
    );
    expect(created.replayed).toBe(false);
    expect(created.request).toEqual(expect.objectContaining({ totalQuantity: 3, lineCount: 1 }));
    expect(created.request.lines[0]).toEqual(expect.objectContaining({
      purchaseDemandId: demandId,
      requestedQuantity: 3,
      sourceRequiredQuantity: 9,
    }));

    const replay = await createPurchaseRequestFromPlanning(
      db,
      user,
      input,
      'plan-to-request-0001',
      { now },
    );
    expect(replay.replayed).toBe(true);
    expect(replay.request.id).toBe(created.request.id);

    await expect(createPurchaseRequestFromPlanning(
      db,
      user,
      input,
      'plan-to-request-0002',
      { now },
    )).rejects.toMatchObject({ code: 'PURCHASE_RECOMMENDATION_STALE' });
    const count = await db.prepare(`
      SELECT COUNT(*) AS count FROM purchase_requests WHERE tenant_id = ?
    `).bind(tenantId).first<{ count: number }>();
    expect(Number(count?.count)).toBe(1);

    const after = await getPurchasePlanning(db, user, { now });
    expect(after.rows[0]).toEqual(expect.objectContaining({
      erpPurchaseChainCoverageQty: 3,
      activeRequestQty: 3,
      recommendedQty: 0,
    }));

    await executePurchaseRequestAction(db, buyerUser, created.request.id, {
      action: 'submit',
    }, 'submit-planned-request-0001', { now });
    await executePurchaseRequestAction(db, reviewerUser, created.request.id, {
      action: 'approve',
    }, 'approve-planned-request-0001', { now });

    await db.prepare(`
      UPDATE muku_inventory_records SET available_qty = 3
      WHERE tenant_id = ? AND snapshot_id = 'snapshot-inventory'
    `).bind(tenantId).run();
    const beforePo = await getPurchasePlanning(db, user, { now });
    expect(beforePo.rows[0]).toEqual(expect.objectContaining({
      erpPurchaseChainCoverageQty: 3,
      erpOpenPoQty: 0,
      recommendedQty: 3,
    }));
    expect(beforePo.rows[0].conversion).toEqual(expect.objectContaining({
      eligibleOrderQty: 0,
      blockedRecommendationQty: 3,
      conversionBlocked: true,
      reasons: expect.arrayContaining(['order_demand_already_in_active_request']),
    }));
    const supplier = await createSupplier(db, user, {
      code: 'SUP-PLAN', name: '计划供应商',
    }, 'create-plan-supplier-0001');
    const warehouse = await createWarehouse(db, user, {
      code: 'PLAN-WH', name: '计划收货仓',
    }, 'create-plan-warehouse-0001');
    const requestLine = await db.prepare(`
      SELECT id FROM purchase_request_lines
      WHERE tenant_id = ? AND request_id = ?
      LIMIT 1
    `).bind(tenantId, created.request.id).first<{ id: string }>();
    if (!requestLine) throw new Error('planned purchase request line missing');
    const purchaseOrder = await createPurchaseOrder(db, buyerUser, {
      purchaseRequestId: created.request.id,
      supplierId: supplier.supplier.id,
      deliveryWarehouseId: warehouse.warehouse.id,
      expectedDeliveryAt: '2026-11-30',
      currency: 'USD',
      lineCosts: [{ purchaseRequestLineId: requestLine.id, unitCostMinor: 100 }],
    }, 'create-plan-po-0001');
    const afterPo = await getPurchasePlanning(db, user, { now });
    expect(afterPo.rows[0]).toEqual(expect.objectContaining({
      erpPurchaseChainCoverageQty: 3,
      erpOpenPoQty: 3,
      recommendedQty: 3,
    }));
    expect(afterPo.rows[0].calculationParts.erpOpenPoDeductedSeparately).toBe(false);

    await expect(executePurchaseOrderAction(db, buyerUser, purchaseOrder.purchaseOrder.id, {
      action: 'issue',
    }, 'issue-stale-plan-po-0001', { planningNow: now })).rejects.toMatchObject({
      code: 'PURCHASE_RECOMMENDATION_STALE',
    });
    const staleOrder = await db.prepare(`
      SELECT status FROM purchase_orders WHERE tenant_id = ? AND id = ?
    `).bind(tenantId, purchaseOrder.purchaseOrder.id).first<{ status: string }>();
    expect(staleOrder?.status).toBe('draft');
    await db.prepare(`
      UPDATE muku_inventory_records SET available_qty = 6
      WHERE tenant_id = ? AND snapshot_id = 'snapshot-inventory'
    `).bind(tenantId).run();
    await executePurchaseOrderAction(db, buyerUser, purchaseOrder.purchaseOrder.id, {
      action: 'issue',
    }, 'issue-plan-po-0001', { planningNow: now });
    const postedReceipt = await createPurchaseReceipt(db, user, purchaseOrder.purchaseOrder.id, {
      warehouseId: warehouse.warehouse.id,
      receivedAt: '2026-11-02T09:00:00.000Z',
      lines: [{
        purchaseOrderLineId: purchaseOrder.purchaseOrder.lines[0].id,
        quantity: 3,
      }],
    }, 'receive-plan-po-0001');
    await db.prepare(`
      UPDATE purchase_receipts SET created_at = '2026-11-02T10:07:00.000Z'
      WHERE tenant_id = ? AND id = ?
    `).bind(tenantId, postedReceipt.receipt.id).run();
    const waitingForMuku = await getPurchasePlanning(db, user, { now });
    expect(waitingForMuku.rows[0]).toEqual(expect.objectContaining({
      decision: 'blocked',
      erpPurchaseChainCoverageQty: 0,
      erpReceivedQty: 3,
      recommendedQty: null,
    }));
    expect(waitingForMuku.rows[0].blockers).toContain('receipt_not_reflected_in_muku');

    await db.prepare(`
      UPDATE muku_inventory_records
      SET available_qty = 6, source_updated_at = '2026-11-02T10:06:00.000Z'
      WHERE tenant_id = ? AND snapshot_id = 'snapshot-inventory'
    `).bind(tenantId).run();
    const stillBeforePosting = await getPurchasePlanning(db, user, { now });
    expect(stillBeforePosting.rows[0].blockers).toContain('receipt_not_reflected_in_muku');
    expect(stillBeforePosting.rows[0].sourceTimes).toEqual(expect.objectContaining({
      latestInventoryEventAt: '2026-11-02T10:07:00.000Z',
    }));
    await db.prepare(`
      UPDATE muku_inventory_records
      SET available_qty = 6, source_updated_at = '2026-11-02T10:08:00.000Z'
      WHERE tenant_id = ? AND snapshot_id = 'snapshot-inventory'
    `).bind(tenantId).run();
    const reflected = await getPurchasePlanning(db, user, { now });
    expect(reflected.rows[0]).toEqual(expect.objectContaining({
      erpPurchaseChainCoverageQty: 0,
      erpOpenPoQty: 0,
      erpReceivedQty: 3,
      recommendedQty: 3,
    }));
    expect(reflected.rows[0].blockers).not.toContain('receipt_not_reflected_in_muku');

    await createPurchaseReceiptCorrection(db, user, postedReceipt.receipt.id, {
      reason: '验收发现本批到货全部录错，完整冲正',
      lines: [{
        purchaseReceiptLineId: postedReceipt.receipt.lines[0].id,
        quantity: 3,
      }],
    }, 'correct-plan-receipt-0001');
    await db.prepare(`
      UPDATE purchase_receipt_corrections SET created_at = '2026-11-02T10:09:00.000Z'
      WHERE tenant_id = ? AND purchase_receipt_id = ?
    `).bind(tenantId, postedReceipt.receipt.id).run();
    await db.prepare(`
      UPDATE muku_inventory_records
      SET available_qty = 3, source_updated_at = '2026-11-02T10:00:00.000Z'
      WHERE tenant_id = ? AND snapshot_id = 'snapshot-inventory'
    `).bind(tenantId).run();
    const afterFullCorrection = await getPurchasePlanning(db, user, { now });
    expect(afterFullCorrection.rows[0]).toEqual(expect.objectContaining({
      erpOpenPoQty: 3,
      erpReceivedQty: 0,
    }));
    expect(afterFullCorrection.rows[0].sourceTimes.latestReceiptAt).toBeNull();
    expect(afterFullCorrection.rows[0].sourceTimes.latestInventoryEventAt)
      .toBe('2026-11-02T10:09:00.000Z');
    expect(afterFullCorrection.rows[0].blockers).toContain('receipt_not_reflected_in_muku');

    await db.prepare(`
      UPDATE muku_inventory_records
      SET available_qty = 3, source_updated_at = '2026-11-02T10:10:00.000Z'
      WHERE tenant_id = ? AND snapshot_id = 'snapshot-inventory'
    `).bind(tenantId).run();
    const correctionReflected = await getPurchasePlanning(db, user, { now });
    expect(correctionReflected.rows[0].blockers).not.toContain('receipt_not_reflected_in_muku');

    await executePurchaseOrderAction(db, buyerUser, purchaseOrder.purchaseOrder.id, {
      action: 'close', note: '供应商无法继续交付，释放剩余需求重新安排',
    }, 'close-plan-po-remainder-0001');
    const afterClose = await getPurchasePlanning(db, user, { now });
    expect(afterClose.rows[0]).toEqual(expect.objectContaining({
      erpPurchaseChainCoverageQty: 0,
      erpOpenPoQty: 0,
      recommendedQty: 6,
    }));
    expect(afterClose.rows[0].conversion).toEqual(expect.objectContaining({
      eligibleOrderQty: 6,
      blockedRecommendationQty: 0,
      conversionBlocked: false,
    }));
  });

  it('人工库存确认过期后拒绝提交既有采购建议草稿', async () => {
    const created = await createManualInventoryPlannedRequest(db, 'expired-submit');
    const expiredAt = new Date(now.getTime() + 24 * 60 * 60 * 1000 + 60_000);
    await refreshOfficialOrderSourceAt(db, expiredAt);

    await expect(executePurchaseRequestAction(
      db,
      buyerUser,
      created.request.id,
      { action: 'submit' },
      'submit-expired-confirmation-0001',
      { now: expiredAt, maxAgeMinutes: 2_000 },
    )).rejects.toMatchObject({ code: 'PURCHASE_RECOMMENDATION_STALE' });
    const stored = await db.prepare('SELECT status FROM purchase_requests WHERE id = ?')
      .bind(created.request.id).first<{ status: string }>();
    expect(stored?.status).toBe('draft');
  });

  it('及时提交后，人工库存确认过期仍会阻止复审批准', async () => {
    const created = await createManualInventoryPlannedRequest(db, 'expired-approve');
    await executePurchaseRequestAction(
      db,
      buyerUser,
      created.request.id,
      { action: 'submit' },
      'submit-before-confirmation-expiry',
      { now },
    );
    const expiredAt = new Date(now.getTime() + 24 * 60 * 60 * 1000 + 60_000);
    await refreshOfficialOrderSourceAt(db, expiredAt);

    await expect(executePurchaseRequestAction(
      db,
      reviewerUser,
      created.request.id,
      { action: 'approve' },
      'approve-after-confirmation-expiry',
      { now: expiredAt, maxAgeMinutes: 2_000 },
    )).rejects.toMatchObject({ code: 'PURCHASE_RECOMMENDATION_STALE' });
    const stored = await db.prepare('SELECT status FROM purchase_requests WHERE id = ?')
      .bind(created.request.id).first<{ status: string }>();
    expect(stored?.status).toBe('pending_review');
  });

  it('旧版计划草稿缺少验证快照时拒绝提交且保留原历史', async () => {
    await upsertMukuSkuMapping(db, user, {
      mukuSku: 'MUKU-CHAIR', skuId: 'sku-service',
    }, 'map-for-legacy-plan-0001');
    const plan = await getPurchasePlanning(db, user, { now });
    const row = plan.rows[0];
    const created = await createPurchaseRequestFromPlanning(db, user, {
      selections: [{
        planRowId: row.planRowId,
        recommendationVersion: row.recommendationVersion,
      }],
      purchaserMemberId: 'member-buyer',
      reviewerMemberId: 'member-reviewer',
    }, 'create-legacy-plan-draft-0001', { now });
    const creationAudit = await db.prepare(`
      SELECT id, after_json FROM audit_logs
      WHERE tenant_id = ? AND entity_id = ? AND action = 'CREATE_PURCHASE_REQUEST_FROM_PLAN'
      LIMIT 1
    `).bind(tenantId, created.request.id).first<{ id: string; after_json: string }>();
    const legacyAudit = JSON.parse(creationAudit!.after_json) as Record<string, unknown>;
    delete legacyAudit.planningEvidence;
    await db.prepare('UPDATE audit_logs SET after_json = ? WHERE id = ?')
      .bind(JSON.stringify(legacyAudit), creationAudit!.id).run();

    await expect(executePurchaseRequestAction(
      db,
      buyerUser,
      created.request.id,
      { action: 'submit' },
      'submit-legacy-plan-draft-0001',
      { now },
    )).rejects.toMatchObject({ code: 'PURCHASE_PLAN_EVIDENCE_MISSING' });
    const stored = await db.prepare(`
      SELECT pr.status, line.active
      FROM purchase_requests pr
      JOIN purchase_request_lines line ON line.request_id = pr.id
      WHERE pr.id = ?
    `).bind(created.request.id).first<{ status: string; active: number }>();
    expect(stored).toEqual({ status: 'draft', active: 1 });
    const auditCount = await db.prepare(`
      SELECT COUNT(*) AS count FROM audit_logs WHERE tenant_id = ? AND entity_id = ?
    `).bind(tenantId, created.request.id).first<{ count: number }>();
    expect(Number(auditCount?.count)).toBe(1);
  });

  it('库存 null 或快照过期时阻断，真实 0 则生成建议', async () => {
    await upsertMukuSkuMapping(db, user, {
      mukuSku: 'MUKU-CHAIR', skuId: 'sku-service',
    }, 'map-muku-chair-2001');
    await db.prepare(`
      UPDATE muku_inventory_records SET available_qty = NULL
      WHERE tenant_id = ? AND snapshot_id = 'snapshot-inventory'
    `).bind(tenantId).run();
    const unknown = await getPurchasePlanning(db, user, { now });
    expect(unknown.rows[0]).toEqual(expect.objectContaining({
      decision: 'blocked', mukuAvailableQty: null, recommendedQty: null,
    }));
    expect(unknown.rows[0].blockers).toContain('muku_available_unknown');

    await db.prepare(`
      UPDATE muku_inventory_records SET available_qty = 0
      WHERE tenant_id = ? AND snapshot_id = 'snapshot-inventory'
    `).bind(tenantId).run();
    const zero = await getPurchasePlanning(db, user, { now });
    expect(zero.rows[0]).toEqual(expect.objectContaining({
      decision: 'buy', mukuAvailableQty: 0, recommendedQty: 9,
    }));

    await db.prepare(`
      UPDATE muku_inventory_records SET source_updated_at = '2026-10-29T10:00:00.000Z'
      WHERE tenant_id = ? AND snapshot_id = 'snapshot-inventory' AND inventory_kind = 'warehouse'
    `).bind(tenantId).run();
    const staleSource = await getPurchasePlanning(db, user, { now });
    expect(staleSource.rows[0]).toEqual(expect.objectContaining({
      decision: 'blocked', recommendedQty: null,
    }));
    expect(staleSource.rows[0].blockers).toContain('inventory_source_stale');
    expect(staleSource.rows[0].sourceTimes).toEqual(expect.objectContaining({
      inventorySourceFreshness: 'stale',
      inventorySourceMaxAgeMinutes: 2880,
    }));

    await db.prepare(`
      UPDATE muku_inventory_records SET source_updated_at = '2026-11-02T10:00:00.000Z'
      WHERE tenant_id = ? AND snapshot_id = 'snapshot-inventory' AND inventory_kind = 'warehouse'
    `).bind(tenantId).run();

    const stale = await getPurchasePlanning(db, user, {
      now: new Date('2026-11-02T12:00:00.000Z'),
      maxAgeMinutes: 30,
    });
    expect(stale.readiness).toBe('stale');
    expect(stale.rows[0]).toEqual(expect.objectContaining({
      decision: 'blocked', recommendedQty: null,
    }));
    expect(stale.rows[0].blockers).toContain('inventory_stale');
  });

  it('安全库存超出订单缺口时只允许订单部分转申请，不伪造订单需求', async () => {
    await db.prepare(`
      UPDATE purchase_demands SET required_quantity = 2, updated_at = ?
      WHERE id = ? AND tenant_id = ?
    `).bind(now.toISOString(), demandId, tenantId).run();
    await db.prepare(`
      UPDATE muku_inventory_records SET available_qty = 0
      WHERE tenant_id = ? AND snapshot_id = 'snapshot-inventory'
    `).bind(tenantId).run();
    await upsertMukuSkuMapping(db, user, {
      mukuSku: 'MUKU-CHAIR', skuId: 'sku-service',
    }, 'map-muku-chair-3001');
    await upsertSkuProcurementPolicy(db, user, {
      skuId: 'sku-service', safetyStockQty: 5,
    }, 'policy-service-3001');
    await expect(upsertSkuProcurementPolicy(db, user, {
      skuId: 'sku-service', safetyStockQty: 6,
    }, 'policy-service-3001')).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    const plan = await getPurchasePlanning(db, user, { now });
    expect(plan.rows[0]).toEqual(expect.objectContaining({
      orderDemandQty: 2,
      safetyStockQty: 5,
      rawGapQty: 7,
      recommendedQty: 7,
    }));
    expect(plan.rows[0].conversion).toEqual(expect.objectContaining({
      eligibleOrderQty: 2,
      blockedRecommendationQty: 5,
      conversionBlocked: true,
      reasons: expect.arrayContaining(['safety_stock_without_purchase_demand']),
    }));
    expect(plan.rows[0].demandAllocations).toEqual([{ demandId, quantity: 2 }]);
  });

  it('已映射但暂无订单的 SKU 仍计算默认 14 天安全库存，但不能伪造需求转申请', async () => {
    await db.prepare(`
      UPDATE purchase_demands
      SET status = 'not_required', required_quantity = 0, reason_code = 'fulfilled', updated_at = ?
      WHERE id = ? AND tenant_id = ?
    `).bind(now.toISOString(), demandId, tenantId).run();
    await db.prepare(`
      UPDATE muku_inventory_records SET available_qty = 0
      WHERE tenant_id = ? AND snapshot_id = 'snapshot-inventory'
    `).bind(tenantId).run();
    await seedFreshRisk(db, 30);
    await upsertMukuSkuMapping(db, user, {
      mukuSku: 'MUKU-CHAIR', skuId: 'sku-service',
    }, 'map-muku-chair-4001');
    const plan = await getPurchasePlanning(db, user, { now });
    expect(plan.rows).toHaveLength(1);
    expect(plan.rows[0]).toEqual(expect.objectContaining({
      orderDemandQty: 0,
      sales30d: 30,
      safetyDays: 14,
      safetyStockQty: 14,
      recommendedQty: 14,
      decision: 'buy',
    }));
    expect(plan.rows[0].conversion).toEqual(expect.objectContaining({
      eligibleOrderQty: 0,
      blockedRecommendationQty: 14,
      conversionBlocked: true,
      reasons: expect.arrayContaining(['safety_stock_without_purchase_demand']),
    }));
    await expect(createPurchaseRequestFromPlanning(db, user, {
      selections: [{
        planRowId: plan.rows[0].planRowId,
        recommendationVersion: plan.rows[0].recommendationVersion,
      }],
      purchaserMemberId: 'member-buyer',
      reviewerMemberId: 'member-reviewer',
    }, 'plan-to-request-4001', { now })).rejects.toMatchObject({
      code: 'PURCHASE_PLAN_NOT_CONVERTIBLE',
    });
  });

  it('LOCAL QA 订单来源不通过真实采购门，不能自动转申请', async () => {
    await upsertMukuSkuMapping(db, user, {
      mukuSku: 'MUKU-CHAIR', skuId: 'sku-service',
    }, 'map-muku-chair-5001');
    await db.prepare(`
      UPDATE platform_stores
      SET credential_ref = 'local:qa', connector_key = 'local_qa', updated_at = ?
      WHERE tenant_id = ?
    `).bind(now.toISOString(), tenantId).run();
    const plan = await getPurchasePlanning(db, user, { now });
    expect(plan.orderSourceReadiness).toBe(false);
    expect(plan.orderSourceBlockers).toContain('no_official_order_source');
    expect(plan.orderSources[0]).toEqual(expect.objectContaining({
      official: false,
      ready: false,
      reasons: expect.arrayContaining(['local_qa_excluded']),
    }));
    await expect(createPurchaseRequestFromPlanning(db, user, {
      selections: [{
        planRowId: plan.rows[0].planRowId,
        recommendationVersion: plan.rows[0].recommendationVersion,
      }],
      purchaserMemberId: 'member-buyer',
      reviewerMemberId: 'member-reviewer',
    }, 'plan-to-request-5001', { now })).rejects.toMatchObject({
      code: 'PURCHASE_ORDER_SOURCE_NOT_READY',
    });
  });

  it('订单同步中或仅完成历史窗口时，不能把订单源判为可采购', async () => {
    await upsertMukuSkuMapping(db, user, {
      mukuSku: 'MUKU-CHAIR', skuId: 'sku-service',
    }, 'map-order-watermark-0001');
    await db.prepare(`
      UPDATE connector_sync_state
      SET status = 'running', updated_at = ?
      WHERE tenant_id = ? AND connector = 'shopify' AND resource = 'orders'
    `).bind(now.toISOString(), tenantId).run();
    const running = await getPurchasePlanning(db, user, { now });
    expect(running.orderSourceReadiness).toBe(false);
    expect(running.orderSourceBlockers).toContain('order_sync_in_progress');

    await db.prepare(`
      UPDATE connector_sync_state
      SET status = 'idle', completed_watermark = '2026-10-01T00:00:00.000Z',
          last_success_at = ?, updated_at = ?
      WHERE tenant_id = ? AND connector = 'shopify' AND resource = 'orders'
    `).bind(now.toISOString(), now.toISOString(), tenantId).run();
    await db.prepare(`
      UPDATE platform_stores SET last_successful_sync_at = ?, updated_at = ?
      WHERE tenant_id = ?
    `).bind(now.toISOString(), now.toISOString(), tenantId).run();
    const historicalWindow = await getPurchasePlanning(db, user, { now });
    expect(historicalWindow.orderSourceReadiness).toBe(false);
    expect(historicalWindow.orderSourceBlockers).toContain('order_sync_watermark_stale');
    expect(historicalWindow.orderSources[0]).toEqual(expect.objectContaining({
      completedWatermarkAt: '2026-10-01T00:00:00.000Z',
      ready: false,
    }));
  });

  it('MOQ/包装取整超过订单缺口时后端拒绝生成低于策略量的申请', async () => {
    await upsertMukuSkuMapping(db, user, {
      mukuSku: 'MUKU-CHAIR', skuId: 'sku-service',
    }, 'map-muku-chair-6001');
    await upsertSkuProcurementPolicy(db, user, {
      skuId: 'sku-service', moq: 10,
    }, 'policy-service-6001');
    const plan = await getPurchasePlanning(db, user, { now });
    expect(plan.rows[0]).toEqual(expect.objectContaining({
      recommendedQty: 10,
    }));
    expect(plan.rows[0].conversion).toEqual(expect.objectContaining({
      eligibleOrderQty: 3,
      policyRoundingQty: 7,
      conversionBlocked: true,
      reasons: expect.arrayContaining(['policy_rounding_exceeds_order_gap']),
    }));
    await expect(createPurchaseRequestFromPlanning(db, user, {
      selections: [{
        planRowId: plan.rows[0].planRowId,
        recommendationVersion: plan.rows[0].recommendationVersion,
      }],
      purchaserMemberId: 'member-buyer',
      reviewerMemberId: 'member-reviewer',
    }, 'plan-to-request-6001', { now })).rejects.toMatchObject({
      code: 'PURCHASE_POLICY_ROUNDING_NOT_CONVERTIBLE',
    });
  });
});

async function createManualInventoryPlannedRequest(db: D1Database, key: string) {
  await upsertSkuInventoryConfirmation(db, user, {
    skuId: 'sku-service',
    confirmedAvailableQty: 6,
    note: '测试 24 小时人工库存确认失效保护',
  }, `confirm-manual-${key}`, { now });
  const plan = await getPurchasePlanning(db, user, { now });
  const row = plan.rows[0];
  expect(row).toEqual(expect.objectContaining({
    availableQtySource: 'manual_confirmation',
    effectiveAvailableQty: 6,
  }));
  expect(row.inventoryConfirmation).toEqual(expect.objectContaining({ active: true, used: true }));
  return createPurchaseRequestFromPlanning(db, user, {
    selections: [{
      planRowId: row.planRowId,
      recommendationVersion: row.recommendationVersion,
    }],
    purchaserMemberId: 'member-buyer',
    reviewerMemberId: 'member-reviewer',
  }, `create-manual-plan-${key}`, { now });
}

async function refreshOfficialOrderSourceAt(db: D1Database, timestamp: Date) {
  const value = timestamp.toISOString();
  await db.batch([
    db.prepare(`
      UPDATE platform_stores
      SET last_successful_sync_at = ?, updated_at = ?
      WHERE tenant_id = ?
    `).bind(value, value, tenantId),
    db.prepare(`
      UPDATE connector_sync_state
      SET status = 'idle', completed_watermark = ?, last_success_at = ?, updated_at = ?
      WHERE tenant_id = ? AND connector = 'shopify' AND resource = 'orders'
    `).bind(value, value, value, tenantId),
  ]);
}

async function seedMembers(db: D1Database) {
  const timestamp = '2026-11-02T09:00:00.000Z';
  await db.batch([
    db.prepare('INSERT INTO tenants (id, name, created_at) VALUES (?, ?, ?)')
      .bind(tenantId, '采购计划测试工作区', timestamp),
    db.prepare(`INSERT INTO members (id, tenant_id, auth_user_id, email, display_name, role, created_at)
      VALUES ('member-planner', ?, ?, ?, '采购计划员', 'admin', ?)`)
      .bind(tenantId, user.id, user.email, timestamp),
    db.prepare(`INSERT INTO members (id, tenant_id, auth_user_id, email, display_name, role, created_at)
      VALUES ('member-buyer', ?, 'auth-buyer', 'buyer@example.invalid', '采购员', 'operator', ?)`)
      .bind(tenantId, timestamp),
    db.prepare(`INSERT INTO members (id, tenant_id, auth_user_id, email, display_name, role, created_at)
      VALUES ('member-reviewer', ?, 'auth-reviewer', 'reviewer@example.invalid', '复审员', 'admin', ?)`)
      .bind(tenantId, timestamp),
  ]);
}

async function seedDemand(db: D1Database, quantity: number) {
  const repository = new PlatformOrderRepository(db, tenantId);
  const storeId = (await repository.upsertVerifiedShopifyStore(
    config,
    shopContext,
    '2026-11-02T09:01:00.000Z',
  )).id;
  await db.prepare(`
    UPDATE platform_stores SET last_successful_sync_at = ?, updated_at = ?
    WHERE id = ? AND tenant_id = ?
  `).bind(
    '2026-11-02T10:00:00.000Z',
    '2026-11-02T10:00:00.000Z',
    storeId,
    tenantId,
  ).run();
  await db.prepare(`
    INSERT INTO connector_sync_state (
      id, tenant_id, platform_store_id, connector, resource, completed_watermark,
      active_window_start, active_window_end, next_page_cursor, overlap_seconds,
      status, last_run_id, last_success_at, last_error_code, last_error_at, updated_at
    ) VALUES (
      'sync-state-orders', ?, ?, 'shopify', 'orders', ?,
      NULL, NULL, NULL, 21600, 'idle', NULL, ?, NULL, NULL, ?
    )
  `).bind(
    tenantId,
    storeId,
    '2026-11-02T10:00:00.000Z',
    '2026-11-02T10:00:00.000Z',
    '2026-11-02T10:00:00.000Z',
  ).run();
  const graph = shopifyOrderFixture({
    updatedAt: '2026-11-02T09:02:00Z',
    displayFinancialStatus: 'PAID',
    displayFulfillmentStatus: 'UNFULFILLED',
    refunds: [],
    fulfillments: [],
  });
  graph.lines[1].rawSku = 'SERVICE-01';
  graph.lines[1].normalizedSku = 'SERVICE-01';
  await repository.upsertOrderGraph({
    storeId, graph, apiVersion: '2026-07', runId: null,
    fetchedAt: '2026-11-02T09:02:01.000Z',
  });
  await db.prepare(`
    INSERT INTO skus (id, tenant_id, code, name, active, created_at)
    VALUES ('sku-service', ?, 'SERVICE-01', '服务商品', 1, ?)
  `).bind(tenantId, '2026-11-02T09:02:02.000Z').run();
  await db.prepare(`
    UPDATE platform_sku_mappings
    SET sku_id = 'sku-service', status = 'mapped', mapping_source = 'planning_test', updated_at = ?
    WHERE tenant_id = ? AND platform_store_id = ? AND raw_sku = 'SERVICE-01'
  `).bind('2026-11-02T09:02:02.000Z', tenantId, storeId).run();
  await repository.upsertOrderGraph({
    storeId, graph, apiVersion: '2026-07', runId: null,
    fetchedAt: '2026-11-02T09:02:03.000Z',
  });
  const demand = await db.prepare(`
    SELECT id FROM purchase_demands
    WHERE tenant_id = ? AND raw_sku = 'SERVICE-01' AND status = 'open'
    LIMIT 1
  `).bind(tenantId).first<{ id: string }>();
  if (!demand) throw new Error('planning test demand missing');
  await db.prepare(`
    UPDATE purchase_demands SET required_quantity = ?, updated_at = ?
    WHERE id = ? AND tenant_id = ?
  `).bind(quantity, '2026-11-02T09:03:00.000Z', demand.id, tenantId).run();
  return demand.id;
}

async function seedFreshInventory(
  db: D1Database,
  input: { availableQty: number | null; inboundQty: number | null },
) {
  const timestamp = '2026-11-02T10:00:00.000Z';
  await db.batch([
    db.prepare(`
      INSERT INTO muku_snapshots (
        id, tenant_id, dataset, status, api_version, generated_at, source, grain,
        business_timezone, refresh_cadence, zero_semantics, filters_json, content_hash,
        page_count, record_count, expected_total, source_updated_at, ingested_at,
        activated_at, created_at
      ) VALUES (
        'snapshot-inventory', ?, 'inventory', 'active', 'v1', ?, 'muku-readonly',
        'sku+warehouse', 'Asia/Shanghai', '15m', 'zero_is_real', '{}', 'hash-inventory',
        1, 2, 2, ?, ?, ?, ?
      )
    `).bind(tenantId, timestamp, timestamp, timestamp, timestamp, timestamp),
    db.prepare(`
      INSERT INTO muku_dataset_state (
        id, tenant_id, dataset, active_snapshot_id, status, api_version, generated_at,
        source, grain, business_timezone, refresh_cadence, zero_semantics, record_count,
        page_count, last_run_id, last_success_at, last_error_code, last_error_at, updated_at
      ) VALUES (
        'state-inventory', ?, 'inventory', 'snapshot-inventory', 'ready', 'v1', ?,
        'muku-readonly', 'sku+warehouse', 'Asia/Shanghai', '15m', 'zero_is_real', 2,
        1, NULL, ?, NULL, NULL, ?
      )
    `).bind(tenantId, timestamp, timestamp, timestamp),
    db.prepare(`
      INSERT INTO muku_inventory_records (
        id, tenant_id, snapshot_id, stable_key, record_key, source_id, source_snapshot_id,
        inventory_kind, warehouse_code, warehouse_name, region, sku, available_qty,
        locked_qty, on_hand_qty, inbound_qty, age_days, source_updated_at, ingested_at,
        raw_json, raw_hash, created_at
      ) VALUES (
        'inventory-record-1', ?, 'snapshot-inventory', 'MUKU-CHAIR|WH-A', NULL, NULL, NULL,
        'warehouse', 'WH-A', '测试仓', 'US', 'MUKU-CHAIR', ?, 0, ?, ?, 1, ?, ?, '{}',
        'record-hash', ?
      )
    `).bind(
      tenantId,
      input.availableQty,
      input.availableQty,
      0,
      timestamp,
      timestamp,
      timestamp,
    ),
    db.prepare(`
      INSERT INTO muku_inventory_records (
        id, tenant_id, snapshot_id, stable_key, record_key, source_id, source_snapshot_id,
        inventory_kind, warehouse_code, warehouse_name, region, sku, available_qty,
        locked_qty, on_hand_qty, inbound_qty, age_days, source_updated_at, ingested_at,
        raw_json, raw_hash, created_at
      ) VALUES (
        'inventory-record-transit', ?, 'snapshot-inventory', 'MUKU-CHAIR|IN-TRANSIT', NULL, NULL, NULL,
        'in_transit', NULL, NULL, 'US', 'MUKU-CHAIR', 0, 0, 0, ?, 0,
        '2026-11-02T10:09:00.000Z', ?, '{}', 'transit-record-hash', ?
      )
    `).bind(tenantId, input.inboundQty, timestamp, timestamp),
  ]);
}

async function seedFreshRisk(db: D1Database, sales30d: number | null) {
  const timestamp = '2026-11-02T10:00:00.000Z';
  await db.batch([
    db.prepare(`
      INSERT INTO muku_snapshots (
        id, tenant_id, dataset, status, api_version, generated_at, source, grain,
        business_timezone, refresh_cadence, zero_semantics, filters_json, content_hash,
        page_count, record_count, expected_total, source_updated_at, ingested_at,
        activated_at, created_at
      ) VALUES (
        'snapshot-risk', ?, 'inventory-risk', 'active', 'v1', ?, 'muku-readonly',
        'sku', 'Asia/Shanghai', '15m', 'zero_is_real', '{}', 'hash-risk',
        1, 1, 1, ?, ?, ?, ?
      )
    `).bind(tenantId, timestamp, timestamp, timestamp, timestamp, timestamp),
    db.prepare(`
      INSERT INTO muku_dataset_state (
        id, tenant_id, dataset, active_snapshot_id, status, api_version, generated_at,
        source, grain, business_timezone, refresh_cadence, zero_semantics, record_count,
        page_count, last_run_id, last_success_at, last_error_code, last_error_at, updated_at
      ) VALUES (
        'state-risk', ?, 'inventory-risk', 'snapshot-risk', 'ready', 'v1', ?,
        'muku-readonly', 'sku', 'Asia/Shanghai', '15m', 'zero_is_real', 1,
        1, NULL, ?, NULL, NULL, ?
      )
    `).bind(tenantId, timestamp, timestamp, timestamp),
    db.prepare(`
      INSERT INTO muku_inventory_risk_records (
        id, tenant_id, snapshot_id, stable_key, sku, sales_30d, available_qty,
        locked_qty, on_hand_qty, inbound_qty, warehouse_count, max_age_days,
        slow_moving, over_age, active_low_stock, matched_by, source_updated_at,
        raw_json, raw_hash, created_at
      ) VALUES (
        'risk-record-1', ?, 'snapshot-risk', 'MUKU-CHAIR', 'MUKU-CHAIR', ?, 0,
        0, 0, 0, 1, 1, 0, 0, 1, 'sku', ?, '{}', 'risk-hash', ?
      )
    `).bind(tenantId, sales30d, timestamp, timestamp),
  ]);
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
    '../drizzle/0011_dazzling_menace.sql',
    '../drizzle/0012_square_slyde.sql',
    '../drizzle/0014_clever_silvermane.sql',
    '../drizzle/0015_true_tigra.sql',
    '../drizzle/0016_brief_doomsday.sql',
  ]) {
    const sql = readFileSync(new URL(migration, import.meta.url), 'utf8');
    for (const statement of sql.split('--> statement-breakpoint').map((item) => item.trim()).filter(Boolean)) {
      await db.prepare(statement).run();
    }
  }
}
