import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openSqliteD1 } from '../lib/aws/sqlite-d1';
import { AmazonConnectorError, type AmazonOrderGraph } from '../lib/connectors/amazon/orders';
import { mapAmazonOrder } from '../lib/connectors/amazon/mapper';
import { amazonStoreId, getAmazonStoreSettings, readAmazonStoreStatuses, type AmazonStoreConfig } from '../lib/connectors/amazon/store-settings';
import { runAmazonOrderSync } from '../lib/connectors/amazon/sync-service';
import { PlatformOrderRepository } from '../lib/connectors/repository';
import { handleAmazonReconcile } from '../app/api/connectors/amazon/reconcile/route';

vi.mock('cloudflare:workers', () => ({ env: {} }));

const tenantId = 'amazon-gz';
const initial = '2026-11-25T12:00:00.000Z';
const from = '2026-11-23T12:00:00.000Z';
const until = '2026-11-25T11:58:00.000Z';
const marketplace = 'ATVPDKIKX0DER';
const config: AmazonStoreConfig = {
  key: 'amazon-senyu', name: '森语', sellerId: 'SELLER0001', verificationOrderId: '113-1111222-3333444',
  marketplaceId: marketplace, clientId: 'fake-client', clientSecret: 'fake-secret', refreshToken: 'fake-refresh-store-one',
};

function order(id: string, status = 'UNSHIPPED', updatedAt = '2026-11-24T21:00:00.000Z') {
  return mapAmazonOrder({
    orderId: id, createdTime: from, lastUpdatedTime: updatedAt,
    salesChannel: { marketplaceId: marketplace },
    fulfillment: { fulfillmentStatus: status, fulfilledBy: 'SELLER' },
    buyer: { email: 'PRIVATE_BUYER' },
    recipient: { address: 'PRIVATE_RECIPIENT' },
    orderItems: [{ orderItemId: 'item-1', quantityOrdered: 1, product: { sellerSku: 'AMAZON-ITEM' } }],
  }, marketplace);
}

const singlePage = (entries: AmazonOrderGraph[]) => ({ nodes: entries, hasNextPage: false, endCursor: null });
const configEnv = {
  ERP_AMAZON_ORDERS_TENANT_ID: tenantId,
  ERP_AMAZON_CLIENT_ID: config.clientId,
  ERP_AMAZON_CLIENT_SECRET: config.clientSecret,
  ERP_AMAZON_SENYU_SELLER_ID: config.sellerId,
  ERP_AMAZON_SENYU_VERIFY_ORDER_ID: config.verificationOrderId,
  ERP_AMAZON_SENYU_REFRESH_TOKEN: config.refreshToken,
  ERP_AMAZON_SENYU_MARKETPLACE_ID: marketplace,
};

