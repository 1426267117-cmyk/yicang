import { readdirSync, readFileSync } from 'node:fs';
import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { POST } from '../app/api/purchase/manual-requests/route';
import type { UserContext } from '../lib/db';
import * as databaseRuntime from '../lib/db';
import { ROLE_PERMISSIONS } from '../lib/domain';
import {
  createPurchaseOrder,
  createPurchaseReceipt,
  createSupplier,
  createWarehouse,
  executePurchaseOrderAction,
  getProcurementWorkspaceData,
  getPurchaseOrder,
  updatePurchaseOrderDraft,
} from '../lib/purchase-order-service';
import { createPurchaseSku, updatePurchaseSku } from '../lib/purchase-sku-service';
import {
  createManualPurchaseRequest,
  executePurchaseRequestAction,
  getPurchaseRequest,
  getPurchaseWorkspace,
} from '../lib/purchase-workflow-service';

vi.mock('cloudflare:workers', () => ({ env: {} }));

const tenantId = 'tenant-guangzhou';
const buyerMemberId = 'member-guangzhou-buyer';
const reviewerMemberId = 'member-guangzhou-reviewer';
const buyer: UserContext = {
  id: 'auth-guangzhou-buyer', email: 'buyer@example.invalid', displayName: '采购员', role: 'operator',
  permissions: ROLE_PERMISSIONS.operator, tenantId, tenantName: '广州采购',
};
const reviewer: UserContext = {
  ...buyer, id: 'auth-guangzhou-reviewer', email: 'reviewer@example.invalid', displayName: '复审员', role: 'admin',
  permissions: ROLE_PERMISSIONS.admin,
};
const outsider: UserContext = {
  ...buyer, id: 'auth-shenzhen-buyer', email: 'other-buyer@example.invalid',
  tenantId: 'tenant-shenzhen', tenantName: '深圳采购',
};
const assignments = { purchaserMemberId: buyerMemberId, reviewerMemberId };
const now = '2026-11-24T00:00:00.000Z';

