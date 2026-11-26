import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET as readQualityRoute } from '../app/api/purchase/orders/[id]/quality/route';
import { POST as postReceipt } from '../app/api/purchase/orders/[id]/receipts/route';
import { GET as readWarehouseWorkspace } from '../app/api/warehouse/workspace/route';
import { GET as readWarehouseSkus } from '../app/api/warehouse/skus/route';
import { GET as readPurchaseWorkspace } from '../app/api/purchase/workspace/route';
import { openSqliteD1 } from '../lib/aws/sqlite-d1';
import type { UserContext } from '../lib/db';
import { resolveMemberAccess, ROLE_PERMISSIONS, type Role } from '../lib/domain';
import { createPurchaseOrder, createPurchaseReceipt, createSupplier, createWarehouse, executePurchaseOrderAction,
  type getWarehouseWorkspaceData, type toWarehousePurchaseOrder } from '../lib/purchase-order-service';
import { purchaseQualityMutationSchema, readPurchaseQuality, writePurchaseQuality } from '../lib/purchase-quality-service';
import { createPurchaseReceiptCorrection } from '../lib/purchase-receipt-correction-service';
import { createPurchaseSku } from '../lib/purchase-sku-service';
import { createManualPurchaseRequest, executePurchaseRequestAction } from '../lib/purchase-workflow-service';

const { requestContext } = vi.hoisted(() => ({ requestContext: vi.fn() }));
vi.mock('cloudflare:workers', () => ({ env: {} }));
vi.mock('../lib/db', async (original) => ({ ...await original<typeof import('../lib/db')>(), requestContext }));

const migrations = fileURLToPath(new URL('../drizzle/', import.meta.url));
const now = '2026-11-25T00:00:00.000Z';
const tenantId = 'quality-test-gz';

function actor(id: string, role: Role): UserContext {
  return { id, tenantId, tenantName: '质检测试', role, displayName: id,
    email: `${id}@example.invalid`, permissions: ROLE_PERMISSIONS[role] };
}

const admin = actor('qc-admin', 'admin');
const buyer = actor('qc-buyer', 'operator');
const receiver = actor('qc-receiver', 'operator');
const viewer = actor('qc-viewer', 'viewer');
const qualityRequirement = { action: 'require' as const, reason: '抽检风险批次全数检查' };

