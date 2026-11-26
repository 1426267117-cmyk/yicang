import { readdirSync, readFileSync } from 'node:fs';
import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { UserContext } from '../lib/db';
import { ROLE_PERMISSIONS } from '../lib/domain';
import { createPurchaseSku, findPurchaseSkus, updatePurchaseSku } from '../lib/purchase-sku-service';

vi.mock('cloudflare:workers', () => ({ env: {} }));

const user: UserContext = {
  id: 'buyer', email: 'buyer@example.invalid', displayName: '采购员', role: 'operator',
  permissions: ROLE_PERMISSIONS.operator, tenantId: 'guangzhou', tenantName: '广州采购',
};
const otherTenant = { ...user, tenantId: 'shenzhen', tenantName: '深圳采购' };
const now = '2026-11-24T00:00:00.000Z';

describe('独立 ERP SKU 建档', () => {
  let mf: Miniflare;
  let db: D1Database;

  beforeAll(async () => {
    mf = new Miniflare({ modules: true, script: 'export default { fetch(){ return new Response("ok") } }', d1Databases: ['DB'] });
    db = await mf.getD1Database('DB');
    const migrations = new URL('../drizzle/', import.meta.url);
    for (const file of readdirSync(migrations).filter((name) => name.endsWith('.sql')).sort()) {
      const sql = readFileSync(new URL(file, migrations), 'utf8');
      const statements = sql.split('--> statement-breakpoint').map((line) => line.trim()).filter(Boolean);
      await db.batch(statements.map((statement) => db.prepare(statement)));
    }
    await db.prepare('INSERT INTO tenants (id, name, created_at) VALUES (?, ?, ?), (?, ?, ?)')
      .bind(user.tenantId, user.tenantName, now, otherTenant.tenantId, otherTenant.tenantName, now).run();
  });

  afterAll(async () => { await mf.dispose(); });

  it('并发重试只保存一个规范化 SKU 和一条审计，换参数拒绝原幂等键', async () => {
    const key = 'create-sku-0001';
    const results = await Promise.all([
      createPurchaseSku(db, user, { code: ' GZ-CHAIR ', name: ' 办公椅 ' }, key),
      createPurchaseSku(db, user, { code: 'gz-chair', name: '办公椅' }, key),
    ]);
    expect(results.map((item) => item.replayed).sort()).toEqual([false, true]);
    expect(results[0].sku).toEqual(results[1].sku);
    expect(results[0].sku).toMatchObject({ code: 'GZ-CHAIR', name: '办公椅' });

    await expect(createPurchaseSku(db, user, { code: 'GZ-DESK', name: '办公桌' }, key))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await expect(createPurchaseSku(db, user, { code: 'gz-chair', name: '另一个名称' }, 'create-sku-0002'))
      .rejects.toMatchObject({ code: 'PURCHASE_SKU_CODE_EXISTS' });
    const audit = await db.prepare('SELECT action, actor_email FROM audit_logs WHERE tenant_id = ? AND entity_id = ?')
      .bind(user.tenantId, results[0].sku.id).all();
    expect(audit.results).toEqual([{ action: 'CREATE_PURCHASE_SKU', actor_email: user.email }]);
    expect(await findPurchaseSkus(db, user, 'GZ-DESK')).toEqual([]);
  });

  it('同编码可以分属不同工作区，保留已有停用 SKU，并拒绝只读角色建档', async () => {
    const input = { code: 'SHARED-CODE', name: '货品' };
    const key = 'create-company-sku';
    const local = await createPurchaseSku(db, user, input, key);
    const external = await createPurchaseSku(db, otherTenant, input, key);
    expect(local.sku.id).not.toBe(external.sku.id);
    await db.prepare('UPDATE skus SET active = 0 WHERE tenant_id = ? AND id = ?')
      .bind(user.tenantId, local.sku.id).run();
    await expect(createPurchaseSku(db, user, input, 'create-disabled-sku'))
      .rejects.toMatchObject({ code: 'PURCHASE_SKU_INACTIVE' });
    await expect(createPurchaseSku(db, { ...user, role: 'viewer', permissions: ROLE_PERMISSIONS.viewer }, input, 'create-viewer-sku'))
      .rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    expect(await findPurchaseSkus(db, user, input.code)).toEqual([]);
    expect(await findPurchaseSkus(db, otherTenant, input.code)).toEqual([external.sku]);
  });

  it('检索从当前工作区查找编码和名称，完整编码排在包含匹配之前', async () => {
    const results = await Promise.all([
      createPurchaseSku(db, user, { code: 'Z_%', name: '蓝色显示器' }, 'create-match-exact'),
      createPurchaseSku(db, user, { code: 'A-Z_%-2', name: '显示器支架' }, 'create-match-contained'),
      createPurchaseSku(db, user, { code: 'ZA1', name: '不含匹配字符' }, 'create-avoid-wildcard'),
    ]);
    expect(await findPurchaseSkus(db, user, ' z_% ')).toEqual([results[0].sku, results[1].sku]);
    expect(await findPurchaseSkus(db, user, '蓝色')).toEqual([results[0].sku]);
    expect(await findPurchaseSkus(db, otherTenant, '蓝色')).toEqual([]);
  });

  it('保存并局部编辑采购商品资料，保留其它字段和租户隔离', async () => {
    const { sku } = await createPurchaseSku(db, user, {
      code: 'GZ-SPEC-42', name: '装配椅',
      productDetails: { specification: '蓝色布艺', dimensions: '64 × 62 cm', imageUrl: 'https://example.invalid/chair.jpg', description: '送装配工具' },
    }, 'create-sku-details');
    expect(sku.productDetails).toEqual({
      name: '装配椅', specification: '蓝色布艺', dimensions: '64 × 62 cm', imageUrl: 'https://example.invalid/chair.jpg', description: '送装配工具',
    });
    await expect(updatePurchaseSku(db, otherTenant, sku.id, { name: '跨租户' }))
      .rejects.toMatchObject({ code: 'PURCHASE_SKU_UNAVAILABLE' });
    const { sku: updated } = await updatePurchaseSku(db, user, sku.id, {
      name: '办公装配椅', specification: '深蓝色布艺', imageUrl: null,
    });
    expect(updated.productDetails).toEqual({
      name: '办公装配椅', specification: '深蓝色布艺', dimensions: '64 × 62 cm', imageUrl: null, description: '送装配工具',
    });
    expect(await findPurchaseSkus(db, user, 'GZ-SPEC-42')).toEqual([updated]);
    expect(await db.prepare(`
      SELECT json_extract(before_json, '$.productDetails.imageUrl') AS image_before,
        json_extract(after_json, '$.productDetails.specification') AS specification_after
      FROM audit_logs WHERE action = 'UPDATE_PURCHASE_SKU' AND tenant_id = ? AND entity_id = ?
    `).bind(user.tenantId, sku.id).first()).toEqual({
      image_before: 'https://example.invalid/chair.jpg', specification_after: '深蓝色布艺',
    });
  });
});
