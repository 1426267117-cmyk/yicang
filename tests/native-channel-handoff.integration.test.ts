import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET, POST } from '../app/api/channel-orders/[id]/handoff/route';
import { assertDatabaseSchemaReady } from '../db/initialize';
import { openSqliteD1 } from '../lib/aws/sqlite-d1';
import { mapAmazonOrder } from '../lib/connectors/amazon/mapper';
import { saveVerifiedAmazonStore } from '../lib/connectors/amazon/store-settings';
import { PlatformOrderRepository } from '../lib/connectors/repository';
import { stableId } from '../lib/connectors/stable';
import type { UserContext } from '../lib/db';
import { resolveMemberAccess, ROLE_PERMISSIONS } from '../lib/domain';
import { executeOrderAction } from '../lib/erp-service';
import { createNativeChannelHandoff, getNativeChannelHandoff, nativeChannelHandoffPostSchema } from '../lib/native-channel-handoff';
import { createNineStoreHandoff, getNineStoreHandoff, nineStoreHandoffPostSchema } from '../lib/nine-store-handoff';
import { nineStoreOrderSnapshotSchema, nineStoreRoster, orderFeedTableKinds, type NineStoreOrderSnapshot } from '../lib/nine-store-orders-contract';
import { storeNineStoreOrderSnapshot } from '../lib/nine-store-orders-service';
import { confirmWarehouseOutboundShipment, recordWarehouseOutboundStep } from '../lib/warehouse-outbound-service';
import { money, shopifyOrderFixture } from './fixtures/shopify-order';

const { requestContext } = vi.hoisted(() => ({ requestContext: vi.fn() }));
vi.mock('cloudflare:workers', () => ({ env: {} }));
vi.mock('../lib/db', async (original) => ({ ...await original<typeof import('../lib/db')>(), requestContext }));

const migrations = fileURLToPath(new URL('../drizzle/', import.meta.url));
const now = '2026-11-25T05:50:00.000Z';
const tenantId = 'native-gz';
const otherTenant = 'native-sz';
const skuId = 'native-chair';
const sku = 'NATIVE-CHAIR';
const warehouseId = 'native-ca';
const shop = 'shopify-zimasya';
const marketplace = 'ATVPDKIKX0DER';
const user = (role: UserContext['role'], tenant = tenantId): UserContext => ({ id: `${tenant}-${role}`,
  tenantId: tenant, tenantName: tenant, role, displayName: role, email: `${tenant}-${role}@handoff.example.invalid`, permissions: ROLE_PERMISSIONS[role] });
const operator = user('operator');
const admin = user('admin');
const dispatch = { ...user('operator'), ...resolveMemberAccess('operator', 'warehouse') };
const body = { customerName: '手工核实收件人', destination: '美国', skuId, warehouseId,
  confirmedMerchantFulfillment: true, confirmedUnrefunded: true, confirmedPayment: true } as const;

let local: ReturnType<typeof openSqliteD1>;
let db: D1Database;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(now));
  local = openSqliteD1(':memory:', migrations);
  db = local.db;
  requestContext.mockReset().mockResolvedValue({ db, user: operator });
  await db.batch([
    ...[tenantId, otherTenant].map((tenant) => db.prepare('INSERT INTO tenants (id, name, created_at) VALUES (?, ?, ?)').bind(tenant, tenant, now)),
    db.prepare('INSERT INTO skus (id, tenant_id, code, name, created_at) VALUES (?, ?, ?, ?, ?)').bind(skuId, tenantId, sku, 'ERP 椅子', now),
    db.prepare('INSERT INTO warehouses (id, tenant_id, code, name, created_at) VALUES (?, ?, ?, ?, ?)').bind(warehouseId, tenantId, 'CA', 'ERP 美西仓', now),
    db.prepare('INSERT INTO warehouses (id, tenant_id, code, name, created_at) VALUES (?, ?, ?, ?, ?)').bind('native-sz-ca', otherTenant, 'CA', '另一公司仓', now),
    db.prepare(`INSERT INTO inventory_balances (id, tenant_id, sku_id, warehouse_id, on_hand_qty, updated_at) VALUES (?, ?, ?, ?, 24, ?)`)
      .bind('native-stock', tenantId, skuId, warehouseId, now),
  ]);
});

afterEach(() => { local?.close(); vi.useRealTimers(); });

