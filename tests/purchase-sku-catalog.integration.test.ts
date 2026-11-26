import { fileURLToPath } from 'node:url';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PATCH } from '../app/api/purchase/skus/[id]/route';
import { GET } from '../app/api/purchase/skus/catalog/route';
import { openSqliteD1 } from '../lib/aws/sqlite-d1';
import * as runtime from '../lib/db';
import { ROLE_PERMISSIONS } from '../lib/domain';
import type { SkuCatalogPage } from '../lib/purchase-sku-catalog';
import { runSkuImport } from '../lib/purchase-sku-import';
import { readSkuImportWorkbook } from '../lib/purchase-sku-import-workbook';
import { findPurchaseSkus } from '../lib/purchase-sku-service';

vi.mock('cloudflare:workers', () => ({ env: {} }));

const operator: runtime.UserContext = {
  id: 'buyer', email: 'buyer@example.invalid', displayName: '采购员', role: 'operator',
  permissions: ROLE_PERMISSIONS.operator, tenantId: 'guangzhou', tenantName: '广州采购',
};
const viewer: runtime.UserContext = { ...operator, role: 'viewer', permissions: ROLE_PERMISSIONS.viewer };
const endpoint = 'http://localhost/api/purchase/skus';

describe('采购商品档案', () => {
  let sqlite: ReturnType<typeof openSqliteD1>;
  let db: D1Database;

  beforeEach(async () => {
    sqlite = openSqliteD1(':memory:', fileURLToPath(new URL('../drizzle', import.meta.url)));
    db = sqlite.db;
    await db.prepare(`INSERT INTO tenants (id, name, created_at) VALUES
      ('guangzhou', '广州采购', '2026-11-25'), ('shenzhen', '深圳采购', '2026-11-25')`).run();
    await db.prepare(`INSERT INTO skus (id, tenant_id, code, name, specification, dimensions, image_url, description, active, created_at)
      VALUES ('complete', 'guangzhou', 'COM-01', '完整商品', '原规格', '120 cm', 'https://example.invalid/image.webp', '商品描述', 1, '2026-11-25'),
        ('incomplete', 'guangzhou', '0001_%', '定制 A < B & C', '原规格', ?, NULL, NULL, 1, '2026-11-25'),
        ('external', 'shenzhen', '0001_%', '深圳资料', NULL, NULL, NULL, NULL, 1, '2026-11-25'),
        ('inactive', 'guangzhou', 'STOP-01', '已停用', NULL, NULL, NULL, NULL, 0, '2026-11-25')`).bind('\t\u3000').run();
    vi.spyOn(runtime, 'requestContext').mockResolvedValue({ db, user: operator });
  });

  afterEach(() => { vi.restoreAllMocks(); sqlite.close(); });

  async function loadCatalog(query = '') {
    const response = await GET(new Request(`${endpoint}/catalog${query}`));
    expect(response.status).toBe(200);
    return await response.json() as SkuCatalogPage;
  }

  async function editSku(id: string, specification: string, expectedRevision: string) {
    return PATCH(new Request(`${endpoint}/${id}`, {
      method: 'PATCH', body: JSON.stringify({ productDetails: { specification }, expectedRevision }),
    }), { params: Promise.resolve({ id }) });
  }

  it('只在当前工作区分页和按缺失字段筛选，旧搜索仍返回 40 条以内', async () => {
    const inserts = Array.from({ length: 50 }, (_, index) => db.prepare(`INSERT INTO skus
      (id, tenant_id, code, name, active, created_at) VALUES (?, 'guangzhou', ?, '分页样品', 1, '2026-11-25')`)
      .bind(`fixture-${index}`, `PAGE-${String(index).padStart(2, '0')}`));
    await db.batch(inserts);
    expect(await loadCatalog('?page=1')).toMatchObject({ total: 52, page: 1 });
    const second = await loadCatalog('?page=2');
    expect(second.skus.map(sku => sku.code)).toEqual(['PAGE-48', 'PAGE-49']);
    expect((await findPurchaseSkus(db, operator, '')).length).toBe(40);
    const incomplete = await loadCatalog('?q=%25&filter=dimensions');
    expect(incomplete).toMatchObject({ total: 1, skus: [{ id: 'incomplete', missingFields: ['dimensions', 'imageUrl', 'description'] }] });
    expect(await loadCatalog('?q=定制&filter=specification')).toMatchObject({ total: 0, skus: [] });
    expect(await loadCatalog('?filter=complete')).toMatchObject({ total: 1, skus: [{ id: 'complete', missingFields: [] }] });
    expect((await GET(new Request(`${endpoint}/catalog?page=0&filter=unexpected`))).status).toBe(400);
  });

  it('保护档案编辑权限，拒绝旧版本覆盖新资料', async () => {
    vi.mocked(runtime.requestContext).mockResolvedValue({ db, user: viewer });
    const { skus: [sku] } = await loadCatalog('?q=0001_%25');
    expect(sku.code).toBe('0001_%');
    expect((await editSku(sku.id, '拒绝只读编辑', sku.revision)).status).toBe(403);
    expect((await GET(new Request(`${endpoint}/catalog?format=xlsx`))).status).toBe(403);
    vi.mocked(runtime.requestContext).mockResolvedValue({ db, user: operator });
    expect((await editSku(sku.id, '新规格', sku.revision)).status).toBe(200);
    expect((await editSku(sku.id, '旧表单覆盖', sku.revision)).status).toBe(409);
    const current = await loadCatalog('?q=0001_%25');
    expect(current.skus[0].productDetails.specification).toBe('新规格');
    expect(current.skus[0].revision).not.toBe(sku.revision);
  });

  it('本页补录表可回读并导入，只应用新填的字段', async () => {
    const response = await GET(new Request(`${endpoint}/catalog?q=0001_%25&format=xlsx`));
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Disposition')).toContain('sku-completion-page-1.xlsx');
    const bytes = new Uint8Array(await response.arrayBuffer());
    const readback = await readSkuImportWorkbook(bytes);
    expect(readback).toMatchObject({ sheetName: '商品资料', rows: [{ code: '0001_%', fields: {}, errors: [] }] });
    const key = (await loadCatalog('?q=0001_%25')).skus[0].revision;
    expect((await editSku('incomplete', '导出后更新的规格', key)).status).toBe(200);
    expect(await runSkuImport(db, operator, bytes, 'preview')).toMatchObject({ counts: { unchanged: 1, update: 0, error: 0 } });

    const workbook = unzipSync(bytes);
    const worksheet = 'xl/worksheets/sheet1.xml';
    workbook[worksheet] = strToU8(strFromU8(workbook[worksheet]).replace('</row></sheetData>',
      '<c r="F2" t="inlineStr"><is><t>120 × 60 cm</t></is></c></row></sheetData>'));
    const completed = new Uint8Array(zipSync(workbook));
    const preview = await runSkuImport(db, operator, completed, 'preview');
    expect(preview).toMatchObject({ counts: { update: 1, error: 0 }, rows: [{ changedFields: ['尺寸'] }] });
    expect(preview).toHaveProperty('previewKey');
    if (!('previewKey' in preview)) throw new Error('未生成预览');
    expect(await runSkuImport(db, operator, completed, 'apply', preview.previewKey)).toMatchObject({ updated: 1 });
    expect((await loadCatalog('?q=0001_%25')).skus[0].productDetails).toMatchObject({
      specification: '导出后更新的规格', dimensions: '120 × 60 cm',
    });
  });
});
