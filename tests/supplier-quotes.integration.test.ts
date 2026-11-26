import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET, POST } from '../app/api/purchase/quotes/route';
import { openSqliteD1 } from '../lib/aws/sqlite-d1';
import type { UserContext } from '../lib/db';
import { ROLE_PERMISSIONS } from '../lib/domain';
import { createSupplier } from '../lib/purchase-order-service';
import { createPurchaseSku } from '../lib/purchase-sku-service';
import type { SupplierQuoteBook, SupplierQuoteWrite } from '../lib/supplier-quotes';

const { requestContext } = vi.hoisted(() => ({ requestContext: vi.fn() }));
vi.mock('cloudflare:workers', () => ({ env: {} }));
vi.mock('../lib/db', async (original) => ({ ...await original<typeof import('../lib/db')>(), requestContext }));

const now = '2026-11-25T04:00:00.000Z';
const endpoint = 'https://erp.example.invalid/api/purchase/quotes';
const operator: UserContext = {
  id: 'quote-operator', email: 'quote-operator@example.invalid', displayName: '报价测试账号', role: 'operator',
  permissions: ROLE_PERMISSIONS.operator, tenantId: 'quote-tenant', tenantName: '报价测试工作区',
};
const outside: UserContext = { ...operator, id: 'quote-outside', tenantId: 'quote-outside-tenant' };