const shopifyLine = (id: string, overrides: Record<string, unknown> = {}) => ({ id: `gid://shopify/LineItem/${id}`, sku,
  title: '官方商品名称', name: '官方商品名称', quantity: 2, currentQuantity: 2, unfulfilledQuantity: 2,
  requiresShipping: true, nonFulfillableQuantity: 0, ...overrides });
const lines = (...nodes: ReturnType<typeof shopifyLine>[]) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } });

async function shopify(orderNo: string, numericId: string, overrides: Record<string, unknown> = {}, fetchedAt = now,
  key: 'zimasya' | 'anzhap' = 'zimasya') {
  const repo = new PlatformOrderRepository(db, tenantId);
  const domain = `fixture-${key}.myshopify.com`;
  const store = await repo.upsertVerifiedShopifyStore({ key, displayName: key, domain, expectedDomain: domain,
    acceptedDomains: [domain], authMode: 'oauth', environmentPrefix: 'FIXTURE_SHOP', credentialRef: 'env:FIXTURE_SHOP',
    adminAccessToken: null, clientId: null, clientSecret: null }, { id: `gid://shopify/Shop/${key === 'zimasya' ? 101 : 102}`,
    name: key, domain, timezone: 'America/Los_Angeles', timezoneOffset: '-0800', currency: 'USD', scopes: new Set(['read_orders']) }, now);
  const graph = shopifyOrderFixture({ id: `gid://shopify/Order/${numericId}`, name: orderNo,
    displayFinancialStatus: 'PAID', displayFulfillmentStatus: 'UNFULFILLED', currentTotalPriceSet: money('49.99'),
    totalRefundedSet: money('0'), updatedAt: '2026-11-24T02:00:00Z', refunds: [], fulfillments: [],
    lineItems: lines(shopifyLine(numericId)), ...overrides });
  await repo.upsertOrderGraph({ storeId: store.id, graph, apiVersion: '2026-07', runId: null, fetchedAt });
  return stableId('porder', tenantId, store.id, graph.sourceOrderId);
}

async function amazon(orderNo: string, fulfilledBy = 'MERCHANT', status = 'UNSHIPPED') {
  const storeId = await saveVerifiedAmazonStore(db, tenantId, { key: 'amazon-senyu', name: '测试店', sellerId: 'SELLERTEST01',
    verificationOrderId: orderNo, marketplaceId: marketplace, refreshToken: 'test-refresh', clientId: 'test-client', clientSecret: 'test-secret' }, now);
  const graph = mapAmazonOrder({ orderId: orderNo, createdTime: '2026-11-24T00:00:00Z', lastUpdatedTime: '2026-11-24T02:00:00Z',
    salesChannel: { marketplaceId: marketplace }, fulfillment: { fulfillmentStatus: status, fulfilledBy },
    proceeds: { grandTotal: { amount: '49.99', currencyCode: 'USD' } }, buyer: { name: 'API_PRIVATE_NAME' },
    orderItems: [{ orderItemId: 'test-line', quantityOrdered: 2, product: { sellerSku: sku, title: '官方商品名称' },
      fulfillment: { quantityUnfulfilled: 2, quantityFulfilled: 0 } }] }, marketplace);
  await new PlatformOrderRepository(db, tenantId, 'amazon').upsertOrderGraph({ storeId, graph, apiVersion: '2026-01-01', runId: null, fetchedAt: now });
  return stableId('porder', tenantId, storeId, graph.sourceOrderId);
}

async function inputFor(id: string) {
  const { source } = await getNativeChannelHandoff(db, operator, id);
  return nativeChannelHandoffPostSchema.parse({ ...body, storeKey: source.storeKey, sourceVersion: source.sourceVersion });
}

function feishuInput(orderNo: string) {
  return nineStoreHandoffPostSchema.parse({ customerName: body.customerName, destination: body.destination, skuId, warehouseId,
    storeKey: shop, orderNo, sourceSku: sku, observedAt: now, quantity: 2, currency: 'USD', amountMinor: 4999, confirmedPending: true });
}

async function feishu(orderNos: string[], refunds: NineStoreOrderSnapshot['refunds'] = []) {
  const orders = orderNos.map((orderNo, index) => ({ recordId: `recHandoffShop${index}`, storeKey: shop,
    orderNo, sku, orderDate: '2026-11-25', quantity: 2, fulfillment: 'pending' }));
  const snapshot = nineStoreOrderSnapshotSchema.parse({ version: 1, source: 'feishu-order-base', observedAt: now,
    stores: nineStoreRoster.map(([key, platform]) => ({ key, platform, name: key })),
    tables: orderFeedTableKinds.map((kind) => {
      const accepted = kind === 'shopify-orders' ? orders.length : kind === 'refunds' ? refunds.length : 0;
      return { kind, revision: '1', read: accepted, accepted, outsideScope: 0, invalid: 0 };
    }), orders, refunds });
  await storeNineStoreOrderSnapshot(db, tenantId, snapshot);
}