describe('无外部数据的手工采购闭环', () => {
  let mf: Miniflare;
  let db: D1Database;

  beforeAll(async () => {
    mf = new Miniflare({ modules: true, script: 'export default { fetch(){ return new Response("ok") } }', d1Databases: ['DB'] });
    db = await mf.getD1Database('DB');
    const migrationDirectory = new URL('../drizzle/', import.meta.url);
    for (const filename of readdirSync(migrationDirectory).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort()) {
      const sql = readFileSync(new URL(filename, migrationDirectory), 'utf8');
      const statements = sql.split('--> statement-breakpoint').map((statement) => statement.trim()).filter(Boolean);
      await db.batch(statements.map((statement) => db.prepare(statement)));
    }
    await db.batch([
      db.prepare('INSERT INTO tenants (id, name, created_at) VALUES (?, ?, ?), (?, ?, ?)')
        .bind(buyer.tenantId, buyer.tenantName, now, outsider.tenantId, outsider.tenantName, now),
      db.prepare(`
        INSERT INTO members (id, tenant_id, auth_user_id, email, display_name, role, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?)
      `).bind(
        buyerMemberId, buyer.tenantId, buyer.id, buyer.email, buyer.displayName, buyer.role, now,
        reviewerMemberId, reviewer.tenantId, reviewer.id, reviewer.email, reviewer.displayName, reviewer.role, now,
      ),
    ]);
  });

  afterAll(async () => { await mf.dispose(); });

  async function approveManualForIssue(code: string) {
    const { sku } = await createPurchaseSku(db, buyer, { code, name: '直接下单验收商品' }, `${code}-sku`);
    const { request } = await createManualPurchaseRequest(db, buyer, {
      ...assignments, note: '已核对采购原因', lines: [{ skuId: sku.id, quantity: 2 }],
    }, `${code}-request`);
    await executePurchaseRequestAction(db, buyer, request.id, { action: 'submit' }, `${code}-submit`);
    await executePurchaseRequestAction(db, reviewer, request.id, { action: 'approve' }, `${code}-approve`);
    const { warehouse } = await createWarehouse(db, buyer, { code, name: '直接下单收货仓' }, `${code}-warehouse`);
    const { supplier } = await createSupplier(db, buyer, { code, name: '直接下单供应商' }, `${code}-supplier`);
    return { purchaseRequestId: request.id, supplierId: supplier.id, deliveryWarehouseId: warehouse.id,
      expectedDeliveryAt: '2026-12-05', currency: 'CNY', lineCosts: request.lines.map((line) => ({ purchaseRequestLineId: line.id, unitCostMinor: 1800 })) };
  }

  it('建档、赋权复审、出采购单并分批入库，保留手工来源和幂等记录', async () => {
    const { sku: chair } = await createPurchaseSku(db, buyer, { code: 'GZ-CHAIR', name: '办公椅' }, 'manual-sku-chair');
    const { sku: desk } = await createPurchaseSku(db, buyer, { code: 'GZ-DESK', name: '办公桌' }, 'manual-sku-desk');
    const { warehouse } = await createWarehouse(db, buyer, { code: 'GZ-MAIN', name: '广州收货仓' }, 'manual-warehouse');
    const { supplier } = await createSupplier(db, buyer, { code: 'SZ-SUP', name: '深圳供应商' }, 'manual-supplier');
    const input = {
      ...assignments,
      note: '深圳供应商报价单 Q001',
      lines: [{ skuId: chair.id, quantity: 5 }, { skuId: desk.id, quantity: 2 }],
    };
    const createKey = 'manual-request-create';
    const { request } = await createManualPurchaseRequest(db, buyer, input, createKey);
    expect(request).toMatchObject({
      status: 'draft', source: 'manual', note: input.note, lineCount: 2, totalQuantity: 7, needsAttention: false,
    });
    expect(request.lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ skuId: chair.id, requestedQuantity: 5, purchaseDemandId: null, sourceUpdatedAt: null }),
      expect.objectContaining({ skuId: desk.id, requestedQuantity: 2, purchaseDemandId: null, sourceRequiredQuantity: null }),
    ]));
    expect(await createManualPurchaseRequest(db, buyer, { ...input, lines: [...input.lines].reverse() }, createKey))
      .toMatchObject({ replayed: true, request: { id: request.id } });
    expect((await getPurchaseWorkspace(db, buyer)).requests)
      .toEqual(expect.arrayContaining([expect.objectContaining({
        id: request.id, source: 'manual', lineCount: 2, lines: expect.arrayContaining(request.lines),
      })]));
    await expect(createManualPurchaseRequest(db, buyer, { ...input, note: '已更换报价单' }, createKey))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(executePurchaseRequestAction(db, reviewer, request.id, { action: 'submit' }, 'manual-wrong-submitter'))
      .rejects.toMatchObject({ code: 'PURCHASE_PURCHASER_REQUIRED' });
    await expect(executePurchaseRequestAction(db, outsider, request.id, { action: 'submit' }, 'manual-wrong-tenant'))
      .rejects.toMatchObject({ code: 'PURCHASE_REQUEST_NOT_FOUND' });
    await expect(executePurchaseRequestAction(db, buyer, request.id, { action: 'submit' }, 'manual-request-submit'))
      .resolves.toMatchObject({ request: { status: 'pending_review' } });
    await expect(executePurchaseRequestAction(db, buyer, request.id, { action: 'approve' }, 'manual-wrong-reviewer'))
      .rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(executePurchaseRequestAction(db, reviewer, request.id, { action: 'approve' }, 'manual-request-review'))
      .resolves.toMatchObject({ request: { status: 'approved', source: 'manual' } });

    const { purchaseOrder } = await createPurchaseOrder(db, buyer, {
      purchaseRequestId: request.id,
      supplierId: supplier.id,
      deliveryWarehouseId: warehouse.id,
      expectedDeliveryAt: '2026-12-01',
      currency: 'CNY',
      lineCosts: request.lines.map((line) => ({ purchaseRequestLineId: line.id, unitCostMinor: 12_500 })),
    }, 'manual-po-create');
    expect(purchaseOrder).toMatchObject({ status: 'draft', orderedQuantity: 7, currency: 'CNY' });
    await expect(executePurchaseOrderAction(db, buyer, purchaseOrder.id, { action: 'issue' }, 'manual-po-issue'))
      .resolves.toMatchObject({ purchaseOrder: { status: 'issued' } });

    const chairLine = purchaseOrder.lines.find((line) => line.skuId === chair.id)!;
    const deskLine = purchaseOrder.lines.find((line) => line.skuId === desk.id)!;
    const firstReceiptInput = {
      warehouseId: warehouse.id,
      lines: [{ purchaseOrderLineId: chairLine.id, quantity: 2 }, { purchaseOrderLineId: deskLine.id, quantity: 1 }],
    };
    const first = await createPurchaseReceipt(db, buyer, purchaseOrder.id, firstReceiptInput, 'manual-receipt-first');
    expect(first).toMatchObject({ purchaseOrder: { status: 'partially_received', receivedQuantity: 3 }, receipt: { totalQuantity: 3 } });
    await expect(createPurchaseReceipt(db, buyer, purchaseOrder.id, firstReceiptInput, 'manual-receipt-first'))
      .resolves.toMatchObject({ replayed: true, receipt: { id: first.receipt.id } });
    await expect(createPurchaseReceipt(db, buyer, purchaseOrder.id, {
      warehouseId: warehouse.id, lines: [{ purchaseOrderLineId: chairLine.id, quantity: 3 }, { purchaseOrderLineId: deskLine.id, quantity: 1 }],
    }, 'manual-receipt-second')).resolves.toMatchObject({ purchaseOrder: { status: 'received', receivedQuantity: 7 } });

    const inventory = await db.prepare(`
      SELECT sku_id, on_hand_qty FROM inventory_balances WHERE tenant_id = ? AND warehouse_id = ?
    `).bind(tenantId, warehouse.id).all();
    expect(inventory.results).toHaveLength(2);
    expect(inventory.results).toEqual(expect.arrayContaining([
      { sku_id: chair.id, on_hand_qty: 5 }, { sku_id: desk.id, on_hand_qty: 2 },
    ]));
    const inbound = await db.prepare(`
      SELECT COUNT(*) AS count, SUM(on_hand_delta) AS quantity FROM inventory_inbound_movements
      WHERE tenant_id = ? AND purchase_order_id = ?
    `).bind(tenantId, purchaseOrder.id).first();
    expect(inbound).toEqual({ count: 4, quantity: 7 });

    const externalSources = await db.prepare(`
      SELECT (SELECT COUNT(*) FROM purchase_demands) AS demands,
        (SELECT COUNT(*) FROM platform_stores) AS stores,
        (SELECT COUNT(*) FROM muku_snapshots) AS snapshots
    `).first();
    expect(externalSources).toEqual({ demands: 0, stores: 0, snapshots: 0 });
    const audit = await db.prepare(`
      SELECT action, actor_email, after_json FROM audit_logs
      WHERE tenant_id = ? AND entity_type = 'purchase_request' AND entity_id = ?
    `).bind(tenantId, request.id).all<{ action: string; actor_email: string; after_json: string }>();
    expect(audit.results).toHaveLength(3);
    expect(audit.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'CREATE_MANUAL_PURCHASE_REQUEST', actor_email: buyer.email }),
      expect.objectContaining({ action: 'SUBMIT_PURCHASE_REQUEST', actor_email: buyer.email }),
      expect.objectContaining({ action: 'APPROVE_PURCHASE_REQUEST', actor_email: reviewer.email }),
    ]));
    expect(JSON.parse(audit.results.find((row) => row.action === 'CREATE_MANUAL_PURCHASE_REQUEST')!.after_json))
      .toMatchObject({ source: 'manual', note: input.note });
  });

  it('管理员复审后直接下单，重复提交只产生一张可收货采购单', async () => {
    const input = { ...await approveManualForIssue('GZ-QUICK-ISSUE'), issue: true };
    const idempotencyKey = 'GZ-QUICK-ISSUE-order';
    await expect(createPurchaseOrder(db, buyer, { ...input, lineCosts: [] }, idempotencyKey))
      .rejects.toMatchObject({ code: 'PURCHASE_ORDER_UNIT_COST_REQUIRED' });

    const replacementBuyerId = 'member-guangzhou-replacement-buyer';
    await db.prepare(`INSERT INTO members (id, tenant_id, auth_user_id, email, display_name, role, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(replacementBuyerId, tenantId, 'replacement-buyer', 'replacement@example.invalid', '新采购负责人', 'operator', now).run();
    await expect(createPurchaseOrder(db, { ...buyer, id: 'replacement-buyer' }, input, idempotencyKey))
      .rejects.toMatchObject({ code: 'PURCHASE_ORDER_PURCHASER_REQUIRED' });
    const reassignedDb = {
      prepare: db.prepare.bind(db),
      async batch(statements: D1PreparedStatement[]) {
        await db.prepare('UPDATE purchase_requests SET purchaser_member_id = ? WHERE id = ?')
          .bind(replacementBuyerId, input.purchaseRequestId).run();
        return db.batch(statements);
      },
    } as D1Database;
    await expect(createPurchaseOrder(reassignedDb, buyer, input, idempotencyKey))
      .rejects.toMatchObject({ code: 'PURCHASE_ORDER_ISSUE_CONFLICT' });
    await db.prepare('UPDATE purchase_requests SET purchaser_member_id = ? WHERE id = ?')
      .bind(buyerMemberId, input.purchaseRequestId).run();

    const demotedAdminDb = {
      prepare: db.prepare.bind(db),
      async batch(statements: D1PreparedStatement[]) {
        await db.prepare("UPDATE members SET role = 'operator' WHERE tenant_id = ? AND id = ?")
          .bind(tenantId, reviewerMemberId).run();
        return db.batch(statements);
      },
    } as D1Database;
    await expect(createPurchaseOrder(demotedAdminDb, reviewer, input, idempotencyKey))
      .rejects.toMatchObject({ code: 'PURCHASE_ORDER_ISSUE_CONFLICT' });
    expect(await db.prepare('SELECT COUNT(*) AS count FROM purchase_orders WHERE purchase_request_id = ?')
      .bind(input.purchaseRequestId).first('count')).toBe(0);
    expect(await db.prepare(`SELECT COUNT(*) AS count FROM audit_logs WHERE entity_type = 'purchase_order'
      AND json_extract(after_json, '$.purchaseRequestId') = ?`).bind(input.purchaseRequestId).first('count')).toBe(0);
    await db.prepare("UPDATE members SET role = 'admin' WHERE tenant_id = ? AND id = ?")
      .bind(tenantId, reviewerMemberId).run();

    const results = await Promise.all([
      createPurchaseOrder(db, reviewer, input, idempotencyKey), createPurchaseOrder(db, reviewer, input, idempotencyKey),
    ]);
    const { purchaseOrder } = results[0];
    expect(results.map((item) => item.replayed).sort()).toEqual([false, true]);
    expect(results.map((item) => item.purchaseOrder.id)).toEqual([purchaseOrder.id, purchaseOrder.id]);
    expect(purchaseOrder).toMatchObject({ status: 'issued', version: 2, orderedQuantity: 2, receivedQuantity: 0,
      purchaserMemberId: buyerMemberId });
    expect((await getProcurementWorkspaceData(db, buyer)).purchaseOrders).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: purchaseOrder.id, status: 'issued' }),
    ]));
    expect((await db.prepare('SELECT action, actor_id FROM audit_logs WHERE entity_id = ? ORDER BY action')
      .bind(purchaseOrder.id).all()).results).toEqual([{ action: 'CREATE_PURCHASE_ORDER', actor_id: reviewer.id },
      { action: 'ISSUE_PURCHASE_ORDER', actor_id: reviewer.id }]);
    await expect(createPurchaseOrder(db, buyer, { ...input, issue: false }, idempotencyKey))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(createPurchaseReceipt(db, buyer, purchaseOrder.id, {
      warehouseId: input.deliveryWarehouseId, lines: [{ purchaseOrderLineId: purchaseOrder.lines[0].id, quantity: 2 }],
    }, 'GZ-QUICK-ISSUE-receipt')).resolves.toMatchObject({ purchaseOrder: { status: 'received', receivedQuantity: 2 } });
  });

  it('编辑并确认下单事务失败时完整保留原草稿，修正后重试只生效一次', async () => {
    const input = await approveManualForIssue('GZ-QUICK-EDIT');
    const { purchaseOrder: draft } = await createPurchaseOrder(db, buyer, input, 'GZ-QUICK-EDIT-draft');
    const edit = { issue: true, expectedVersion: draft.version, expectedDeliveryAt: '2026-12-07', currency: 'CNY',
      lineCosts: input.lineCosts.map((line) => ({ ...line, unitCostMinor: 2700 })), note: '供应商已确认新单价' };
    const key = 'GZ-QUICK-EDIT-order';
    const racingDb = {
      prepare: db.prepare.bind(db),
      async batch(statements: D1PreparedStatement[]) {
        await db.prepare('UPDATE suppliers SET active = 0 WHERE id = ?').bind(input.supplierId).run();
        return db.batch(statements);
      },
    } as D1Database;
    await expect(updatePurchaseOrderDraft(racingDb, reviewer, draft.id, edit, key))
      .rejects.toMatchObject({ code: 'PURCHASE_ORDER_ISSUE_CONFLICT' });
    expect(await getPurchaseOrder(db, tenantId, draft.id)).toMatchObject({ status: 'draft', version: draft.version,
      expectedDeliveryAt: input.expectedDeliveryAt, lines: [{ unitCostMinor: 1800 }] });
    expect(await db.prepare('SELECT COUNT(*) AS count FROM audit_logs WHERE entity_id = ?').bind(draft.id).first('count')).toBe(1);

    await db.prepare('UPDATE suppliers SET active = 1 WHERE id = ?').bind(input.supplierId).run();
    const results = await Promise.all([
      updatePurchaseOrderDraft(db, reviewer, draft.id, edit, key), updatePurchaseOrderDraft(db, reviewer, draft.id, edit, key),
    ]);
    expect(results.map((item) => item.replayed).sort()).toEqual([false, true]);
    expect(results[0].purchaseOrder).toMatchObject({ status: 'issued', version: 3,
      expectedDeliveryAt: edit.expectedDeliveryAt, purchaserMemberId: buyerMemberId, lines: [{ unitCostMinor: 2700 }] });
    expect((await db.prepare('SELECT action, actor_id FROM audit_logs WHERE entity_id = ? ORDER BY action')
      .bind(draft.id).all()).results).toEqual([{ action: 'CREATE_PURCHASE_ORDER', actor_id: buyer.id },
      { action: 'ISSUE_PURCHASE_ORDER', actor_id: reviewer.id }, { action: 'UPDATE_PURCHASE_ORDER_DRAFT', actor_id: reviewer.id }]);
  });

  it('草稿先改商品资料再补供应商和收货信息，确认下单时保留审核数量和填写的资料', async () => {
    const input = await approveManualForIssue('GZ-DEFERRED-DETAILS');
    const { purchaseOrder: draft } = await createPurchaseOrder(db, reviewer, {
      purchaseRequestId: input.purchaseRequestId,
    }, 'GZ-DEFERRED-DETAILS-order');
    expect(draft).toMatchObject({ status: 'draft', supplier: null, deliveryWarehouse: null, currency: null,
      lines: [{ orderedQuantity: 2, unitCostMinor: null }] });
    await expect(executePurchaseOrderAction(db, reviewer, draft.id, { action: 'issue' }, 'GZ-DEFERRED-DETAILS-incomplete'))
      .rejects.toMatchObject({ code: 'PURCHASE_ORDER_SUPPLIER_REQUIRED' });

    const lineId = input.lineCosts[0].purchaseRequestLineId;
    const productDetails = { name: '采购专用货名', specification: '黑色木纹', dimensions: '100×80×75 cm',
      imageUrl: 'https://images.example.invalid/table.png' };
    const { purchaseOrder: updated } = await updatePurchaseOrderDraft(db, buyer, draft.id, {
      expectedVersion: draft.version, note: '供应商确认规格后补单价',
      lineCosts: [{ purchaseRequestLineId: lineId, productDetails }],
    }, 'GZ-DEFERRED-DETAILS-product-edit');
    expect(updated).toMatchObject({ status: 'draft', supplier: null, lines: [{ orderedQuantity: 2, unitCostMinor: null, productDetails }] });

    const { purchaseOrder: issued } = await updatePurchaseOrderDraft(db, reviewer, draft.id, {
      expectedVersion: updated.version, issue: true, supplierId: input.supplierId, deliveryWarehouseId: input.deliveryWarehouseId,
      expectedDeliveryAt: input.expectedDeliveryAt, currency: input.currency, lineCosts: input.lineCosts,
    }, 'GZ-DEFERRED-DETAILS-issue');
    expect(issued).toMatchObject({ status: 'issued', purchaserMemberId: buyerMemberId,
      supplier: { id: input.supplierId }, deliveryWarehouse: { id: input.deliveryWarehouseId },
      note: updated.note, lines: [{ skuId: draft.lines[0].skuId, orderedQuantity: 2, unitCostMinor: 1800, productDetails }] });
  });

  it('拒绝只读用户、跨工作区商品和重复商品，停用商品后不得复审或下单', async () => {
    const { sku } = await createPurchaseSku(db, buyer, { code: 'GZ-BLOCKED', name: '停用测试商品' }, 'manual-sku-disabled');
    const { sku: foreignSku } = await createPurchaseSku(db, outsider, { code: 'SZ-ONLY', name: '深圳商品' }, 'manual-foreign-sku');
    const input = { ...assignments, note: '商品启用状态验证', lines: [{ skuId: sku.id, quantity: 1 }] };
    const viewer = { ...buyer, role: 'viewer' as const, permissions: ROLE_PERMISSIONS.viewer };
    await expect(createManualPurchaseRequest(db, viewer, input, 'manual-viewer-request'))
      .rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(createManualPurchaseRequest(db, buyer, { ...input, lines: [{ skuId: foreignSku.id, quantity: 1 }] }, 'manual-foreign-request'))
      .rejects.toMatchObject({ code: 'PURCHASE_SKU_UNAVAILABLE' });
    await expect(createManualPurchaseRequest(db, buyer, { ...input, lines: [...input.lines, ...input.lines] }, 'manual-repeated-sku'))
      .rejects.toMatchObject({ code: 'PURCHASE_SKU_DUPLICATE' });
    await expect(createManualPurchaseRequest(db, reviewer, { ...input, purchaserMemberId: reviewerMemberId }, 'manual-reviewer-conflict'))
      .rejects.toMatchObject({ code: 'PURCHASE_REVIEWER_MUST_DIFFER' });

    const { request } = await createManualPurchaseRequest(db, buyer, input, 'manual-disabled-request');
    await executePurchaseRequestAction(db, buyer, request.id, { action: 'submit' }, 'manual-disabled-submit');
    const setSkuActive = (active: number) => db.prepare('UPDATE skus SET active = ? WHERE tenant_id = ? AND id = ?')
      .bind(active, tenantId, sku.id).run();
    await setSkuActive(0);
    await expect(executePurchaseRequestAction(db, reviewer, request.id, { action: 'approve' }, 'manual-disabled-approve'))
      .rejects.toMatchObject({ code: 'PURCHASE_SKU_UNAVAILABLE' });
    expect((await getPurchaseRequest(db, tenantId, request.id)).status).toBe('pending_review');
    await setSkuActive(1);
    await executePurchaseRequestAction(db, reviewer, request.id, { action: 'approve' }, 'manual-disabled-approve');
    const { warehouse } = await createWarehouse(db, buyer, { code: 'GZ-RC', name: '复核收货仓' }, 'manual-blocked-warehouse');
    const { supplier } = await createSupplier(db, buyer, { code: 'SZ-RC', name: '复核供应商' }, 'manual-blocked-supplier');
    const { purchaseOrder } = await createPurchaseOrder(db, buyer, {
      purchaseRequestId: request.id,
      supplierId: supplier.id,
      deliveryWarehouseId: warehouse.id,
      expectedDeliveryAt: '2026-12-01',
      currency: 'CNY',
      lineCosts: [{ purchaseRequestLineId: request.lines[0].id, unitCostMinor: 100 }],
    }, 'manual-blocked-po');
    await setSkuActive(0);
    await expect(executePurchaseOrderAction(db, buyer, purchaseOrder.id, { action: 'issue' }, 'manual-disabled-issue'))
      .rejects.toMatchObject({ code: 'PURCHASE_REQUEST_CHANGED' });
    expect((await getPurchaseOrder(db, tenantId, purchaseOrder.id)).status).toBe('draft');
  });

  it('手工申请可一次提交复审，重复提交只生成一套申请和审计', async () => {
    const { sku } = await createPurchaseSku(db, buyer, { code: 'GZ-DIRECT', name: '快速送审测试商品' }, 'manual-direct-sku');
    const input = { ...assignments, note: '首次直接提交', lines: [{ skuId: sku.id, quantity: 6 }] };
    const key = 'manual-direct-submit';
    const context = vi.spyOn(databaseRuntime, 'requestContext').mockResolvedValue({ db, user: buyer });
    const post = (requestIntent: unknown) => POST(new Request('https://erp.example.invalid/api/purchase/manual-requests', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
      body: JSON.stringify({ ...input, intent: requestIntent }),
    }));

    try {
      expect((await post('approve')).status).toBe(400);
      const responses = await Promise.all([post('submit'), post('submit')]);
      expect(responses.map((response) => response.status).sort()).toEqual([200, 201]);
      const results = await Promise.all(responses.map((response) => response.json() as Promise<{
        ok: boolean; replayed: boolean; request: { id: string; status: string; version: number; submittedAt: string | null };
      }>));
      const { request } = results[0];
      expect(request).toMatchObject({ status: 'pending_review', version: 2, submittedAt: expect.any(String) });
      expect(results[1].request).toEqual(request);
      expect(results.map((result) => result.replayed).sort()).toEqual([false, true]);
      expect((await post('draft')).status).toBe(409);

      const audit = await db.prepare('SELECT action, actor_id FROM audit_logs WHERE tenant_id = ? AND entity_id = ?')
        .bind(tenantId, request.id).all();
      expect(audit.results).toHaveLength(2);
      expect(audit.results).toEqual(expect.arrayContaining([
        { action: 'CREATE_MANUAL_PURCHASE_REQUEST', actor_id: buyer.id },
        { action: 'SUBMIT_PURCHASE_REQUEST', actor_id: buyer.id },
      ]));
      await expect(executePurchaseRequestAction(db, reviewer, request.id, { action: 'approve' }, 'manual-direct-review'))
        .resolves.toMatchObject({ request: { status: 'approved', version: 3 } });
      expect(await (await post('submit')).json()).toMatchObject({ replayed: true, request: { status: 'approved' } });
    } finally {
      context.mockRestore();
    }
  });

  it('提交权限和数据库复核失败时不会留下部分采购申请', async () => {
    const { sku } = await createPurchaseSku(db, buyer, { code: 'GZ-ROLLBACK', name: '送审事务测试商品' }, 'manual-rollback-sku');
    const input = { ...assignments, note: '直接提交事务测试', lines: [{ skuId: sku.id, quantity: 1 }], intent: 'submit' as const };
    await expect(createManualPurchaseRequest(db, reviewer, input, 'manual-direct-wrong-actor'))
      .rejects.toMatchObject({ code: 'PURCHASE_PURCHASER_REQUIRED' });
    await expect(createManualPurchaseRequest(db, reviewer, { ...input, purchaserMemberId: reviewerMemberId }, 'manual-direct-self-review'))
      .rejects.toMatchObject({ code: 'PURCHASE_REVIEWER_MUST_DIFFER' });

    await db.prepare(`
      CREATE TRIGGER test_reject_manual_submit BEFORE UPDATE OF status ON purchase_requests
      WHEN NEW.note = '直接提交事务测试' AND NEW.status = 'pending_review'
      BEGIN SELECT RAISE(ABORT, 'PURCHASE_DEMAND_CHANGED'); END
    `).run();
    const key = 'manual-direct-rollback';
    try {
      await expect(createManualPurchaseRequest(db, buyer, input, key))
        .rejects.toMatchObject({ code: 'PURCHASE_SKU_UNAVAILABLE' });
      expect(await db.prepare('SELECT id FROM purchase_requests WHERE tenant_id = ? AND idempotency_key = ?')
        .bind(tenantId, key).first()).toBeNull();
      expect(await db.prepare('SELECT id FROM audit_logs WHERE tenant_id = ? AND idempotency_key = ?')
        .bind(tenantId, key).first()).toBeNull();
    } finally {
      await db.prepare('DROP TRIGGER test_reject_manual_submit').run();
    }
    await expect(createManualPurchaseRequest(db, buyer, input, key))
      .resolves.toMatchObject({ replayed: false, request: { status: 'pending_review' } });
  });

  it('申请明细继承 SKU 资料并保存本单修改，后续建档变化不覆盖旧申请', async () => {
    const { sku } = await createPurchaseSku(db, buyer, {
      code: 'GZ-LINE-DETAILS', name: '标准采购商品',
      productDetails: { specification: '橡木色', dimensions: '100 × 50 cm', imageUrl: 'https://example.invalid/desk.png', description: '原版档案介绍' },
    }, 'manual-details-sku');
    const context = vi.spyOn(databaseRuntime, 'requestContext').mockResolvedValue({ db, user: buyer });
    const post = (productDetails: Record<string, string | null>) => POST(new Request(
      'https://erp.example.invalid/api/purchase/manual-requests',
      {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'manual-details-post' },
        body: JSON.stringify({
          ...assignments, note: '本次采购定制商品', lines: [{ skuId: sku.id, quantity: 2, productDetails }],
        }),
      },
    ));
    const overrides = { name: '定制桌面', imageUrl: null, description: '本单定制介绍' };
    try {
      expect((await post({ imageUrl: 'https://name:password@example.invalid/desk.png' })).status).toBe(400);
      const response = await post(overrides);
      expect(response.status).toBe(201);
      const { request } = await response.json() as { request: { id: string; lines: Array<{ id: string }> } };
      const snapshot = { ...overrides, specification: '橡木色', dimensions: '100 × 50 cm' };
      expect(request.lines[0]).toMatchObject({ skuName: '标准采购商品', productDetails: snapshot });

      await updatePurchaseSku(db, buyer, sku.id, { specification: '黑色', dimensions: null, description: '新版档案介绍' });
      const read = await getPurchaseRequest(db, tenantId, request.id);
      expect(read.lines[0].productDetails).toEqual(snapshot);
      expect(await (await post(overrides)).json()).toMatchObject({
        replayed: true, request: { id: request.id, lines: [{ productDetails: snapshot }] },
      });
    } finally {
      context.mockRestore();
    }
  });
});