async function seedScenario(db: D1Database) {
  await db.batch([
    db.prepare('INSERT INTO tenants (id, name, created_at) VALUES (?, ?, ?)').bind(tenantId, buyer.tenantName, now),
    ...[admin, buyer, receiver, viewer].map((user) => db.prepare(`
      INSERT INTO members (id, tenant_id, auth_user_id, email, display_name, role, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).bind(user.id, tenantId, user.id, user.email, user.displayName, user.role, now)),
  ]);
  const skuInputs = [{ code: 'QC-ONE', name: '质检商品一' }, { code: 'QC-TWO', name: '质检商品二' }];
  const skus = [];
  for (const input of skuInputs) {
    skus.push((await createPurchaseSku(db, buyer, input, `quality-sku-${input.code}`)).sku);
  }
  const { warehouse } = await createWarehouse(db, receiver, { code: 'QC-US', name: '质检入库仓' }, 'quality-warehouse');
  const { supplier } = await createSupplier(db, buyer, { code: 'QC-SUP', name: '质检测试供应商' }, 'quality-supplier');
  const { request } = await createManualPurchaseRequest(db, buyer, {
    purchaserMemberId: buyer.id, reviewerMemberId: admin.id, note: '质检验收测试',
    lines: skus.map((sku) => ({ skuId: sku.id, quantity: 10 })),
  }, 'quality-request');
  await executePurchaseRequestAction(db, buyer, request.id, { action: 'submit' }, 'quality-submit');
  await executePurchaseRequestAction(db, admin, request.id, { action: 'approve' }, 'quality-approve');
  const { purchaseOrder } = await createPurchaseOrder(db, buyer, {
    purchaseRequestId: request.id, supplierId: supplier.id, deliveryWarehouseId: warehouse.id,
    expectedDeliveryAt: '2026-12-01', currency: 'USD',
    lineCosts: request.lines.map((line) => ({ purchaseRequestLineId: line.id, unitCostMinor: 1_000 })),
  }, 'quality-order');
  return { purchaseOrder, warehouseId: warehouse.id };
}

describe('采购到货质检与库存边界', () => {
  let database: ReturnType<typeof openSqliteD1>;
  let db: D1Database;
  let orderId: string;
  let warehouseId: string;
  let firstLine: string;
  let secondLine: string;

  beforeEach(async () => {
    database = openSqliteD1(':memory:', migrations);
    db = database.db;
    const seeded = await seedScenario(db);
    orderId = seeded.purchaseOrder.id;
    warehouseId = seeded.warehouseId;
    [firstLine, secondLine] = seeded.purchaseOrder.lines.map((line) => line.id);
  });

  afterEach(() => database?.close());

  const issue = () => executePurchaseOrderAction(db, buyer, orderId, { action: 'issue' }, 'quality-issue');
  const enable = () => writePurchaseQuality(db, buyer, orderId, qualityRequirement, 'quality-enable');
  const inspect = (batchReference: string, passedQty: number, rejectedQty: number, key: string) =>
    writePurchaseQuality(db, receiver, orderId, { action: 'inspect', batchReference, lines: [{
      purchaseOrderLineId: firstLine, passedQty, rejectedQty, defectReason: rejectedQty ? '配件损坏' : undefined,
    }] }, key);
  const receive = (quantity: number, key: string) => createPurchaseReceipt(db, receiver, orderId, {
    warehouseId, lines: [{ purchaseOrderLineId: firstLine, quantity }],
  }, key);
  async function onHand() {
    return await db.prepare('SELECT COALESCE(SUM(on_hand_qty), 0) AS quantity FROM inventory_balances WHERE tenant_id = ?')
      .bind(tenantId).first('quantity');
  }

  it('仓库岗位可以登记到货，但只能读取已下单的作业字段', async () => {
    const warehouseActor = { ...receiver, accessProfile: 'warehouse' as const, ...resolveMemberAccess('operator', 'warehouse') };
    const purchaseActor = { ...buyer, accessProfile: 'purchase' as const, ...resolveMemberAccess('operator', 'purchase') };
    const request = (path: string) => new Request(`https://erp.example.test${path}`);
    const workspaceRequest = request('/api/warehouse/workspace');
    const purchaseRequest = request('/api/purchase/workspace');
    const qualityRequest = request(`/api/purchase/orders/${orderId}/quality?view=limits`);
    const params = { params: Promise.resolve({ id: orderId }) };
    requestContext.mockResolvedValue({ db, user: purchaseActor });
    expect((await readPurchaseWorkspace(purchaseRequest)).status).toBe(200);
    requestContext.mockResolvedValue({ db, user: warehouseActor });
    expect((await readPurchaseWorkspace(purchaseRequest)).status).toBe(403);
    const skuSearch = await readWarehouseSkus(request('/api/warehouse/skus?q=QC-ONE'));
    expect(skuSearch.status).toBe(200);
    expect(await skuSearch.json()).toEqual({ ok: true, skus: [{ id: expect.any(String), code: 'QC-ONE', name: '质检商品一' }] });
    const draft = await readWarehouseWorkspace(workspaceRequest);
    expect(draft.status).toBe(200);
    expect(await draft.json()).toMatchObject({ purchaseOrders: [], purchaseReceipts: [] });
    expect((await readQualityRoute(qualityRequest, params)).status).toBe(404);

    await issue();
    const issued = await readWarehouseWorkspace(workspaceRequest);
    expect(issued.status).toBe(200);
    const work = await issued.json() as Awaited<ReturnType<typeof getWarehouseWorkspaceData>>;
    expect(work).toMatchObject({ purchaseOrders: [{ id: orderId, supplier: { name: '质检测试供应商' } }] });
    expect(work).not.toHaveProperty('suppliers');
    expect(work.purchaseOrders[0]).not.toHaveProperty('paymentTerms');
    expect(work.purchaseOrders[0].lines[0]).not.toHaveProperty('unitCostMinor');
    expect((await readQualityRoute(qualityRequest, params)).status).toBe(200);

    const receipt = await postReceipt(new Request(`https://erp.example.test/api/purchase/orders/${orderId}/receipts`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'warehouse-profile-receipt' },
      body: JSON.stringify({ warehouseId, lines: [{ purchaseOrderLineId: firstLine, quantity: 1 }] }),
    }), params);
    expect(receipt.status).toBe(201);
    const result = await receipt.json() as { purchaseOrder: ReturnType<typeof toWarehousePurchaseOrder> };
    expect(result.purchaseOrder.status).toBe('partially_received');
    expect(result.purchaseOrder.lines[0]).not.toHaveProperty('unitCostMinor');
    expect(await (await readWarehouseWorkspace(workspaceRequest)).json()).toMatchObject({
      purchaseReceipts: [{ totalQuantity: 1 }], procurementSummary: { receiptCount: 1 },
    });
  });

  it('按采购行放行，未通过质检的收货整批回滚且不合格从未进入库存', async () => {
    expect(await enable()).toEqual({ replayed: false });
    await expect(inspect('DRAFT-LOT', 1, 0, 'quality-draft-inspection')).rejects.toMatchObject({ code: 'PURCHASE_QUALITY_NOT_INSPECTABLE' });
    await issue();
    await expect(receive(1, 'quality-before-inspection')).rejects.toMatchObject({ code: 'PURCHASE_RECEIPT_QUALITY_LIMIT' });
    await inspect('LOT-01', 6, 2, 'quality-first-inspection');
    expect(await onHand()).toBe(0);
    const { lines, inspections } = await readPurchaseQuality(db, viewer, orderId);
    expect(lines.find((line) => line.purchaseOrderLineId === firstLine)).toMatchObject({
      remainingQty: 10, passedQty: 6, rejectedQty: 2, receivedGrossQty: 0, availableQty: 6, inspectableQty: 4,
    });
    expect(inspections[0]).toMatchObject({ batchReference: 'LOT-01', inspectedBy: receiver.displayName,
      lines: [{ passedQty: 6, rejectedQty: 2, defectReason: '配件损坏' }] });
    requestContext.mockResolvedValue({ db, user: receiver });
    const limitsResponse = await readQualityRoute(new Request(`https://erp.example.invalid/api/purchase/orders/${orderId}/quality?view=limits`), {
      params: Promise.resolve({ id: orderId }),
    });
    expect(limitsResponse.status).toBe(200);
    expect(limitsResponse.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await limitsResponse.json()).toMatchObject({ ok: true, state: { required: true, inspections: [] } });
    await expect(createPurchaseReceipt(db, receiver, orderId, { warehouseId, lines: [
      { purchaseOrderLineId: firstLine, quantity: 6 }, { purchaseOrderLineId: secondLine, quantity: 1 },
    ] }, 'quality-reject-mixed-receipt')).rejects.toMatchObject({ code: 'PURCHASE_RECEIPT_QUALITY_LIMIT' });
    expect(await onHand()).toBe(0);
    expect(await db.prepare('SELECT COUNT(*) AS count FROM purchase_receipts').first('count')).toBe(0);
    await receive(6, 'quality-accepted-receipt');
    expect(await onHand()).toBe(6);
    await expect(receive(1, 'quality-extra-receipt')).rejects.toMatchObject({ code: 'PURCHASE_RECEIPT_QUALITY_LIMIT' });
  });

  it('重复提交仅登记一次，冲正不恢复原检验额度，新批次可以补货', async () => {
    const requirement = await Promise.all([enable(), enable()]);
    expect(requirement.map((item) => item.replayed).sort()).toEqual([false, true]);
    await issue();
    const inspections = await Promise.all([
      inspect('LOT-02', 5, 1, 'quality-same-inspection'), inspect('LOT-02', 5, 1, 'quality-same-inspection'),
    ]);
    expect(inspections.map((item) => item.replayed).sort()).toEqual([false, true]);
    await expect(inspect('lot-02', 1, 0, 'quality-duplicate-batch')).rejects.toMatchObject({ code: 'PURCHASE_QUALITY_DUPLICATE_BATCH' });
    await expect(inspect('LOT-03', 6, 0, 'quality-too-many')).rejects.toMatchObject({ code: 'PURCHASE_QUALITY_EXCEEDS_INSPECTABLE' });
    const { receipt } = await receive(5, 'quality-receive-lot-2');
    await createPurchaseReceiptCorrection(db, receiver, receipt.id, { reason: '复核发现错录',
      lines: [{ purchaseReceiptLineId: receipt.lines[0].id, quantity: 2 }] }, 'quality-receipt-correction');
    expect(await onHand()).toBe(3);
    expect((await readPurchaseQuality(db, receiver, orderId)).lines.find((line) => line.purchaseOrderLineId === firstLine))
      .toMatchObject({ passedQty: 5, receivedGrossQty: 5, availableQty: 0 });
    await expect(receive(1, 'quality-receipt-after-correction')).rejects.toMatchObject({ code: 'PURCHASE_RECEIPT_QUALITY_LIMIT' });
    await inspect('LOT-REPLACEMENT', 2, 0, 'quality-replacement-inspection');
    await receive(2, 'quality-replacement-receipt');
    expect(await onHand()).toBe(5);
    expect(await db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'POST_PURCHASE_INSPECTION'").first('count')).toBe(2);
    await expect(db.prepare("UPDATE purchase_quality_inspections SET note = '改写' WHERE tenant_id = ?").bind(tenantId).run())
      .rejects.toThrow('PURCHASE_QUALITY_IMMUTABLE');
  });

  it('旧收货链路保留，按公司和角色校验质检写入', async () => {
    await expect(writePurchaseQuality(db, receiver, orderId, qualityRequirement, 'quality-non-owner'))
      .rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await expect(writePurchaseQuality(db, viewer, orderId, qualityRequirement, 'quality-read-only'))
      .rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    await issue();
    await expect(readPurchaseQuality(db, { ...viewer, tenantId: 'shenzhen-other' }, orderId))
      .rejects.toMatchObject({ code: 'PURCHASE_ORDER_NOT_FOUND' });
    await receive(4, 'quality-legacy-receipt');
    expect(await onHand()).toBe(4);
    expect(await readPurchaseQuality(db, buyer, orderId, false)).toMatchObject({ required: false, hasReceipt: true, canEnable: false, inspections: [] });
    await expect(enable()).rejects.toMatchObject({ code: 'PURCHASE_QUALITY_REQUIREMENT_CLOSED' });
    expect(purchaseQualityMutationSchema.safeParse({ action: 'inspect', batchReference: 'LOTT-2',
      lines: [{ purchaseOrderLineId: firstLine, passedQty: 0, rejectedQty: 2 }] }).success).toBe(false);
  });

  it('并行质检的合格件不能共同超过采购单待收数量', async () => {
    await enable();
    await issue();
    const results = await Promise.allSettled([
      inspect('CONCURRENT-A', 7, 0, 'quality-inspect-concurrent-a'),
      inspect('CONCURRENT-B', 7, 0, 'quality-inspect-concurrent-b'),
    ]);
    expect(results.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((entry) => entry.status === 'rejected'))
      .toMatchObject({ reason: { code: 'PURCHASE_QUALITY_EXCEEDS_INSPECTABLE' } });
    expect((await readPurchaseQuality(db, receiver, orderId)).inspections).toHaveLength(1);
    expect(await onHand()).toBe(0);
  });
});