function stock() {
  return db.prepare('SELECT on_hand_qty, reserved_qty FROM inventory_balances WHERE id = ?').bind('native-stock').first();
}

describe('官方渠道待发货订单转入 ERP', () => {
  it('通过真实 API 并发转单仅一张，审核后才预占，仓库发货前再次验证官方状态', async () => {
    await assertDatabaseSchemaReady(db);
    const id = await amazon('113-1111222-3333444');
    const route = { params: Promise.resolve({ id }) };
    const url = `https://erp.example.invalid/api/channel-orders/${id}/handoff`;
    const api = (data: object) => POST(new Request(url, { method: 'POST', body: JSON.stringify(data) }), route);
    const review = await GET(new Request(url), route);
    const snapshot = await review.json();
    expect(snapshot).toMatchObject({ eligibility: 'ready', canCreate: true, matchedSkuId: skuId,
      source: { platform: 'amazon', storeKey: 'amazon-senyu', orderNo: '113-1111222-3333444', quantity: 2, amountMinor: 4999 } });
    expect(JSON.stringify(snapshot)).not.toContain('API_PRIVATE_NAME');
    const input = await inputFor(id);
    expect((await api({ ...input, confirmedPayment: false })).status).toBe(400);
    expect((await api({ ...input, customerName: '' })).status).toBe(400);
    expect((await api({ ...input, storeKey: 'amazon-kaguyasu' })).status).toBe(409);
    expect((await api({ ...input, sourceVersion: '1'.repeat(64) })).status).toBe(409);
    expect((await api({ ...input, warehouseId: 'native-sz-ca' })).status).toBe(409);
    const replies = await Promise.all(Array.from({ length: 5 }, () => api(input)));
    expect(replies.map((item) => item.status).sort()).toEqual([200, 200, 200, 200, 201]);
    const created = await Promise.all(replies.map((item) => item.json())) as { order: { id: string; status: string } }[];
    const orderId = created[0].order.id;
    expect(created.every((item) => item.order.id === orderId && item.order.status === 'pending_review')).toBe(true);
    expect(await stock()).toEqual({ on_hand_qty: 24, reserved_qty: 0 });
    expect(await db.prepare('SELECT COUNT(*) AS total FROM native_channel_handoff_proofs').first('total')).toBe(1);
    await expect(db.prepare('DELETE FROM native_channel_handoff_proofs WHERE order_id = ?').bind(orderId).run())
      .rejects.toThrow('NATIVE_CHANNEL_HANDOFF_PROOF_IMMUTABLE');
    await executeOrderAction(db, admin, orderId, 'approve', 'native-approved');
    expect(await stock()).toEqual({ on_hand_qty: 24, reserved_qty: 2 });
    await recordWarehouseOutboundStep(db, dispatch, orderId, { step: 'pick', expectedVersion: 0, quantity: 2 }, 'native-test-pick');
    await recordWarehouseOutboundStep(db, dispatch, orderId, { step: 'verify', expectedVersion: 1, quantity: 2, skuCode: sku }, 'native-test-verify');
    await recordWarehouseOutboundStep(db, dispatch, orderId, { step: 'pack', expectedVersion: 2, packageCount: 1 }, 'native-test-pack');
    const shipment = await Promise.all([confirmWarehouseOutboundShipment(db, dispatch, orderId, 'native-test-ship'),
      confirmWarehouseOutboundShipment(db, dispatch, orderId, 'native-test-ship')]);
    expect(shipment.filter((item) => !item.replayed)).toHaveLength(1);
    expect(await stock()).toEqual({ on_hand_qty: 22, reserved_qty: 0 });
    expect(await getNativeChannelHandoff(db, operator, id)).toMatchObject({ eligibility: 'already_linked', linkedOrder: { id: orderId, status: 'shipped' } });
  });

  it('以同店铺和唯一平台单号合并已关联身份，两个来源并发也不会建重单', async () => {
    await feishu(['7001', '7002', '7003']);
    const first = await shopify('#7001', '9000001');
    const second = await shopify('#7002', '9000002');
    const racing = await shopify('#7003', '9000003');
    const prior = await createNineStoreHandoff(db, operator, feishuInput('7001'));
    expect(await getNativeChannelHandoff(db, operator, first)).toMatchObject({ eligibility: 'already_linked', linkedOrder: { id: prior.order.id } });
    await expect(createNativeChannelHandoff(db, operator, first, await inputFor(first))).rejects.toMatchObject({ code: 'NATIVE_HANDOFF_ALREADY_LINKED' });
    const official = await createNativeChannelHandoff(db, operator, second, await inputFor(second));
    expect(await getNineStoreHandoff(db, operator, { store: shop, orderNo: '7002' })).toMatchObject({
      eligibility: 'already_linked', linkedOrder: { id: official.order.id },
    });
    await expect(createNineStoreHandoff(db, operator, feishuInput('7002'))).rejects.toMatchObject({ code: 'NINE_STORE_HANDOFF_ALREADY_LINKED' });
    const competing = await Promise.allSettled([createNativeChannelHandoff(db, operator, racing, await inputFor(racing)),
      createNineStoreHandoff(db, operator, feishuInput('7003'))]);
    expect(competing.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const differentShop = await shopify('#7001', '9000005', {}, now, 'anzhap');
    expect(await getNativeChannelHandoff(db, operator, differentShop)).toMatchObject({ eligibility: 'ready' });
    expect(await db.prepare('SELECT COUNT(*) AS total FROM orders').first('total')).toBe(3);
  });

  it('拒绝有多个官方候选的数字别名和无法确认的 Shopify 内部编号', async () => {
    await feishu(['9000033']);
    await createNineStoreHandoff(db, operator, feishuInput('9000033'));
    const internal = await shopify('#8000', '9000033');
    expect(await getNativeChannelHandoff(db, operator, internal)).toMatchObject({ eligibility: 'identity_ambiguous', linkedOrder: null });
    const alias = await shopify('#8001', '9000034');
    await shopify('8001', '9000035');
    expect(await getNativeChannelHandoff(db, operator, alias)).toMatchObject({ eligibility: 'identity_ambiguous', linkedOrder: null });
    await expect(createNativeChannelHandoff(db, operator, alias, await inputFor(alias))).rejects.toMatchObject({ code: 'NATIVE_HANDOFF_IDENTITY_AMBIGUOUS' });
    expect(await db.prepare('SELECT COUNT(*) AS total FROM orders').first('total')).toBe(1);

    const beforeRename = await shopify('#8002', '9000036');
    const prior = await createNativeChannelHandoff(db, operator, beforeRename, await inputFor(beforeRename));
    await shopify('#8099', '9000036', { updatedAt: '2026-11-24T03:00:00Z' });
    expect(await getNativeChannelHandoff(db, operator, beforeRename)).toMatchObject({ eligibility: 'already_linked', linkedOrder: { id: prior.order.id } });
    const reusedDisplayNo = await shopify('#8002', '9000037');
    expect(await getNativeChannelHandoff(db, operator, reusedDisplayNo)).toMatchObject({ eligibility: 'identity_ambiguous', linkedOrder: null });
    await expect(getNineStoreHandoff(db, operator, { store: shop, orderNo: '8002' })).rejects.toMatchObject({ code: 'NINE_STORE_HANDOFF_AMBIGUOUS' });
  });

  it('拒绝退款、取消、非实物、无名称金额、多商品、平台配送和跨权限范围', async () => {
    const scenarios = [
      ['refunded', { totalRefundedSet: money('1.00') }],
      ['not_pending', { cancelledAt: now }],
      ['payment_unverified', { displayFinancialStatus: 'PENDING' }],
      ['shipping_unverified', { lineItems: lines(shopifyLine('3', { requiresShipping: false })) }],
      ['missing_title', { lineItems: lines(shopifyLine('4', { title: null, name: null })) }],
      ['amount_unverified', { currentTotalPriceSet: null }],
      ['amount_unverified', { currentTotalPriceSet: money('49.99', 'JPY') }],
      ['ambiguous_lines', { lineItems: lines(shopifyLine('7'), shopifyLine('8', { sku: 'OTHER' })) }],
      ['quantity_unverified', { lineItems: lines(shopifyLine('8', { unfulfilledQuantity: 1 })) }],
    ] as const;
    for (const [index, [eligibility, options]] of scenarios.entries()) {
      const id = await shopify(`#901${index}`, `700${index}`, options);
      expect(await getNativeChannelHandoff(db, operator, id)).toMatchObject({ eligibility, canCreate: false });
    }
    const fba = await amazon('113-1111222-3333445', 'AMAZON');
    expect(await getNativeChannelHandoff(db, operator, fba)).toMatchObject({ eligibility: 'merchant_unverified' });
    const hasRefund = await amazon('113-1111222-3333446');
    await feishu([], [{ recordId: 'recNativeAmazonRefund', storeKey: 'amazon-senyu', orderNo: '113-1111222-3333446', sku, refundDate: '2026-11-25' }]);
    expect(await getNativeChannelHandoff(db, operator, hasRefund)).toMatchObject({ eligibility: 'refunded' });
    const end = { ...operator, ...resolveMemberAccess('operator', 'shopify') };
    await expect(getNativeChannelHandoff(db, end, fba)).rejects.toMatchObject({ status: 403 });
    await expect(getNativeChannelHandoff(db, user('admin', otherTenant), fba)).rejects.toMatchObject({ status: 404 });
    await expect(createNativeChannelHandoff(db, user('viewer'), fba, await inputFor(fba))).rejects.toMatchObject({ status: 403 });
    expect(await db.prepare('SELECT COUNT(*) AS total FROM orders').first('total')).toBe(0);
  });

  it('过期来源不能靠旧版本刷新，写入再校验且已转单遇退款无法预占', async () => {
    const id = await shopify('#9400', '99001', {}, '2026-11-25T05:30:00.000Z');
    await shopify('#9400', '99001', { updatedAt: '2026-11-24T00:00:00Z' });
    expect(await getNativeChannelHandoff(db, operator, id)).toMatchObject({ eligibility: 'source_stale' });
    await shopify('#9400', '99001');
    const input = await inputFor(id);
    const racing = new Proxy(db, { get(target, property) {
      if (property === 'batch') return async (statements: D1PreparedStatement[]) => {
        await shopify('#9400', '99001', { updatedAt: '2026-11-24T03:00:00Z', totalRefundedSet: money('4.00') });
        return target.batch(statements);
      };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    await expect(createNativeChannelHandoff(racing, operator, id, input)).rejects.toMatchObject({ code: 'NATIVE_HANDOFF_SOURCE_CHANGED' });
    expect(await db.prepare('SELECT COUNT(*) AS total FROM orders').first('total')).toBe(0);

    const next = await shopify('#9401', '99002');
    const { order } = await createNativeChannelHandoff(db, operator, next, await inputFor(next));
    await shopify('#9401', '99002', { updatedAt: '2026-11-24T04:00:00Z', totalRefundedSet: money('3.00') });
    await expect(executeOrderAction(db, admin, order.id, 'approve', 'native-deny-after-refund'))
      .rejects.toMatchObject({ code: 'NATIVE_CHANNEL_HANDOFF_SOURCE_CHANGED' });
    expect(await stock()).toEqual({ on_hand_qty: 24, reserved_qty: 0 });

    const reserved = await shopify('#9402', '99003');
    const pending = (await createNativeChannelHandoff(db, operator, reserved, await inputFor(reserved))).order;
    await executeOrderAction(db, admin, pending.id, 'approve', 'native-reserve-before-cancel');
    await recordWarehouseOutboundStep(db, dispatch, pending.id, { step: 'pick', expectedVersion: 0, quantity: 2 }, 'native-cancelled-pick');
    await recordWarehouseOutboundStep(db, dispatch, pending.id, { step: 'verify', expectedVersion: 1, quantity: 2, skuCode: sku }, 'native-cancelled-verify');
    await recordWarehouseOutboundStep(db, dispatch, pending.id, { step: 'pack', expectedVersion: 2, packageCount: 1 }, 'native-cancelled-pack');
    await shopify('#9402', '99003', { updatedAt: '2026-11-24T04:15:00Z', cancelledAt: now });
    await expect(confirmWarehouseOutboundShipment(db, dispatch, pending.id, 'native-cancelled-ship'))
      .rejects.toMatchObject({ code: 'NATIVE_CHANNEL_HANDOFF_SOURCE_CHANGED' });
    expect(await stock()).toEqual({ on_hand_qty: 24, reserved_qty: 2 });
    await executeOrderAction(db, operator, pending.id, 'cancel', 'native-release-on-cancel');
    expect(await stock()).toEqual({ on_hand_qty: 24, reserved_qty: 0 });
  });
});