describe('Amazon 多店同步与账本隔离', () => {
  let connection: ReturnType<typeof openSqliteD1>;
  let db: D1Database;

  beforeEach(async () => {
    connection = openSqliteD1(':memory:', fileURLToPath(new URL('../drizzle/', import.meta.url)));
    db = connection.db;
    await db.prepare('INSERT INTO tenants (id, name, created_at) VALUES (?, ?, ?)').bind(tenantId, '广州测试', initial).run();
  });
  afterEach(() => connection?.close());

  it('不向其他工作区加载授权，并识别重复卖家、令牌或核验单配置', async () => {
    expect(getAmazonStoreSettings(configEnv, 'amazon-sz').every((store) => store.config === null)).toBe(true);
    const duplicated = {
      ...configEnv, ERP_AMAZON_KAGUYASU_SELLER_ID: 'SELLER0002', ERP_AMAZON_KAGUYASU_MARKETPLACE_ID: marketplace,
      ERP_AMAZON_KAGUYASU_VERIFY_ORDER_ID: '113-1111111-2222222', ERP_AMAZON_KAGUYASU_REFRESH_TOKEN: config.refreshToken,
    };
    expect(getAmazonStoreSettings(duplicated, tenantId).slice(0, 2).map((store) => store.configuration)).toEqual(['duplicate', 'duplicate']);
    const statuses = await readAmazonStoreStatuses(db, tenantId, configEnv);
    expect(statuses).toHaveLength(4);
    expect(statuses[0]).toMatchObject({ configuration: 'configured', sourceVerified: false, completedWatermark: null });
    expect(JSON.stringify(statuses)).not.toMatch(/fake-|SELLER0001|113-1111222/u);
  });

  it('有实际店铺授权和首轮范围才落库，核验失败保留空状态', async () => {
    const source = {
      verifyOrder: vi.fn(async () => { throw new AmazonConnectorError('AMAZON_STORE_IDENTITY_UNVERIFIED'); }),
      searchOrders: vi.fn(async () => singlePage([])),
    };
    const run = (start?: string) => runAmazonOrderSync({
      db, tenantId, config, now: () => new Date(initial), source,
      request: { storeKey: config.key, from: start, maxPages: 1 },
    });
    await expect(run()).rejects.toMatchObject({ code: 'AMAZON_INITIAL_RANGE_REQUIRED' });
    expect(source.verifyOrder).not.toHaveBeenCalled();
    await expect(run(from)).rejects.toMatchObject({ code: 'AMAZON_STORE_IDENTITY_UNVERIFIED' });
    expect(source.verifyOrder).toHaveBeenCalledWith(config.verificationOrderId);
    expect(source.searchOrders).not.toHaveBeenCalled();
    expect(await db.prepare('SELECT COUNT(*) AS total FROM platform_stores').first('total')).toBe(0);
  });

  it('在固定窗口断点续读，直到所有页完成才推进水位，无重复订单或采购需求', async () => {
    const one = order('113-0000001-0000001');
    const two = order('113-0000002-0000002', 'SHIPPED');
    const source = {
      verifyOrder: vi.fn(async () => {}),
      searchOrders: vi.fn()
        .mockResolvedValueOnce({ nodes: [one], hasNextPage: true, endCursor: 'resume-token' })
        .mockResolvedValueOnce(singlePage([one, two])),
    };
    const run = (date: string, start?: string) => runAmazonOrderSync({
      db, tenantId, config, now: () => new Date(date), source,
      request: { storeKey: config.key, from: start, maxPages: 1 },
    });
    const repo = new PlatformOrderRepository(db, tenantId, 'amazon');
    const id = await amazonStoreId(tenantId, config);
    expect(await run(initial, from)).toMatchObject({ complete: false, code: 'AMAZON_PAGE_LIMIT_REACHED', stats: { ordersInserted: 1 } });
    expect(await repo.getSyncState(id)).toMatchObject({ completedWatermark: null, activeWindowStart: from, activeWindowEnd: until, status: 'failed' });
    expect(await run('2026-11-25T13:00:00.000Z')).toMatchObject({
      complete: true, completedWatermark: until, stats: { ordersInserted: 1, ordersUnchanged: 1 },
    });
    expect(source.searchOrders.mock.calls).toEqual([
      [{ since: from, until, cursor: null }],
      [{ since: from, until, cursor: 'resume-token' }],
    ]);
    expect(await repo.getSyncState(id)).toMatchObject({ completedWatermark: until, activeWindowStart: null, activeWindowEnd: null, status: 'idle' });
    const records = await db.prepare('SELECT platform, raw_json FROM platform_orders ORDER BY source_order_id').all<{ platform: string; raw_json: string }>();
    expect(records.results.map((row) => row.platform)).toEqual(['amazon', 'amazon']);
    expect(JSON.stringify(records.results)).not.toMatch(/PRIVATE_BUYER|PRIVATE_RECIPIENT/u);
    expect(await db.prepare('SELECT COUNT(*) AS total FROM purchase_demands').first('total')).toBe(0);
  });

  it('Amazon 拒绝旧令牌后从同一窗口重读，店铺换身份不覆盖原绑定', async () => {
    const graph = order('113-0000001-0000001');
    const source = {
      verifyOrder: vi.fn(async () => {}),
      searchOrders: vi.fn()
        .mockResolvedValueOnce({ nodes: [graph], hasNextPage: true, endCursor: 'expiring-token' })
        .mockRejectedValueOnce(new AmazonConnectorError('AMAZON_PAGE_TOKEN_REJECTED'))
        .mockResolvedValueOnce(singlePage([graph])),
    };
    const run = (store: AmazonStoreConfig, start?: string) => runAmazonOrderSync({
      db, tenantId, config: store, now: () => new Date(initial), source,
      request: { storeKey: store.key, from: start, maxPages: 1 },
    });
    expect(await run(config, from)).toMatchObject({ complete: false });
    expect(await run(config)).toMatchObject({ complete: false, code: 'AMAZON_PAGE_TOKEN_RESTART' });
    expect(await run(config)).toMatchObject({ complete: true, stats: { ordersUnchanged: 1 } });
    expect(source.searchOrders.mock.calls.map((args) => args[0])).toEqual([
      { since: from, until, cursor: null }, { since: from, until, cursor: 'expiring-token' }, { since: from, until, cursor: null },
    ]);
    await expect(run({ ...config, sellerId: 'SELLER0002' }, from)).rejects.toMatchObject({ code: 'AMAZON_STORE_BINDING_CONFLICT' });
    expect(await db.prepare("SELECT official_store_id FROM platform_stores WHERE platform='amazon'").first('official_store_id')).toBe(config.sellerId);
  });

  it('定时入口要求单独的内部密钥和启用配置，已配置未核验的店铺不发起调用', async () => {
    const token = 'test-internal-job-token-that-is-long-enough';
    const settings = { ...configEnv, DB: db, ERP_INTERNAL_JOB_TOKEN: token, ERP_AMAZON_RECONCILE_ENABLED: 'true' };
    const request = (authorization?: string) => new Request('https://erp.example.test/api/connectors/amazon/reconcile', {
      method: 'POST', headers: authorization ? { Authorization: authorization } : undefined,
    });
    const sync = vi.fn<typeof runAmazonOrderSync>();
    expect((await handleAmazonReconcile(request(), settings, sync)).status).toBe(401);
    expect((await handleAmazonReconcile(request(`Bearer ${token}`), { ...settings, ERP_AMAZON_RECONCILE_ENABLED: 'false' }, sync)).status).toBe(409);
    const reply = await handleAmazonReconcile(request(`Bearer ${token}`), settings, sync);
    expect(reply.status).toBe(207);
    expect(await reply.json()).toMatchObject({ ok: false, results: [{ storeKey: config.key, code: 'AMAZON_INITIAL_RANGE_REQUIRED' }] });
    expect(sync).not.toHaveBeenCalled();
  });
});
