import { readdirSync, readFileSync } from 'node:fs';
import { Miniflare } from 'miniflare';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({ env: {} }));

import { PlatformOrderRepository } from '../lib/connectors/repository';
import type { ShopifyCredentialConfig } from '../lib/connectors/shopify/config';
import type { ShopifyShopContext } from '../lib/connectors/shopify/connector';
import type { UserContext } from '../lib/db';
import { ROLE_PERMISSIONS } from '../lib/domain';
import { loadPurchaseOrderDocument } from '../lib/purchase-order-document';
import {
  createPurchaseReceiptCorrection,
  listPurchaseReceiptCorrections,
} from '../lib/purchase-receipt-correction-service';
import {
  createPurchaseOrder,
  createPurchaseReceipt,
  createSupplier,
  createWarehouse,
  executePurchaseOrderAction as executePurchaseOrderActionService,
  getProcurementWorkspaceData,
  updatePurchaseOrderDraft,
} from '../lib/purchase-order-service';
import {
  createPurchaseRequest,
  executePurchaseRequestAction,
  getPurchaseWorkspace,
} from '../lib/purchase-workflow-service';
import { shopifyOrderFixture } from './fixtures/shopify-order';

const tenantId = 'tenant_purchase_order';
const user: UserContext = {
  id: 'auth-creator', email: 'creator@example.invalid', displayName: '创建人', role: 'admin',
  permissions: ROLE_PERMISSIONS.admin, tenantId, tenantName: '采购单测试工作区',
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
const otherOperator: UserContext = {
  ...buyerUser, id: 'auth-other-operator', email: 'other-operator@example.invalid', displayName: '另一采购员',
};
const config: ShopifyCredentialConfig = {
  key: 'bizfurniz', displayName: 'BizFurniz', domain: 'fixture-bizfurniz-alias.myshopify.com',
  expectedDomain: 'fixture-bizfurniz-alias.myshopify.com', acceptedDomains: ['fixture-bizfurniz-alias.myshopify.com'],
  environmentPrefix: 'SHOPIFY_BIZFURNIZ', authMode: 'oauth', credentialRef: 'env:test',
  adminAccessToken: null, clientId: null, clientSecret: null,
};
const shopContext: ShopifyShopContext = {
  id: 'gid://shopify/Shop/9001', name: 'BizFurniz', domain: 'fixture-bizfurniz-alias.myshopify.com',
  timezone: 'America/Los_Angeles', timezoneOffset: '-0700', currency: 'USD',
  scopes: new Set(['read_orders']),
};

function executePurchaseOrderAction(
  database: D1Database,
  actor: UserContext,
  purchaseOrderId: string,
  input: { action: 'issue' | 'cancel' | 'close'; note?: string; expectedVersion?: number },
  idempotencyKey: string,
) {
  return executePurchaseOrderActionService(
    database,
    actor,
    purchaseOrderId,
    input,
    idempotencyKey,
    { validatePlanningEvidence: async () => undefined },
  );
}

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

  it('仓库可幂等创建、编码冲突受控且租户数据隔离', async () => {
    const created = await createWarehouse(db, user, {
      code: ' aux ', name: '采购到货辅仓',
    }, 'warehouse-create-0001');
    expect(created.replayed).toBe(false);
    expect(created.warehouse).toEqual(expect.objectContaining({
      code: 'AUX', name: '采购到货辅仓',
    }));

    const replay = await createWarehouse(db, user, {
      code: 'AUX', name: '采购到货辅仓',
    }, 'warehouse-create-0001');
    expect(replay.replayed).toBe(true);
    expect(replay.warehouse.id).toBe(created.warehouse.id);

    await expect(createWarehouse(db, user, {
      code: 'AUX-CHANGED', name: '不同参数',
    }, 'warehouse-create-0001')).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(createWarehouse(db, user, {
      code: 'AUX', name: '重复仓库编码',
    }, 'warehouse-create-0002')).rejects.toMatchObject({ code: 'WAREHOUSE_CODE_EXISTS' });

    const otherTenantUser: UserContext = {
      ...user,
      id: 'auth-other-warehouse',
      email: 'other-warehouse@example.invalid',
      tenantId: 'tenant-other',
      tenantName: '其他租户',
    };
    const other = await createWarehouse(db, otherTenantUser, {
      code: 'AUX', name: '其他租户同编码仓库',
    }, 'warehouse-create-other-0001');
    expect(other.warehouse.id).not.toBe(created.warehouse.id);

    const workspace = await getProcurementWorkspaceData(db, user);
    expect(workspace.warehouses.map((warehouse) => warehouse.code).sort()).toEqual(['AUX', 'MAIN']);
    expect(workspace.warehouses.map((warehouse) => warehouse.id)).not.toContain(other.warehouse.id);

    const viewer: UserContext = {
      ...user,
      role: 'viewer',
      permissions: ROLE_PERMISSIONS.viewer,
    };
    await expect(createWarehouse(db, viewer, {
      code: 'VIEWER', name: '只读账号仓库',
    }, 'warehouse-create-viewer-0001')).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });

    const audit = await db.prepare(`
      SELECT COUNT(*) AS count FROM audit_logs
      WHERE tenant_id = ? AND action = 'CREATE_WAREHOUSE'
    `).bind(tenantId).first<{ count: number }>();
    expect(Number(audit?.count)).toBe(1);
  });

  it('工作台列表达到上限时汇总仍按全租户数据计算', async () => {
    await db.prepare(`
      WITH RECURSIVE sequence(number) AS (
        SELECT 1
        UNION ALL
        SELECT number + 1 FROM sequence WHERE number < 501
      )
      INSERT INTO suppliers (
        id, tenant_id, code, name, note, active, version,
        idempotency_key, request_hash, created_by_member_id, created_at, updated_at
      )
      SELECT
        printf('supplier-boundary-%03d', number),
        ?,
        printf('BOUNDARY-%03d', number),
        printf('边界供应商 %03d', number),
        NULL,
        1,
        1,
        printf('supplier-boundary-key-%03d', number),
        printf('supplier-boundary-hash-%03d', number),
        'member-creator',
        '2026-11-02T00:00:00.000Z',
        '2026-11-02T00:00:00.000Z'
      FROM sequence
    `).bind(tenantId).run();

    const workspace = await getProcurementWorkspaceData(db, user);
    expect(workspace.suppliers).toHaveLength(500);
    expect(workspace.procurementSummary.suppliers).toBe(501);
  });

  it('历史采购单超过上限时仍返回全部活跃采购单及完整明细', async () => {
    const supplier = await createSupplier(db, user, {
      code: 'SUP-VISIBILITY', name: '活跃单据可见性供应商',
    }, 'supplier-visibility-0001');
    const active = await createPurchaseOrder(db, buyerUser, {
      purchaseRequestId: approvedRequestId,
      supplierId: supplier.supplier.id,
      currency: 'USD',
      lineCosts: [{
        purchaseRequestLineId: await requestLineId(db, approvedRequestId),
        unitCostMinor: 100,
      }],
    }, 'purchase-order-visible-active-0001');
    await db.prepare(`
      UPDATE purchase_orders
      SET created_at = '2020-01-01T00:00:00.000Z', updated_at = '2020-01-01T00:00:00.000Z'
      WHERE tenant_id = ? AND id = ?
    `).bind(tenantId, active.purchaseOrder.id).run();

    await db.prepare(`
      WITH RECURSIVE sequence(number) AS (
        SELECT 1
        UNION ALL
        SELECT number + 1 FROM sequence WHERE number < 505
      )
      INSERT INTO purchase_orders (
        id, tenant_id, order_no, purchase_request_id, supplier_id, status,
        currency, note, action_note, version, idempotency_key, request_hash,
        last_action_key, created_by_member_id, issued_at, closed_at, cancelled_at,
        created_at, updated_at
      )
      SELECT
        printf('purchase-order-history-%03d', number),
        ?,
        printf('CGD-HISTORY-%03d', number),
        ?,
        ?,
        'cancelled',
        'USD',
        '历史采购单',
        '历史已取消',
        1,
        printf('purchase-order-history-key-%03d', number),
        printf('purchase-order-history-hash-%03d', number),
        printf('purchase-order-history-action-%03d', number),
        'member-creator',
        NULL,
        NULL,
        '2026-11-02T00:00:00.000Z',
        '2026-11-02T00:00:00.000Z',
        '2026-11-02T00:00:00.000Z'
      FROM sequence
    `).bind(tenantId, approvedRequestId, supplier.supplier.id).run();

    const workspace = await getProcurementWorkspaceData(db, user);
    const visibleActive = workspace.purchaseOrders.find((order) => order.id === active.purchaseOrder.id);
    expect(visibleActive).toEqual(expect.objectContaining({ status: 'draft', lineCount: 1 }));
    expect(visibleActive?.lines).toHaveLength(1);
    expect(workspace.purchaseOrders.filter((order) => order.status === 'cancelled')).toHaveLength(500);
    expect(workspace.purchaseOrders).toHaveLength(501);
    expect(workspace.procurementSummary.draftOrders).toBe(1);
  });

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

    const created = await createPurchaseOrder(db, buyerUser, {
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
      purchaserMemberId: 'member-buyer',
      currency: 'USD', orderedQuantity: 5, receivedQuantity: 0,
      supplier: expect.objectContaining({ code: 'SUP-01' }),
    }));
    expect(created.purchaseOrder.lines[0]).toEqual(expect.objectContaining({
      orderedQuantity: 5, remainingQuantity: 5, unitCostMinor: 1250,
    }));

    const replay = await createPurchaseOrder(db, buyerUser, {
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

    await expect(createPurchaseOrder(db, buyerUser, {
      purchaseRequestId: approvedRequestId,
      supplierId: supplier.supplier.id,
    }, 'purchase-order-create-0002')).rejects.toMatchObject({ code: 'PURCHASE_ORDER_ALREADY_EXISTS' });
  });

  it('旧申请缺少可复验采购计划证据时只能保留草稿，不能正式下单', async () => {
    await db.prepare(`
      UPDATE audit_logs SET after_json = '{}'
      WHERE tenant_id = ? AND entity_type = 'purchase_request' AND entity_id = ?
        AND action = 'CREATE_PURCHASE_REQUEST_FROM_PLAN'
    `).bind(tenantId, approvedRequestId).run();
    const supplier = await createSupplier(db, user, {
      code: 'SUP-NO-PLAN-EVIDENCE', name: '缺计划证据供应商',
    }, 'supplier-no-plan-evidence-0001');
    const created = await createPurchaseOrder(db, buyerUser, {
      purchaseRequestId: approvedRequestId,
      supplierId: supplier.supplier.id,
      ...(await readyPurchaseOrderFields(db, approvedRequestId)),
    }, 'po-no-plan-evidence-create-0001');

    await expect(executePurchaseOrderAction(db, buyerUser, created.purchaseOrder.id, {
      action: 'issue',
    }, 'po-no-plan-evidence-issue-0001')).rejects.toMatchObject({
      code: 'PURCHASE_PLAN_EVIDENCE_MISSING',
    });
    const stored = await db.prepare(`
      SELECT status FROM purchase_orders WHERE tenant_id = ? AND id = ?
    `).bind(tenantId, created.purchaseOrder.id).first<{ status: string }>();
    expect(stored?.status).toBe('draft');
  });

  it('草稿可更新交期、条款和单价并保留来源及快照，重复保存只写一次审计', async () => {
    const { supplier } = await createSupplier(db, user, {
      code: 'SUP-EDIT-DRAFT', name: '草稿编辑供应商',
    }, 'supplier-edit-draft-0001');
    const { purchaseOrder: original } = await createPurchaseOrder(db, buyerUser, {
      purchaseRequestId: approvedRequestId,
      supplierId: supplier.id,
      ...(await readyPurchaseOrderFields(db, approvedRequestId)),
      paymentTerms: '旧付款条款',
      tradeTerms: '旧贸易条款',
      note: '旧备注',
    }, 'po-edit-draft-create-0001');
    const input = {
      expectedVersion: original.version,
      expectedDeliveryAt: '2026-12-01',
      currency: 'cny',
      paymentTerms: ' 货到付款 ',
      note: ' 更新后的备注 ',
      lineCosts: [{
        purchaseRequestLineId: original.lines[0].purchaseRequestLineId,
        unitCostMinor: 1250,
      }],
    };
    const [first, second] = await Promise.all([
      updatePurchaseOrderDraft(db, buyerUser, original.id, input, 'po-edit-draft-0001'),
      updatePurchaseOrderDraft(db, buyerUser, original.id, input, 'po-edit-draft-0001'),
    ]);
    expect([first.replayed, second.replayed].sort()).toEqual([false, true]);
    expect(first.purchaseOrder).toMatchObject({
      status: 'draft',
      version: original.version + 1,
      purchaseRequestId: approvedRequestId,
      orderNo: original.orderNo,
      supplier: original.supplier,
      deliveryWarehouse: original.deliveryWarehouse,
      expectedDeliveryAt: '2026-12-01',
      currency: 'CNY',
      paymentTerms: '货到付款',
      tradeTerms: null,
      note: '更新后的备注',
      lines: [{
        ...original.lines[0],
        unitCostMinor: 1250,
        currency: 'CNY',
      }],
    });
    await expect(updatePurchaseOrderDraft(
      db, buyerUser, original.id, { ...input, note: '不同参数' }, 'po-edit-draft-0001',
    )).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });

    const audit = await db.prepare(`
      SELECT before_json, after_json FROM audit_logs
      WHERE tenant_id = ? AND entity_id = ? AND action = 'UPDATE_PURCHASE_ORDER_DRAFT'
    `).bind(tenantId, original.id).all<{ before_json: string; after_json: string }>();
    expect(audit.results).toHaveLength(1);
    expect(JSON.parse(audit.results[0].before_json)).toMatchObject({
      paymentTerms: '旧付款条款',
      lineCosts: [{ unitCostMinor: 100, currency: 'USD' }],
    });
    expect(JSON.parse(audit.results[0].after_json)).toMatchObject({
      version: original.version + 1,
      paymentTerms: '货到付款',
      lineCosts: [{ unitCostMinor: 1250 }],
    });
  });

  it('负责人或管理员可改草稿，拒绝旧版本确认及已下单修改', async () => {
    const { supplier } = await createSupplier(db, user, {
      code: 'SUP-EDIT-GUARDS', name: '草稿防护供应商',
    }, 'supplier-edit-guards-0001');
    const { purchaseOrder: original } = await createPurchaseOrder(db, buyerUser, {
      purchaseRequestId: approvedRequestId,
      supplierId: supplier.id,
      ...(await readyPurchaseOrderFields(db, approvedRequestId)),
    }, 'po-edit-guards-create-0001');
    const input = {
      expectedVersion: original.version,
      expectedDeliveryAt: '2026-12-01',
      currency: 'USD',
      lineCosts: [{ purchaseRequestLineId: original.lines[0].purchaseRequestLineId, unitCostMinor: 200 }],
    };
    await expect(updatePurchaseOrderDraft(
      db, otherOperator, original.id, input, 'po-edit-guards-denied-0001',
    )).rejects.toMatchObject({ code: 'PURCHASE_ORDER_PURCHASER_REQUIRED' });
    await expect(updatePurchaseOrderDraft(
      db, { ...buyerUser, permissions: ROLE_PERMISSIONS.viewer }, original.id, input, 'po-edit-guards-denied-0002',
    )).rejects.toMatchObject({ status: 403 });
    await expect(updatePurchaseOrderDraft(
      db, buyerUser, original.id, { ...input, lineCosts: [] }, 'po-edit-guards-line-invalid-0001',
    )).rejects.toMatchObject({ code: 'PURCHASE_ORDER_LINE_INVALID' });

    const { purchaseOrder: updated } = await updatePurchaseOrderDraft(
      db, reviewerUser, original.id, input, 'po-edit-guards-update-0001',
    );
    await expect(updatePurchaseOrderDraft(
      db, buyerUser, original.id, input, 'po-edit-guards-stale-0001',
    )).rejects.toMatchObject({ code: 'CONCURRENT_UPDATE' });
    await expect(executePurchaseOrderAction(
      db, buyerUser, original.id, { action: 'issue', expectedVersion: original.version }, 'po-edit-guards-issue-0001',
    )).rejects.toMatchObject({ code: 'CONCURRENT_UPDATE' });
    const issue = { action: 'issue', expectedVersion: updated.version } as const;
    const { purchaseOrder: issued } = await executePurchaseOrderAction(
      db, buyerUser, original.id, issue, 'po-edit-guards-issue-0002',
    );
    expect(issued.status).toBe('issued');
    await expect(executePurchaseOrderAction(
      db, buyerUser, original.id, issue, 'po-edit-guards-issue-0002',
    )).resolves.toMatchObject({ replayed: true });
    await expect(updatePurchaseOrderDraft(
      db, buyerUser, original.id, { ...input, expectedVersion: issued.version }, 'po-edit-guards-issued-0001',
    )).rejects.toMatchObject({ code: 'PURCHASE_ORDER_NOT_EDITABLE' });
  });

  it('正式下单缺仓库、交期、币种或单价时 fail-closed，完整采购单才能确认', async () => {
    const supplier = await createSupplier(db, user, {
      code: 'SUP-ISSUE-GUARD', name: '正式下单校验供应商',
    }, 'supplier-issue-guard-0001');
    const lineId = await requestLineId(db, approvedRequestId);
    const cost = [{ purchaseRequestLineId: lineId, unitCostMinor: 100 }];
    const cancelDraft = async (purchaseOrderId: string, key: string) => executePurchaseOrderAction(
      db,
      buyerUser,
      purchaseOrderId,
      { action: 'cancel', note: '校验失败后取消旧草稿并重建' },
      key,
    );

    const missingWarehouse = await createPurchaseOrder(db, buyerUser, {
      purchaseRequestId: approvedRequestId,
      supplierId: supplier.supplier.id,
      expectedDeliveryAt: '2026-11-30',
      currency: 'USD',
      lineCosts: cost,
    }, 'po-issue-guard-create-no-warehouse');
    const withoutWarehouse = await updatePurchaseOrderDraft(db, buyerUser, missingWarehouse.purchaseOrder.id, {
      expectedVersion: missingWarehouse.purchaseOrder.version,
      expectedDeliveryAt: '2026-12-01',
      currency: 'USD',
      lineCosts: cost,
    }, 'po-issue-guard-update-no-warehouse');
    expect(withoutWarehouse.purchaseOrder.deliveryWarehouse).toBeNull();
    await expect(executePurchaseOrderAction(db, buyerUser, missingWarehouse.purchaseOrder.id, {
      action: 'issue',
    }, 'po-issue-guard-issue-no-warehouse')).rejects.toMatchObject({
      code: 'PURCHASE_ORDER_DELIVERY_WAREHOUSE_REQUIRED',
    });
    await cancelDraft(missingWarehouse.purchaseOrder.id, 'po-issue-guard-cancel-no-warehouse');

    const missingDelivery = await createPurchaseOrder(db, buyerUser, {
      purchaseRequestId: approvedRequestId,
      supplierId: supplier.supplier.id,
      deliveryWarehouseId: 'warehouse-main',
      currency: 'USD',
      lineCosts: cost,
    }, 'po-issue-guard-create-no-delivery');
    await expect(executePurchaseOrderAction(db, buyerUser, missingDelivery.purchaseOrder.id, {
      action: 'issue',
    }, 'po-issue-guard-issue-no-delivery')).rejects.toMatchObject({
      code: 'PURCHASE_ORDER_EXPECTED_DELIVERY_REQUIRED',
    });
    await cancelDraft(missingDelivery.purchaseOrder.id, 'po-issue-guard-cancel-no-delivery');

    const missingCurrency = await createPurchaseOrder(db, buyerUser, {
      purchaseRequestId: approvedRequestId,
      supplierId: supplier.supplier.id,
      deliveryWarehouseId: 'warehouse-main',
      expectedDeliveryAt: '2026-11-30',
      lineCosts: cost,
    }, 'po-issue-guard-create-no-currency');
    await expect(executePurchaseOrderAction(db, buyerUser, missingCurrency.purchaseOrder.id, {
      action: 'issue',
    }, 'po-issue-guard-issue-no-currency')).rejects.toMatchObject({
      code: 'PURCHASE_ORDER_CURRENCY_REQUIRED',
    });
    await cancelDraft(missingCurrency.purchaseOrder.id, 'po-issue-guard-cancel-no-currency');

    const missingCost = await createPurchaseOrder(db, buyerUser, {
      purchaseRequestId: approvedRequestId,
      supplierId: supplier.supplier.id,
      deliveryWarehouseId: 'warehouse-main',
      expectedDeliveryAt: '2026-11-30',
      currency: 'USD',
    }, 'po-issue-guard-create-no-cost');
    await expect(executePurchaseOrderAction(db, buyerUser, missingCost.purchaseOrder.id, {
      action: 'issue',
    }, 'po-issue-guard-issue-no-cost')).rejects.toMatchObject({
      code: 'PURCHASE_ORDER_UNIT_COST_REQUIRED',
    });
    await cancelDraft(missingCost.purchaseOrder.id, 'po-issue-guard-cancel-no-cost');

    const concurrentChange = await createPurchaseOrder(db, buyerUser, {
      purchaseRequestId: approvedRequestId,
      supplierId: supplier.supplier.id,
      ...(await readyPurchaseOrderFields(db, approvedRequestId)),
    }, 'po-issue-guard-create-race');
    let raced = false;
    const racingDb = {
      prepare: db.prepare.bind(db),
      batch: async (statements: D1PreparedStatement[]) => {
        if (!raced) {
          raced = true;
          await db.prepare(`
            UPDATE purchase_order_lines SET currency = 'EUR'
            WHERE tenant_id = ? AND purchase_order_id = ?
          `).bind(tenantId, concurrentChange.purchaseOrder.id).run();
        }
        return db.batch(statements);
      },
    } as unknown as D1Database;
    await expect(executePurchaseOrderAction(racingDb, buyerUser, concurrentChange.purchaseOrder.id, {
      action: 'issue',
    }, 'po-issue-guard-issue-race')).rejects.toMatchObject({
      code: 'PURCHASE_ORDER_LINE_CURRENCY_MISMATCH',
    });
    const guarded = await db.prepare(`
      SELECT status FROM purchase_orders WHERE tenant_id = ? AND id = ?
    `).bind(tenantId, concurrentChange.purchaseOrder.id).first<{ status: string }>();
    expect(guarded?.status).toBe('draft');
    await cancelDraft(concurrentChange.purchaseOrder.id, 'po-issue-guard-cancel-race');

    const sourceRace = await createPurchaseOrder(db, buyerUser, {
      purchaseRequestId: approvedRequestId,
      supplierId: supplier.supplier.id,
      ...(await readyPurchaseOrderFields(db, approvedRequestId)),
    }, 'po-issue-guard-create-source-race');
    const sourceLine = await db.prepare(`
      SELECT purchase_demand_id, requested_quantity
      FROM purchase_request_lines
      WHERE tenant_id = ? AND request_id = ? AND active = 1
      LIMIT 1
    `).bind(tenantId, approvedRequestId).first<{
      purchase_demand_id: string;
      requested_quantity: number;
    }>();
    if (!sourceLine) throw new Error('purchase request source line missing');
    let sourceRaced = false;
    const sourceRacingDb = {
      prepare: db.prepare.bind(db),
      batch: async (statements: D1PreparedStatement[]) => {
        if (!sourceRaced) {
          sourceRaced = true;
          await db.prepare(`
            UPDATE purchase_demands SET required_quantity = ?
            WHERE tenant_id = ? AND id = ?
          `).bind(
            Number(sourceLine.requested_quantity) - 1,
            tenantId,
            sourceLine.purchase_demand_id,
          ).run();
        }
        return db.batch(statements);
      },
    } as unknown as D1Database;
    await expect(executePurchaseOrderAction(sourceRacingDb, buyerUser, sourceRace.purchaseOrder.id, {
      action: 'issue',
    }, 'po-issue-guard-issue-source-race')).rejects.toMatchObject({
      code: 'PURCHASE_REQUEST_CHANGED',
    });
    const sourceGuarded = await db.prepare(`
      SELECT status FROM purchase_orders WHERE tenant_id = ? AND id = ?
    `).bind(tenantId, sourceRace.purchaseOrder.id).first<{ status: string }>();
    expect(sourceGuarded?.status).toBe('draft');
    await db.prepare(`
      UPDATE purchase_demands SET required_quantity = ?
      WHERE tenant_id = ? AND id = ?
    `).bind(sourceLine.requested_quantity, tenantId, sourceLine.purchase_demand_id).run();
    await cancelDraft(sourceRace.purchaseOrder.id, 'po-issue-guard-cancel-source-race');

    const complete = await createPurchaseOrder(db, buyerUser, {
      purchaseRequestId: approvedRequestId,
      supplierId: supplier.supplier.id,
      ...(await readyPurchaseOrderFields(db, approvedRequestId)),
    }, 'po-issue-guard-create-complete');
    const issued = await executePurchaseOrderAction(db, buyerUser, complete.purchaseOrder.id, {
      action: 'issue', note: '字段完整，确认下单',
    }, 'po-issue-guard-issue-complete');
    expect(issued.purchaseOrder).toEqual(expect.objectContaining({
      status: 'issued',
      deliveryWarehouse: expect.objectContaining({ id: 'warehouse-main' }),
      expectedDeliveryAt: '2026-11-30',
      currency: 'USD',
    }));
    expect(issued.purchaseOrder.lines[0]).toEqual(expect.objectContaining({
      unitCostMinor: 100,
      currency: 'USD',
    }));
  });

  it('采购单保存供应商与收货信息快照，并拒绝引用其他租户仓库', async () => {
    const supplier = await createSupplier(db, user, {
      code: 'SUP-DELIVERY',
      name: '交付测试供应商',
      contactName: '陈供应商',
      contactPhone: '13800000000',
      contactEmail: 'supplier@example.invalid',
      address: '佛山市供应商路 8 号',
    }, 'supplier-delivery-fields-0001');
    const warehouse = await createWarehouse(db, user, {
      code: 'RECEIVE',
      name: '采购收货仓',
      contactName: '林收货员',
      contactPhone: '0755-12345678',
      address: '深圳市收货路 18 号 A 栋',
    }, 'warehouse-delivery-fields-0001');

    expect(supplier.supplier).toEqual(expect.objectContaining({
      contactName: '陈供应商',
      contactPhone: '13800000000',
      contactEmail: 'supplier@example.invalid',
      address: '佛山市供应商路 8 号',
    }));
    expect(warehouse.warehouse).toEqual(expect.objectContaining({
      contactName: '林收货员',
      contactPhone: '0755-12345678',
      address: '深圳市收货路 18 号 A 栋',
    }));

    await expect(createPurchaseOrder(db, buyerUser, {
      purchaseRequestId: approvedRequestId,
      supplierId: supplier.supplier.id,
      deliveryWarehouseId: 'warehouse-other-tenant',
    }, 'purchase-order-cross-tenant-warehouse-0001')).rejects.toMatchObject({
      status: 404,
      code: 'PURCHASE_DELIVERY_WAREHOUSE_NOT_FOUND',
    });

    const created = await createPurchaseOrder(db, buyerUser, {
      purchaseRequestId: approvedRequestId,
      supplierId: supplier.supplier.id,
      deliveryWarehouseId: warehouse.warehouse.id,
      expectedDeliveryAt: '2026-11-15',
      paymentTerms: '月结 30 天',
      tradeTerms: 'FOB 深圳',
    }, 'purchase-order-delivery-fields-0001');
    expect(created.purchaseOrder).toEqual(expect.objectContaining({
      expectedDeliveryAt: '2026-11-15',
      paymentTerms: '月结 30 天',
      tradeTerms: 'FOB 深圳',
      supplier: expect.objectContaining({
        name: '交付测试供应商',
        contactName: '陈供应商',
        address: '佛山市供应商路 8 号',
      }),
      deliveryWarehouse: expect.objectContaining({
        id: warehouse.warehouse.id,
        code: 'RECEIVE',
        contactName: '林收货员',
        address: '深圳市收货路 18 号 A 栋',
      }),
    }));

    await db.batch([
      db.prepare(`
        UPDATE suppliers
        SET name = '供应商新名称', contact_name = '新联系人', address = '供应商新地址'
        WHERE tenant_id = ? AND id = ?
      `).bind(tenantId, supplier.supplier.id),
      db.prepare(`
        UPDATE warehouses
        SET name = '仓库新名称', contact_name = '新收货员', address = '仓库新地址'
        WHERE tenant_id = ? AND id = ?
      `).bind(tenantId, warehouse.warehouse.id),
    ]);
    const document = await loadPurchaseOrderDocument(db, user, created.purchaseOrder.id);
    expect(document.supplier).toEqual(expect.objectContaining({
      name: '交付测试供应商',
      contactName: '陈供应商',
      address: '佛山市供应商路 8 号',
    }));
    expect(document.deliveryWarehouse).toEqual(expect.objectContaining({
      name: '采购收货仓',
      contactName: '林收货员',
      address: '深圳市收货路 18 号 A 栋',
    }));

    await db.prepare(`
      UPDATE purchase_orders
      SET supplier_code_snapshot = NULL,
        supplier_name_snapshot = NULL,
        supplier_contact_name_snapshot = NULL,
        supplier_contact_phone_snapshot = NULL,
        supplier_contact_email_snapshot = NULL,
        supplier_address_snapshot = NULL,
        delivery_warehouse_id = NULL,
        delivery_warehouse_code_snapshot = NULL,
        delivery_warehouse_name_snapshot = NULL,
        delivery_contact_name_snapshot = NULL,
        delivery_contact_phone_snapshot = NULL,
        delivery_address_snapshot = NULL
      WHERE tenant_id = ? AND id = ?
    `).bind(tenantId, created.purchaseOrder.id).run();
    const legacyCompatible = await loadPurchaseOrderDocument(db, user, created.purchaseOrder.id);
    expect(legacyCompatible.supplier).toEqual(expect.objectContaining({
      name: '供应商新名称',
      contactName: '新联系人',
      address: '供应商新地址',
    }));
    expect(legacyCompatible.deliveryWarehouse).toBeNull();
  });

  it('复审管理员可为员工生成和确认采购单，取消仍由采购负责人办理', async () => {
    const supplier = await createSupplier(db, user, {
      code: 'SUP-OWNER', name: '负责人权限测试供应商',
    }, 'supplier-create-owner-0001');

    await expect(createPurchaseOrder(db, otherOperator, {
      purchaseRequestId: approvedRequestId,
      supplierId: supplier.supplier.id,
    }, 'purchase-order-owner-denied-0001')).rejects.toMatchObject({
      status: 403,
      code: 'PURCHASE_ORDER_PURCHASER_REQUIRED',
    });

    const created = await createPurchaseOrder(db, reviewerUser, {
      purchaseRequestId: approvedRequestId,
      supplierId: supplier.supplier.id,
      ...(await readyPurchaseOrderFields(db, approvedRequestId)),
    }, 'purchase-order-owner-create-0001');
    await expect(executePurchaseOrderAction(db, otherOperator, created.purchaseOrder.id, {
      action: 'issue',
    }, 'purchase-order-owner-operator-denied-0001')).rejects.toMatchObject({
      status: 403,
      code: 'PURCHASE_ORDER_PURCHASER_REQUIRED',
    });
    await expect(executePurchaseOrderAction(db, reviewerUser, created.purchaseOrder.id, {
      action: 'cancel',
    }, 'purchase-order-owner-reviewer-denied-0001')).rejects.toMatchObject({
      status: 403,
      code: 'PURCHASE_ORDER_PURCHASER_REQUIRED',
    });
    const issued = await executePurchaseOrderAction(db, reviewerUser, created.purchaseOrder.id, {
      action: 'issue',
    }, 'purchase-order-owner-issue-0001');
    expect(issued.purchaseOrder).toMatchObject({ status: 'issued', purchaserMemberId: 'member-buyer' });
    for (const action of ['CREATE_PURCHASE_ORDER', 'ISSUE_PURCHASE_ORDER']) {
      expect(await db.prepare('SELECT actor_id FROM audit_logs WHERE tenant_id = ? AND entity_id = ? AND action = ?')
        .bind(tenantId, issued.purchaseOrder.id, action).first('actor_id')).toBe(reviewerUser.id);
    }
  });

  it('开发开放模式允许普通操作员接续转单、下单和关闭，正式模式仍按采购分工', async () => {
    const supplier = await createSupplier(db, user, {
      code: 'SUP-ACCOUNT-HANDOFF', name: '换账号交接测试供应商',
    }, 'supplier-account-handoff-0001');
    const input = {
      purchaseRequestId: approvedRequestId,
      supplierId: supplier.supplier.id,
      ...(await readyPurchaseOrderFields(db, approvedRequestId)),
    };

    await expect(createPurchaseOrder(
      db,
      otherOperator,
      input,
      'purchase-order-account-handoff-formal-create',
    )).rejects.toMatchObject({ code: 'PURCHASE_ORDER_PURCHASER_REQUIRED' });

    const created = await createPurchaseOrder(
      db,
      otherOperator,
      input,
      'purchase-order-account-handoff-open-create',
      { developmentOpenAccess: true },
    );
    await expect(executePurchaseOrderActionService(
      db,
      otherOperator,
      created.purchaseOrder.id,
      { action: 'issue' },
      'purchase-order-account-handoff-formal-issue',
      { validatePlanningEvidence: async () => undefined },
    )).rejects.toMatchObject({ code: 'PURCHASE_ORDER_PURCHASER_REQUIRED' });

    const issued = await executePurchaseOrderActionService(
      db,
      otherOperator,
      created.purchaseOrder.id,
      { action: 'issue', note: '换账号继续确认下单' },
      'purchase-order-account-handoff-open-issue',
      {
        developmentOpenAccess: true,
        validatePlanningEvidence: async () => undefined,
      },
    );
    expect(issued.purchaseOrder.status).toBe('issued');

    await expect(executePurchaseOrderActionService(
      db,
      otherOperator,
      created.purchaseOrder.id,
      { action: 'close', note: '供应商无法继续交货' },
      'purchase-order-account-handoff-formal-close',
      { validatePlanningEvidence: async () => undefined },
    )).rejects.toMatchObject({ code: 'PURCHASE_ORDER_PURCHASER_REQUIRED' });

    const closed = await executePurchaseOrderActionService(
      db,
      otherOperator,
      created.purchaseOrder.id,
      { action: 'close', note: '供应商无法继续交货' },
      'purchase-order-account-handoff-open-close',
      {
        developmentOpenAccess: true,
        validatePlanningEvidence: async () => undefined,
      },
    );
    expect(closed.purchaseOrder.status).toBe('closed_short');

    const audit = await db.prepare(`
      SELECT action, actor_email FROM audit_logs
      WHERE tenant_id = ? AND entity_id = ?
        AND action IN ('CREATE_PURCHASE_ORDER', 'ISSUE_PURCHASE_ORDER', 'CLOSE_PURCHASE_ORDER_REMAINDER')
    `).bind(tenantId, created.purchaseOrder.id).all<{ action: string; actor_email: string }>();
    expect(audit.results).toHaveLength(3);
    expect(audit.results.every((row) => row.actor_email === otherOperator.email)).toBe(true);
  });

  it('采购单文档允许只读角色按当前租户读取，并拒绝跨租户标识', async () => {
    const supplier = await createSupplier(db, user, {
      code: 'SUP-DOC', name: '采购单文档供应商',
    }, 'supplier-create-document-0001');
    const created = await createPurchaseOrder(db, buyerUser, {
      purchaseRequestId: approvedRequestId,
      supplierId: supplier.supplier.id,
      currency: 'CNY',
      lineCosts: [{
        purchaseRequestLineId: await requestLineId(db, approvedRequestId),
        unitCostMinor: 1250,
      }],
    }, 'purchase-order-create-document-0001');
    const viewer: UserContext = {
      ...user,
      id: 'auth-document-viewer',
      email: 'document-viewer@example.invalid',
      role: 'viewer',
      permissions: ROLE_PERMISSIONS.viewer,
    };

    const document = await loadPurchaseOrderDocument(db, viewer, created.purchaseOrder.id);
    expect(document).toEqual(expect.objectContaining({
      id: created.purchaseOrder.id,
      costComplete: true,
      totalAmountMinor: 6250,
    }));

    const otherTenantViewer: UserContext = {
      ...viewer,
      tenantId: 'tenant-other',
      tenantName: '其他租户',
    };
    await expect(loadPurchaseOrderDocument(
      db,
      otherTenantViewer,
      created.purchaseOrder.id,
    )).rejects.toMatchObject({ code: 'PURCHASE_ORDER_NOT_FOUND' });
  });

  it('收货时间无效或明显在未来时拒绝，历史补录会规范为 UTC', async () => {
    const supplier = await createSupplier(db, user, {
      code: 'SUP-RECEIPT-TIME', name: '收货时间测试供应商',
    }, 'supplier-receipt-time-0001');
    const created = await createPurchaseOrder(db, buyerUser, {
      purchaseRequestId: approvedRequestId,
      supplierId: supplier.supplier.id,
      ...(await readyPurchaseOrderFields(db, approvedRequestId)),
    }, 'purchase-order-receipt-time-0001');
    const issued = await executePurchaseOrderAction(db, buyerUser, created.purchaseOrder.id, {
      action: 'issue', note: '收货时间校验测试',
    }, 'purchase-order-receipt-time-issue-0001');
    const lineId = issued.purchaseOrder.lines[0].id;
    const clock = new Date('2026-11-02T10:00:00.000Z');

    await expect(createPurchaseReceipt(db, user, created.purchaseOrder.id, {
      warehouseId: 'warehouse-main',
      receivedAt: 'not-a-date',
      lines: [{ purchaseOrderLineId: lineId, quantity: 1 }],
    }, 'purchase-receipt-invalid-time-0001', { now: clock })).rejects.toMatchObject({
      status: 400,
      code: 'PURCHASE_RECEIPT_TIME_INVALID',
    });

    await expect(createPurchaseReceipt(db, user, created.purchaseOrder.id, {
      warehouseId: 'warehouse-main',
      receivedAt: '2026-11-02T10:05:01.000Z',
      lines: [{ purchaseOrderLineId: lineId, quantity: 1 }],
    }, 'purchase-receipt-future-time-0001', { now: clock })).rejects.toMatchObject({
      status: 400,
      code: 'PURCHASE_RECEIPT_TIME_IN_FUTURE',
    });

    const historical = await createPurchaseReceipt(db, user, created.purchaseOrder.id, {
      warehouseId: 'warehouse-main',
      receivedAt: '2026-10-01T08:30:00+08:00',
      note: '按真实送货单补录',
      lines: [{ purchaseOrderLineId: lineId, quantity: 1 }],
    }, 'purchase-receipt-historical-time-0001', { now: clock });
    expect(historical.receipt.receivedAt).toBe('2026-10-01T00:30:00.000Z');
    expect(historical.receipt.createdAt).toBe(clock.toISOString());
  });

  it('确认下单后支持分批收货，幂等重放不重复增加库存', async () => {
    const supplier = await createSupplier(db, user, {
      code: 'SUP-02', name: '分批到货供应商',
    }, 'supplier-create-1001');
    const created = await createPurchaseOrder(db, buyerUser, {
      purchaseRequestId: approvedRequestId,
      supplierId: supplier.supplier.id,
      ...(await readyPurchaseOrderFields(db, approvedRequestId)),
    }, 'purchase-order-create-1001');
    const issued = await executePurchaseOrderAction(db, buyerUser, created.purchaseOrder.id, {
      action: 'issue', note: '确认发给供应商',
    }, 'purchase-order-issue-1001');
    expect(issued.purchaseOrder.status).toBe('issued');
    const lineId = issued.purchaseOrder.lines[0].id;

    const alternateWarehouse = await createWarehouse(db, user, {
      code: 'ALT-RECEIVE', name: '其它同租户仓',
    }, 'warehouse-alternate-receive-0001');
    await expect(createPurchaseReceipt(db, user, created.purchaseOrder.id, {
      warehouseId: alternateWarehouse.warehouse.id,
      lines: [{ purchaseOrderLineId: lineId, quantity: 1 }],
    }, 'purchase-receipt-wrong-warehouse-0001')).rejects.toMatchObject({
      code: 'PURCHASE_RECEIPT_WAREHOUSE_MISMATCH',
    });

    let receiptWarehouseRaced = false;
    const receiptRacingDb = {
      prepare: db.prepare.bind(db),
      batch: async (statements: D1PreparedStatement[]) => {
        if (!receiptWarehouseRaced) {
          receiptWarehouseRaced = true;
          await db.prepare(`
            UPDATE purchase_orders SET delivery_warehouse_id = ?
            WHERE tenant_id = ? AND id = ?
          `).bind(alternateWarehouse.warehouse.id, tenantId, created.purchaseOrder.id).run();
        }
        return db.batch(statements);
      },
    } as unknown as D1Database;
    await expect(createPurchaseReceipt(receiptRacingDb, user, created.purchaseOrder.id, {
      warehouseId: 'warehouse-main',
      lines: [{ purchaseOrderLineId: lineId, quantity: 1 }],
    }, 'purchase-receipt-warehouse-race-0001')).rejects.toMatchObject({
      code: 'PURCHASE_RECEIPT_WAREHOUSE_MISMATCH',
    });
    expect(await inventoryOnHand(db)).toBe(0);
    const receiptCountBeforeValid = await db.prepare(`
      SELECT COUNT(*) AS count FROM purchase_receipts WHERE tenant_id = ?
    `).bind(tenantId).first<{ count: number }>();
    expect(Number(receiptCountBeforeValid?.count)).toBe(0);
    await db.prepare(`
      UPDATE purchase_orders SET delivery_warehouse_id = 'warehouse-main'
      WHERE tenant_id = ? AND id = ?
    `).bind(tenantId, created.purchaseOrder.id).run();

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

  it('旧已下单采购单缺少指定收货仓时拒绝猜仓入库', async () => {
    const supplier = await createSupplier(db, user, {
      code: 'SUP-LEGACY-RECEIPT', name: '旧单收货保护供应商',
    }, 'supplier-legacy-receipt-0001');
    const created = await createPurchaseOrder(db, buyerUser, {
      purchaseRequestId: approvedRequestId,
      supplierId: supplier.supplier.id,
      ...(await readyPurchaseOrderFields(db, approvedRequestId)),
    }, 'purchase-order-legacy-receipt-0001');
    const issued = await executePurchaseOrderAction(db, buyerUser, created.purchaseOrder.id, {
      action: 'issue',
    }, 'purchase-order-legacy-receipt-issue-0001');
    await db.prepare(`
      UPDATE purchase_orders SET delivery_warehouse_id = NULL
      WHERE tenant_id = ? AND id = ?
    `).bind(tenantId, created.purchaseOrder.id).run();

    await expect(createPurchaseReceipt(db, user, created.purchaseOrder.id, {
      warehouseId: 'warehouse-main',
      lines: [{ purchaseOrderLineId: issued.purchaseOrder.lines[0].id, quantity: 1 }],
    }, 'purchase-receipt-legacy-no-warehouse-0001')).rejects.toMatchObject({
      code: 'PURCHASE_RECEIPT_DELIVERY_WAREHOUSE_REQUIRED',
    });
    const count = await db.prepare(`
      SELECT COUNT(*) AS count FROM purchase_receipts WHERE tenant_id = ?
    `).bind(tenantId).first<{ count: number }>();
    expect(Number(count?.count)).toBe(0);
    expect(await inventoryOnHand(db)).toBe(0);
  });

  it('指定采购负责人可追加式关闭未到余量，原因、数量和历史均保留', async () => {
    const supplier = await createSupplier(db, user, {
      code: 'SUP-CLOSE-SHORT', name: '短到关闭测试供应商',
    }, 'supplier-close-short-0001');
    const created = await createPurchaseOrder(db, buyerUser, {
      purchaseRequestId: approvedRequestId,
      supplierId: supplier.supplier.id,
      ...(await readyPurchaseOrderFields(db, approvedRequestId)),
    }, 'purchase-order-close-short-0001');
    const issued = await executePurchaseOrderAction(db, buyerUser, created.purchaseOrder.id, {
      action: 'issue', note: '已向供应商下单',
    }, 'purchase-order-close-short-issue-0001');

    await expect(executePurchaseOrderAction(db, buyerUser, created.purchaseOrder.id, {
      action: 'close', note: '   ',
    }, 'purchase-order-close-short-empty-0001')).rejects.toMatchObject({
      code: 'PURCHASE_ORDER_CLOSE_REASON_REQUIRED',
    });
    await expect(executePurchaseOrderAction(db, user, created.purchaseOrder.id, {
      action: 'close', note: '供应商缺货',
    }, 'purchase-order-close-short-owner-0001')).rejects.toMatchObject({
      code: 'PURCHASE_ORDER_PURCHASER_REQUIRED',
    });
    await expect(db.prepare(`
      UPDATE purchase_orders
      SET status = 'closed_short', closed_at = ?, action_note = NULL, updated_at = ?
      WHERE tenant_id = ? AND id = ?
    `).bind(
      '2026-11-02T11:00:00.000Z',
      '2026-11-02T11:00:00.000Z',
      tenantId,
      created.purchaseOrder.id,
    ).run()).rejects.toThrow(/PURCHASE_ORDER_CLOSE_REASON_REQUIRED/);

    const closed = await executePurchaseOrderAction(db, buyerUser, created.purchaseOrder.id, {
      action: 'close', note: '供应商确认余下 5 件无法交付',
    }, 'purchase-order-close-short-action-0001');
    expect(closed.replayed).toBe(false);
    expect(closed.purchaseOrder).toEqual(expect.objectContaining({
      status: 'closed_short',
      orderedQuantity: 5,
      receivedQuantity: 0,
      actionNote: '供应商确认余下 5 件无法交付',
    }));
    expect(closed.purchaseOrder.closedAt).toEqual(expect.any(String));

    const replay = await executePurchaseOrderAction(db, buyerUser, created.purchaseOrder.id, {
      action: 'close', note: '供应商确认余下 5 件无法交付',
    }, 'purchase-order-close-short-action-0001');
    expect(replay.replayed).toBe(true);
    expect(replay.purchaseOrder.status).toBe('closed_short');
    await expect(createPurchaseReceipt(db, user, created.purchaseOrder.id, {
      warehouseId: 'warehouse-main',
      lines: [{ purchaseOrderLineId: issued.purchaseOrder.lines[0].id, quantity: 1 }],
    }, 'purchase-receipt-after-close-short-0001')).rejects.toMatchObject({
      code: 'PURCHASE_ORDER_NOT_RECEIVABLE',
    });

    const facts = await db.prepare(`
      SELECT
        (SELECT active FROM purchase_request_lines
          WHERE tenant_id = ? AND request_id = ? LIMIT 1) AS request_line_active,
        (SELECT COUNT(*) FROM audit_logs
          WHERE tenant_id = ? AND entity_id = ? AND action = 'CLOSE_PURCHASE_ORDER_REMAINDER') AS close_audits
    `).bind(
      tenantId,
      approvedRequestId,
      tenantId,
      created.purchaseOrder.id,
    ).first<{ request_line_active: number; close_audits: number }>();
    expect(Number(facts?.request_line_active)).toBe(0);
    expect(Number(facts?.close_audits)).toBe(1);

    const workspace = await getProcurementWorkspaceData(db, user);
    expect(workspace.procurementSummary).toEqual(expect.objectContaining({
      closedShortOrders: 1,
      pendingReceiptQuantity: 0,
    }));
  });

  it('部分到货后关闭只释放未满足需求，后续冲正不重新打开采购单', async () => {
    const supplier = await createSupplier(db, user, {
      code: 'SUP-CLOSE-CORRECT', name: '短到冲正测试供应商',
    }, 'supplier-close-correct-0001');
    const created = await createPurchaseOrder(db, buyerUser, {
      purchaseRequestId: approvedRequestId,
      supplierId: supplier.supplier.id,
      ...(await readyPurchaseOrderFields(db, approvedRequestId)),
    }, 'purchase-order-close-correct-0001');
    const issued = await executePurchaseOrderAction(db, buyerUser, created.purchaseOrder.id, {
      action: 'issue',
    }, 'purchase-order-close-correct-issue-0001');
    const receipt = await createPurchaseReceipt(db, user, created.purchaseOrder.id, {
      warehouseId: 'warehouse-main',
      lines: [{ purchaseOrderLineId: issued.purchaseOrder.lines[0].id, quantity: 2 }],
    }, 'purchase-order-close-correct-receipt-0001');
    expect(receipt.purchaseOrder.status).toBe('partially_received');

    const closed = await executePurchaseOrderAction(db, buyerUser, created.purchaseOrder.id, {
      action: 'close', note: '尾批取消，只保留实际到货',
    }, 'purchase-order-close-correct-action-0001');
    expect(closed.purchaseOrder).toEqual(expect.objectContaining({
      status: 'closed_short', orderedQuantity: 5, receivedQuantity: 2,
    }));
    const closedWorkspace = await getPurchaseWorkspace(db, user);
    expect(closedWorkspace.demands[0]).toEqual(expect.objectContaining({
      allocatedQuantity: 2,
      availableQuantity: 3,
    }));

    const corrected = await createPurchaseReceiptCorrection(db, user, receipt.receipt.id, {
      reason: '已到货中有 1 件错录',
      lines: [{ purchaseReceiptLineId: receipt.receipt.lines[0].id, quantity: 1 }],
    }, 'purchase-order-close-correct-correction-0001');
    expect(corrected.purchaseOrder).toEqual(expect.objectContaining({
      status: 'closed_short', orderedQuantity: 5, receivedQuantity: 1,
    }));
    expect(await inventoryOnHand(db)).toBe(1);
    const line = await db.prepare(`
      SELECT active FROM purchase_request_lines
      WHERE tenant_id = ? AND request_id = ? LIMIT 1
    `).bind(tenantId, approvedRequestId).first<{ active: number }>();
    expect(Number(line?.active)).toBe(0);

    const correctedWorkspace = await getPurchaseWorkspace(db, user);
    const demand = correctedWorkspace.demands[0]!;
    expect(demand).toEqual(expect.objectContaining({
      allocatedQuantity: 1,
      availableQuantity: 4,
    }));
    const replacement = await createPurchaseRequest(db, user, {
      demandIds: [demand.id],
      purchaserMemberId: 'member-buyer',
      reviewerMemberId: 'member-reviewer',
      note: '只重新申请净未满足数量',
    }, 'purchase-order-close-correct-replacement-0001');
    expect(replacement.request.totalQuantity).toBe(4);
  });

  it('收货错录通过追加冲正恢复库存和采购单状态，原收货记录保持不变', async () => {
    const supplier = await createSupplier(db, user, {
      code: 'SUP-CORRECTION', name: '冲正测试供应商',
    }, 'supplier-create-correction-0001');
    const created = await createPurchaseOrder(db, buyerUser, {
      purchaseRequestId: approvedRequestId,
      supplierId: supplier.supplier.id,
      ...(await readyPurchaseOrderFields(db, approvedRequestId, 'CNY')),
    }, 'purchase-order-create-correction-0001');
    const issued = await executePurchaseOrderAction(db, buyerUser, created.purchaseOrder.id, {
      action: 'issue', note: '测试收货冲正',
    }, 'purchase-order-issue-correction-0001');
    const orderLineId = issued.purchaseOrder.lines[0].id;
    const posted = await createPurchaseReceipt(db, user, created.purchaseOrder.id, {
      warehouseId: 'warehouse-main',
      note: '误将 5 件全部登记到货',
      lines: [{ purchaseOrderLineId: orderLineId, quantity: 5 }],
    }, 'purchase-receipt-correction-source-0001');
    const receiptLineId = posted.receipt.lines[0].id;
    expect(posted.purchaseOrder.status).toBe('received');
    expect(await inventoryOnHand(db)).toBe(5);

    const partial = await createPurchaseReceiptCorrection(db, user, posted.receipt.id, {
      reason: '实际只到货 3 件，冲正多录的 2 件',
      lines: [{ purchaseReceiptLineId: receiptLineId, quantity: 2 }],
    }, 'purchase-receipt-correction-0001');
    expect(partial.replayed).toBe(false);
    expect(partial.correction).toEqual(expect.objectContaining({
      purchaseReceiptId: posted.receipt.id,
      purchaseOrderId: created.purchaseOrder.id,
      totalQuantity: 2,
      status: 'posted',
    }));
    expect(partial.purchaseOrder).toEqual(expect.objectContaining({
      status: 'partially_received', receivedQuantity: 3,
    }));
    expect(partial.purchaseReceipt).toEqual(expect.objectContaining({
      id: posted.receipt.id, status: 'posted', totalQuantity: 5,
    }));
    expect(partial.purchaseReceipt.lines[0].quantity).toBe(5);
    expect(await inventoryOnHand(db)).toBe(3);
    const partialWorkspace = await getProcurementWorkspaceData(db, user);
    expect(partialWorkspace.purchaseReceipts[0]).toEqual(expect.objectContaining({
      totalQuantity: 5,
      originalQuantity: 5,
      correctedQuantity: 2,
      netQuantity: 3,
      correctionCount: 1,
    }));
    expect(partialWorkspace.procurementSummary).toEqual(expect.objectContaining({
      receivedQuantity: 3,
      correctedQuantity: 2,
      correctionCount: 1,
    }));

    const replay = await createPurchaseReceiptCorrection(db, user, posted.receipt.id, {
      reason: '实际只到货 3 件，冲正多录的 2 件',
      lines: [{ purchaseReceiptLineId: receiptLineId, quantity: 2 }],
    }, 'purchase-receipt-correction-0001');
    expect(replay.replayed).toBe(true);
    expect(replay.correction.id).toBe(partial.correction.id);
    expect(await inventoryOnHand(db)).toBe(3);

    const final = await createPurchaseReceiptCorrection(db, user, posted.receipt.id, {
      reason: '复核发现本批实际未到货，冲正剩余 3 件',
      lines: [{ purchaseReceiptLineId: receiptLineId, quantity: 3 }],
    }, 'purchase-receipt-correction-0002');
    expect(final.purchaseOrder).toEqual(expect.objectContaining({
      status: 'issued', receivedQuantity: 0,
    }));
    expect(await inventoryOnHand(db)).toBe(0);
    const fullyCorrectedWorkspace = await getProcurementWorkspaceData(db, user);
    expect(fullyCorrectedWorkspace.purchaseReceipts[0]).toEqual(expect.objectContaining({
      originalQuantity: 5,
      correctedQuantity: 5,
      netQuantity: 0,
      correctionCount: 2,
    }));
    expect(fullyCorrectedWorkspace.procurementSummary).toEqual(expect.objectContaining({
      receivedQuantity: 0,
      correctedQuantity: 5,
      correctionCount: 2,
    }));

    const corrections = await listPurchaseReceiptCorrections(db, user, posted.receipt.id);
    expect(corrections).toHaveLength(2);
    expect(corrections.reduce((sum, correction) => sum + correction.totalQuantity, 0)).toBe(5);
    const facts = await db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM purchase_receipts WHERE tenant_id = ?) AS receipts,
        (SELECT COUNT(*) FROM purchase_receipt_lines WHERE tenant_id = ?) AS receipt_lines,
        (SELECT COUNT(*) FROM purchase_receipt_corrections WHERE tenant_id = ?) AS corrections,
        (SELECT SUM(on_hand_delta) FROM inventory_receipt_correction_movements WHERE tenant_id = ?) AS correction_delta,
        (SELECT COUNT(*) FROM audit_logs WHERE tenant_id = ? AND action = 'CORRECT_PURCHASE_RECEIPT') AS audits
    `).bind(tenantId, tenantId, tenantId, tenantId, tenantId).first<{
      receipts: number; receipt_lines: number; corrections: number; correction_delta: number; audits: number;
    }>();
    expect(facts).toEqual(expect.objectContaining({
      receipts: 1,
      receipt_lines: 1,
      corrections: 2,
      correction_delta: -5,
      audits: 2,
    }));

    const correctedReceipt = await createPurchaseReceipt(db, user, created.purchaseOrder.id, {
      warehouseId: 'warehouse-main',
      note: '重新登记真实到货',
      lines: [{ purchaseOrderLineId: orderLineId, quantity: 5 }],
    }, 'purchase-receipt-after-correction-0001');
    expect(correctedReceipt.purchaseOrder.status).toBe('received');
    expect(await inventoryOnHand(db)).toBe(5);
  });

  it('冲正不能超过原收货、不能扣减已占用库存，且受权限和租户隔离保护', async () => {
    const supplier = await createSupplier(db, user, {
      code: 'SUP-CORRECTION-GUARD', name: '冲正边界供应商',
    }, 'supplier-create-correction-guard-0001');
    const created = await createPurchaseOrder(db, buyerUser, {
      purchaseRequestId: approvedRequestId,
      supplierId: supplier.supplier.id,
      ...(await readyPurchaseOrderFields(db, approvedRequestId)),
    }, 'purchase-order-create-correction-guard-0001');
    const issued = await executePurchaseOrderAction(db, buyerUser, created.purchaseOrder.id, {
      action: 'issue',
    }, 'purchase-order-issue-correction-guard-0001');
    const posted = await createPurchaseReceipt(db, user, created.purchaseOrder.id, {
      warehouseId: 'warehouse-main',
      lines: [{ purchaseOrderLineId: issued.purchaseOrder.lines[0].id, quantity: 3 }],
    }, 'purchase-receipt-correction-guard-source-0001');
    const receiptLineId = posted.receipt.lines[0].id;

    await expect(createPurchaseReceiptCorrection(db, user, posted.receipt.id, {
      reason: '错误地尝试超量冲正',
      lines: [{ purchaseReceiptLineId: receiptLineId, quantity: 4 }],
    }, 'purchase-receipt-correction-guard-0001')).rejects.toMatchObject({
      code: 'PURCHASE_RECEIPT_CORRECTION_EXCEEDS_RECEIPT',
    });

    await db.prepare(`
      UPDATE inventory_balances SET reserved_qty = 2
      WHERE tenant_id = ? AND sku_id = 'sku-service-po' AND warehouse_id = 'warehouse-main'
    `).bind(tenantId).run();
    await expect(createPurchaseReceiptCorrection(db, user, posted.receipt.id, {
      reason: '库存已有占用时不能冲正到可用量为负',
      lines: [{ purchaseReceiptLineId: receiptLineId, quantity: 2 }],
    }, 'purchase-receipt-correction-guard-0002')).rejects.toMatchObject({
      code: 'PURCHASE_RECEIPT_CORRECTION_INVENTORY_UNAVAILABLE',
    });

    const viewer: UserContext = { ...user, role: 'viewer', permissions: ROLE_PERMISSIONS.viewer };
    await expect(createPurchaseReceiptCorrection(db, viewer, posted.receipt.id, {
      reason: '只读账号不能冲正',
      lines: [{ purchaseReceiptLineId: receiptLineId, quantity: 1 }],
    }, 'purchase-receipt-correction-guard-0003')).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });

    const otherTenantUser: UserContext = {
      ...user,
      id: 'auth-other-correction',
      email: 'other-correction@example.invalid',
      tenantId: 'tenant-other',
      tenantName: '其他租户',
    };
    await expect(createPurchaseReceiptCorrection(db, otherTenantUser, posted.receipt.id, {
      reason: '其他租户不能访问本租户收货单',
      lines: [{ purchaseReceiptLineId: receiptLineId, quantity: 1 }],
    }, 'purchase-receipt-correction-guard-0004')).rejects.toMatchObject({
      code: 'PURCHASE_RECEIPT_NOT_FOUND',
    });

    const count = await db.prepare(`
      SELECT COUNT(*) AS count FROM purchase_receipt_corrections WHERE tenant_id = ?
    `).bind(tenantId).first<{ count: number }>();
    expect(Number(count?.count)).toBe(0);
    expect(await inventoryOnHand(db)).toBe(3);
  });

  it('取消草稿保留历史并允许重新转单，且其他租户无法操作', async () => {
    const supplier = await createSupplier(db, user, {
      code: 'SUP-04', name: '取消与隔离测试供应商',
    }, 'supplier-create-3001');
    const first = await createPurchaseOrder(db, buyerUser, {
      purchaseRequestId: approvedRequestId,
      supplierId: supplier.supplier.id,
    }, 'purchase-order-create-3001');

    const cancelled = await executePurchaseOrderAction(db, buyerUser, first.purchaseOrder.id, {
      action: 'cancel', note: '供应商暂时无法交货',
    }, 'purchase-order-cancel-3001');
    expect(cancelled.purchaseOrder.status).toBe('cancelled');
    await expect(executePurchaseOrderAction(db, buyerUser, first.purchaseOrder.id, {
      action: 'issue',
    }, 'purchase-order-issue-3001')).rejects.toMatchObject({
      code: 'INVALID_PURCHASE_ORDER_TRANSITION',
    });

    const replacement = await createPurchaseOrder(db, buyerUser, {
      purchaseRequestId: approvedRequestId,
      supplierId: supplier.supplier.id,
      note: '原单取消后重新下单',
    }, 'purchase-order-create-3002');
    expect(replacement.purchaseOrder.status).toBe('draft');
    expect(replacement.purchaseOrder.id).not.toBe(first.purchaseOrder.id);

    const history = await db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM purchase_orders WHERE tenant_id = ?) AS orders,
        (SELECT COUNT(*) FROM purchase_order_lines WHERE tenant_id = ?) AS lines,
        (SELECT COUNT(*) FROM audit_logs
          WHERE tenant_id = ? AND action IN (
            'CREATE_SUPPLIER', 'CREATE_PURCHASE_ORDER', 'CANCEL_PURCHASE_ORDER'
          )) AS audits
    `).bind(tenantId, tenantId, tenantId).first<{ orders: number; lines: number; audits: number }>();
    expect(Number(history?.orders)).toBe(2);
    expect(Number(history?.lines)).toBe(2);
    expect(Number(history?.audits)).toBe(4);

    const otherTenantUser: UserContext = {
      ...user,
      id: 'auth-other',
      email: 'other@example.invalid',
      tenantId: 'tenant-other',
      tenantName: '其他租户',
    };
    const otherWorkspace = await getProcurementWorkspaceData(db, otherTenantUser);
    expect(otherWorkspace.suppliers).toHaveLength(0);
    expect(otherWorkspace.purchaseOrders).toHaveLength(0);
    expect(otherWorkspace.purchaseReceipts).toHaveLength(0);
    await expect(executePurchaseOrderAction(db, otherTenantUser, replacement.purchaseOrder.id, {
      action: 'issue',
    }, 'purchase-order-other-tenant-3001')).rejects.toMatchObject({
      code: 'PURCHASE_ORDER_NOT_FOUND',
    });
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
    await expect(createPurchaseOrder(db, buyerUser, {
      purchaseRequestId: approvedRequestId,
      supplierId: supplier.supplier.id,
    }, 'purchase-order-create-2001')).rejects.toMatchObject({ code: 'PURCHASE_REQUEST_NEEDS_ATTENTION' });

    await db.prepare(`
      UPDATE purchase_request_lines
      SET source_updated_at = '2026-11-02T12:00:00.000Z'
      WHERE tenant_id = ? AND request_id = ?
    `).bind(tenantId, approvedRequestId).run();
    const created = await createPurchaseOrder(db, buyerUser, {
      purchaseRequestId: approvedRequestId,
      supplierId: supplier.supplier.id,
      ...(await readyPurchaseOrderFields(db, approvedRequestId)),
    }, 'purchase-order-create-2002');
    await expect(createPurchaseReceipt(db, user, created.purchaseOrder.id, {
      warehouseId: 'warehouse-main',
      lines: [{ purchaseOrderLineId: created.purchaseOrder.lines[0].id, quantity: 1 }],
    }, 'purchase-receipt-create-2001')).rejects.toMatchObject({ code: 'PURCHASE_ORDER_NOT_RECEIVABLE' });

    await executePurchaseOrderAction(db, buyerUser, created.purchaseOrder.id, {
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
  await executePurchaseRequestAction(db, buyerUser, created.request.id, { action: 'submit' }, `request-submit-${crypto.randomUUID()}`);
  const approved = await executePurchaseRequestAction(db, reviewerUser, created.request.id, { action: 'approve' }, `request-approve-${crypto.randomUUID()}`);
  const evidenceLine = await db.prepare(`
    SELECT sku_id, requested_quantity
    FROM purchase_request_lines
    WHERE tenant_id = ? AND request_id = ? AND purchase_demand_id = ?
    LIMIT 1
  `).bind(tenantId, approved.request.id, demandId).first<{
    sku_id: string;
    requested_quantity: number;
  }>();
  if (!evidenceLine) throw new Error('purchase request evidence line missing');
  const now = new Date().toISOString();
  await db.prepare(`
    INSERT INTO audit_logs (
      id, tenant_id, actor_id, actor_email, action, entity_type, entity_id,
      before_json, after_json, request_id, idempotency_key, source, created_at
    ) VALUES (?, ?, ?, ?, 'CREATE_PURCHASE_REQUEST_FROM_PLAN', 'purchase_request', ?,
      NULL, ?, ?, ?, 'human', ?)
  `).bind(
    crypto.randomUUID(),
    tenantId,
    user.id,
    user.email,
    approved.request.id,
    JSON.stringify({
      planningEvidence: {
        schemaVersion: 1,
        rows: [{
          planRowId: `test-plan-${approved.request.id}`,
          skuId: evidenceLine.sku_id,
          recommendationVersion: `test-recommendation-${approved.request.id}`,
          allocations: [{ demandId, quantity: Number(evidenceLine.requested_quantity) }],
        }],
      },
    }),
    crypto.randomUUID(),
    `test-plan-evidence-${crypto.randomUUID()}`,
    now,
  ).run();
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
    db.prepare(`INSERT INTO members (id, tenant_id, auth_user_id, email, display_name, role, created_at)
      VALUES ('member-other-operator', ?, ?, ?, '另一采购员', 'operator', ?)`).bind(tenantId, otherOperator.id, otherOperator.email, now),
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

async function readyPurchaseOrderFields(
  db: D1Database,
  requestId: string,
  currency = 'USD',
) {
  return {
    deliveryWarehouseId: 'warehouse-main',
    expectedDeliveryAt: '2026-11-30',
    currency,
    lineCosts: [{
      purchaseRequestLineId: await requestLineId(db, requestId),
      unitCostMinor: 100,
    }],
  };
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
  const directory = new URL('../drizzle/', import.meta.url);
  for (const migration of readdirSync(directory).filter((name) => name.endsWith('.sql')).sort()) {
    const sql = readFileSync(new URL(migration, directory), 'utf8');
    const statements = sql.split('--> statement-breakpoint').map((item) => item.trim()).filter(Boolean);
    await db.batch(statements.map((statement) => db.prepare(statement)));
  }
}