describe('采购供应商报价', () => {
  let sqlite: ReturnType<typeof openSqliteD1>;
  let skuId: string;
  let supplierA: string;
  let supplierB: string;
  let foreignSupplier: string;

  function signIn(user: UserContext) {
    requestContext.mockResolvedValue({ db: sqlite.db, user });
  }

  function get(extra: Record<string, string> = {}) {
    return GET(new Request(`${endpoint}?${new URLSearchParams({ skuId, ...extra })}`));
  }

  function publish(fields: Partial<Extract<SupplierQuoteWrite, { action: 'publish' }>> = {}) {
    return { action: 'publish', skuId, supplierId: supplierA, currency: 'USD', expectedVersion: 0,
      validFrom: '2026-11-01', validThrough: '2026-12-31', reference: 'TEST-QUOTE-A', tiers: [
        { minimumQuantity: 5, unitCostMinor: 1000 }, { minimumQuantity: 20, unitCostMinor: 850 },
      ], ...fields } as const;
  }

  function submit(body: object, key: string) {
    return POST(new Request(endpoint, { method: 'POST', headers: { 'Idempotency-Key': key }, body: JSON.stringify(body) }));
  }

  async function readBook(extra: Record<string, string> = {}) {
    const response = await get(extra);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    return await response.json() as SupplierQuoteBook;
  }

  beforeEach(async () => {
    vi.setSystemTime(new Date(now));
    sqlite = openSqliteD1(':memory:', resolve('drizzle'));
    for (const user of [operator, outside]) {
      await sqlite.db.batch([
        sqlite.db.prepare('INSERT INTO tenants (id, name, created_at) VALUES (?, ?, ?)').bind(user.tenantId, user.tenantName, now),
        sqlite.db.prepare(`INSERT INTO members (id, tenant_id, auth_user_id, email, display_name, role, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(user.id, user.tenantId, user.id, user.email, user.displayName, user.role, now),
      ]);
    }
    const { sku } = await createPurchaseSku(sqlite.db, operator, { code: 'QUOTE-TEST-SKU', name: '报价测试商品' }, 'quote-test-create-sku');
    skuId = sku.id;
    supplierA = (await createSupplier(sqlite.db, operator, { code: 'QUOTE-A', name: '测试供应商 A' }, 'quote-test-create-a')).supplier.id;
    supplierB = (await createSupplier(sqlite.db, operator, { code: 'QUOTE-B', name: '测试供应商 B' }, 'quote-test-create-b')).supplier.id;
    foreignSupplier = (await createSupplier(sqlite.db, outside, { code: 'QUOTE-OUT', name: '其他工作区' }, 'quote-test-create-out')).supplier.id;
    signIn(operator);
  });

  afterEach(() => { vi.useRealTimers(); sqlite?.close(); });

  it('按同一 SKU 和数量比较多供应商同币报价，并保留原币、起订量及精确总金额', async () => {
    expect((await submit(publish(), 'quote-publish-shop-a')).status).toBe(201);
    const singleTier = [{ minimumQuantity: 1, unitCostMinor: 799 }];
    expect((await submit(publish({ supplierId: supplierB, tiers: singleTier }), 'quote-publish-shop-b')).status).toBe(201);
    expect((await submit(publish({ supplierId: supplierA, currency: 'CNY' }), 'quote-publish-shop-a-yuan')).status).toBe(201);

    const comparison = await readBook({ quantity: '25' });
    expect(comparison.today).toBe('2026-11-25');
    expect(comparison.quotes.map(({ supplier, currency, matchedTier, totalMinor }) => [supplier.id, currency, matchedTier?.unitCostMinor, totalMinor]))
      .toEqual([[supplierA, 'CNY', 850, '21250'], [supplierB, 'USD', 799, '19975'], [supplierA, 'USD', 850, '21250']]);
    expect((await readBook({ supplierId: supplierA, currency: 'usd', quantity: '4' })).quotes)
      .toMatchObject([{ status: 'below_minimum', matchedTier: null }]);
    expect((await readBook({ supplierId: supplierA, currency: 'USD', quantity: String(Number.MAX_SAFE_INTEGER) })).quotes)
      .toMatchObject([{ totalMinor: (BigInt(Number.MAX_SAFE_INTEGER) * BigInt(850)).toString() }]);
  });

  it('待生效修订保留现行价格，生效后择新，停用记录阻止旧价回流', async () => {
    expect((await submit(publish(), 'quote-initial-current')).status).toBe(201);
    const future = publish({ expectedVersion: 1, validFrom: '2026-12-01', validThrough: '2026-12-10', reference: 'TEST-QUOTE-FUTURE',
      tiers: [{ minimumQuantity: 5, unitCostMinor: 675 }] });
    expect((await submit(future, 'quote-scheduled-new')).status).toBe(201);
    const params = { supplierId: supplierA, currency: 'USD', quantity: '10' };
    expect((await readBook(params)).quotes).toMatchObject([{ status: 'scheduled', version: 2,
      matchedVersion: 1, matchedReference: 'TEST-QUOTE-A', matchedTier: { unitCostMinor: 1000 } }]);
    vi.setSystemTime(new Date('2026-11-30T16:00:00Z'));
    expect((await readBook(params)).quotes).toMatchObject([{ status: 'available', matchedVersion: 2,
      matchedTier: { unitCostMinor: 675 } }]);
    vi.setSystemTime(new Date('2026-12-10T16:00:00Z'));
    expect((await readBook(params)).quotes).toMatchObject([{ status: 'expired', matchedTier: null }]);
    expect((await submit({ action: 'archive', skuId, supplierId: supplierA, currency: 'USD', expectedVersion: 2, reason: '测试报价停止' },
      'quote-archive-current')).status).toBe(201);
    expect((await readBook(params)).quotes).toMatchObject([{ status: 'archived', matchedTier: null }]);
    const futureRestart = publish({ expectedVersion: 3, validFrom: '2026-12-25' });
    expect((await submit(futureRestart, 'quote-schedule-restart')).status).toBe(201);
    expect((await readBook(params)).quotes).toMatchObject([{ status: 'scheduled', matchedTier: null, matchedVersion: null }]);
    expect((await readBook({ ...params, history: '1' })).quotes.map(({ version }) => version)).toEqual([4, 3, 2, 1]);
  });

  it('授权隔离、严格输入、并发 CAS 与引用重放均在 API 核验', async () => {
    signIn({ ...operator, role: 'viewer', permissions: ROLE_PERMISSIONS.viewer });
    expect((await get()).status).toBe(403);
    expect((await submit(publish(), 'quote-denied-viewer')).status).toBe(403);
    signIn(outside);
    expect((await get()).status).toBe(404);
    signIn(operator);
    expect((await submit(publish({ supplierId: foreignSupplier }), 'quote-denied-cross-tenant')).status).toBe(404);
    expect((await submit(publish({ validThrough: '2026-10-01' }), 'quote-invalid-date')).status).toBe(400);
    expect((await submit(publish({ tiers: [{ minimumQuantity: 1, unitCostMinor: 2 }, { minimumQuantity: 1, unitCostMinor: 1 }] }),
      'quote-invalid-tiers')).status).toBe(400);
    const replies = await Promise.all([
      submit(publish(), 'quote-concurrent-first'), submit(publish(), 'quote-concurrent-first'),
    ]);
    expect(replies.map((response) => response.status).sort()).toEqual([200, 201]);
    const edits = await Promise.all([
      submit(publish({ expectedVersion: 1, reference: 'QUOTE-REVISE-01' }), 'quote-concurrent-edit-a'),
      submit(publish({ expectedVersion: 1, reference: 'QUOTE-REVISE-02' }), 'quote-concurrent-edit-b'),
    ]);
    expect(edits.map((response) => response.status).sort()).toEqual([201, 409]);
    expect((await submit(publish({ reference: 'DIFFERENT-USED-KEY' }), 'quote-concurrent-first')).status).toBe(409);
    expect(await sqlite.db.prepare("SELECT COUNT(*) AS total FROM audit_logs WHERE entity_type = 'purchase_supplier_quote'").first('total')).toBe(2);
  });
});
