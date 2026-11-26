import { fileURLToPath } from 'node:url';
import { strToU8, zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({ env: {} }));

import { POST } from '../app/api/purchase/skus/import/route';
import { openSqliteD1 } from '../lib/aws/sqlite-d1';
import * as runtime from '../lib/db';
import { ROLE_PERMISSIONS } from '../lib/domain';
import { runSkuImport } from '../lib/purchase-sku-import';
import { readSkuImportWorkbook } from '../lib/purchase-sku-import-workbook';

const tenantId = 'tenant-a';
const operator: runtime.UserContext = {
  id: 'buyer-1', email: 'buyer@example.invalid', displayName: '业务操作员',
  role: 'operator', permissions: ROLE_PERMISSIONS.operator, tenantId, tenantName: '采购工作区',
};
const headings = ['SKU编码', '商品名称', '规格', '尺寸', '图片链接', '商品介绍'];

describe('SKU Excel batch import', () => {
  let sqlite: ReturnType<typeof openSqliteD1>;
  let db: D1Database;

  beforeEach(async () => {
    sqlite = openSqliteD1(':memory:', fileURLToPath(new URL('../drizzle', import.meta.url)));
    db = sqlite.db;
    await db.prepare(`INSERT INTO tenants (id, name, created_at) VALUES (?, ?, ?), (?, ?, ?)`)
      .bind(tenantId, '采购甲', '2026-11-25', 'tenant-b', '采购乙', '2026-11-25').run();
    await db.prepare(`INSERT INTO skus (id, tenant_id, code, name, specification, dimensions, image_url, description, active, created_at)
      VALUES ('sku-old', ?, 'OLD-01', '现有桌', '实木', '120×60', 'https://example.invalid/old.png', '原介绍', 1, '2026-11-25'),
        ('sku-other', 'tenant-b', 'OLD-01', '他公司桌', NULL, NULL, NULL, NULL, 1, '2026-11-25'),
        ('sku-disabled', ?, 'STOP-01', '停用桌', NULL, NULL, NULL, NULL, 0, '2026-11-25')`).bind(tenantId, tenantId).run();
    vi.spyOn(runtime, 'requestContext').mockResolvedValue({ db, user: operator });
  });

  afterEach(() => { vi.restoreAllMocks(); sqlite?.close(); });

  async function upload(file: Uint8Array<ArrayBuffer>, intent: 'preview' | 'apply', key?: string) {
    const form = new FormData();
    form.set('file', new File([file], '商品资料.xlsx'));
    form.set('intent', intent);
    if (key) form.set('previewKey', key);
    return POST(new Request('http://localhost/api/purchase/skus/import', { method: 'POST', body: form }));
  }

  async function preview(file: Uint8Array<ArrayBuffer>) {
    const response = await upload(file, 'preview');
    const body = await response.json() as {
      ok: boolean; previewKey: string; sheetName: string; rows: Array<Record<string, unknown>>;
      counts: { new: number; update: number; unchanged: number; error: number };
    };
    expect(body).toMatchObject({ ok: true });
    return body;
  }

  it('previews before writing, preserves blanks, scopes merge by company, and idempotently records the batch', async () => {
    const file = workbook({ 商品资料: [headings, ['old-01', '', '', '', '', '更新后的介绍'], [], ['00014', '新桌', '', '140×70']] });
    const result = await preview(file);
    expect(result.counts).toEqual({ new: 1, update: 1, unchanged: 0, error: 0 });
    expect(result.rows).toMatchObject([
      { rowNumber: 2, code: 'OLD-01', changedFields: ['商品介绍'], missingFields: [], status: 'update' },
      { rowNumber: 4, code: '00014', changedFields: ['商品名称', '尺寸'], missingFields: ['规格', '图片链接', '商品介绍'], status: 'new' },
    ]);
    expect(await db.prepare('SELECT count(*) AS count FROM audit_logs').first('count')).toBe(0);
    expect(await db.prepare("SELECT description FROM skus WHERE id = 'sku-old'").first('description')).toBe('原介绍');

    const attempts = await Promise.all([upload(file, 'apply', result.previewKey), upload(file, 'apply', result.previewKey)]);
    expect(attempts.map(response => response.status)).toEqual([200, 200]);
    const outcomes = await Promise.all(attempts.map(async response => await response.json() as { replayed: boolean }));
    expect(outcomes.map(outcome => outcome.replayed).sort()).toEqual([false, true]);
    expect(outcomes[0]).toMatchObject({ ok: true, created: 1, updated: 1, unchanged: 0 });
    expect(await db.prepare("SELECT name, specification, dimensions, image_url, description FROM skus WHERE id = 'sku-old'").first())
      .toEqual({ name: '现有桌', specification: '实木', dimensions: '120×60', image_url: 'https://example.invalid/old.png', description: '更新后的介绍' });
    expect(await db.prepare("SELECT name FROM skus WHERE id = 'sku-other'").first('name')).toBe('他公司桌');
    expect(await db.prepare("SELECT code FROM skus WHERE tenant_id = ? AND code = '00014'").bind(tenantId).first('code')).toBe('00014');
    expect(await db.prepare('SELECT count(*) AS count FROM audit_logs').first('count')).toBe(3);
    const recheck = await preview(file);
    expect(recheck.counts).toEqual({ new: 0, update: 0, unchanged: 2, error: 0 });
  });

  it('rejects confirmation if the workbook or observed SKU changed after preview', async () => {
    const file = workbook({ 商品资料: [headings, ['OLD-01', '导入名称'], ['N-1', '新品']] });
    const result = await preview(file);
    const changedFile = workbook({ 商品资料: [headings, ['OLD-01', '另一份文件']] });
    expect((await upload(changedFile, 'apply', result.previewKey)).status).toBe(409);
    await db.prepare("UPDATE skus SET description = '人工更新' WHERE id = 'sku-old'").run();
    expect(await (await upload(file, 'apply', result.previewKey)).json()).toMatchObject({ code: 'SKU_IMPORT_PREVIEW_STALE' });
    expect(await db.prepare("SELECT count(*) AS count FROM skus WHERE code = 'N-1'").first('count')).toBe(0);
    expect(await db.prepare('SELECT count(*) AS count FROM audit_logs').first('count')).toBe(0);
  });

  it('aborts the whole transaction if a concurrent request changes reviewed values before the batch', async () => {
    const file = workbook({ 商品资料: [headings, ['N-1', '新品'], ['OLD-01', '导入名称']] });
    const result = await preview(file);
    const raced = {
      prepare: db.prepare.bind(db),
      async batch(statements: D1PreparedStatement[]) {
        await db.prepare("UPDATE skus SET dimensions = '并发编辑' WHERE id = 'sku-old'").run();
        return db.batch(statements);
      },
    } as D1Database;
    await expect(runSkuImport(raced, operator, file, 'apply', result.previewKey))
      .rejects.toMatchObject({ status: 409, code: 'SKU_IMPORT_PREVIEW_STALE' });
    expect(await db.prepare("SELECT count(*) AS count FROM skus WHERE code = 'N-1'").first('count')).toBe(0);
    expect(await db.prepare("SELECT name, dimensions FROM skus WHERE id = 'sku-old'").first()).toEqual({ name: '现有桌', dimensions: '并发编辑' });
    expect(await db.prepare('SELECT count(*) AS count FROM audit_logs').first('count')).toBe(0);
  });

  it('shows blocking row validation errors without mutating catalog rows or audit logs', async () => {
    const file = workbook({ 商品资料: [headings,
      ['dup-01', '重复甲'], ['DUP-01', '重复乙'], ['STOP-01', '停用'], ['NEW'], [123, '数字型编码'],
      ['BAD-URL', '禁用链接', '', '', 'javascript:alert(3)'],
      ['OLD-01', '', '', '', '/api/purchase/product-images/' + 'f'.repeat(64)],
    ] });
    const result = await preview(file);
    expect(result.counts.error).toBe(7);
    expect(result.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'DUP-01', errors: expect.arrayContaining(['同一文件内 SKU 编码重复']) }),
      expect.objectContaining({ code: 'STOP-01', errors: expect.arrayContaining(['ERP 中同编码的 SKU 已停用']) }),
      expect.objectContaining({ code: 'NEW', errors: expect.arrayContaining(['新增 SKU 必须填写商品名称']) }),
      expect.objectContaining({ code: '', errors: expect.arrayContaining(['SKU 编码请使用文本格式，以保留前导零']) }),
      expect.objectContaining({ code: 'OLD-01', errors: expect.arrayContaining(['找不到当前工作区对应的已上传图片']) }),
    ]));
    expect((await upload(file, 'apply', result.previewKey)).status).toBe(400);
    expect(await db.prepare('SELECT count(*) AS count FROM audit_logs').first('count')).toBe(0);
  });

  it('rejects formula cells and multiple nonempty sheets and honors an empty extra sheet', async () => {
    const sheet = [headings, ['N-1', '新品']];
    await expect(readSkuImportWorkbook(workbook({ 商品资料: sheet, 第二批: sheet })))
      .rejects.toThrow('第二批');
    await expect(readSkuImportWorkbook(workbook({ 商品资料: sheet, 空白: [] })))
      .resolves.toMatchObject({ sheetName: '商品资料', rows: [{ code: 'N-1' }] });
    await expect(readSkuImportWorkbook(workbook({ 商品资料: [headings, ['N-1', { formula: '3+4' }]] })))
      .rejects.toThrow('包含公式');
  });

  it('imports the maximum batch with long descriptions across all write chunks', async () => {
    const rows = Array.from({ length: 500 }, (_, index) => [`SKU-${index}`, `商品${index}`, '', '', '', '采购商品'.repeat(300)]);
    const file = workbook({ 商品资料: [headings, ...rows] });
    const result = await preview(file);
    expect(result.counts.new).toBe(500);
    expect(await (await upload(file, 'apply', result.previewKey)).json()).toEqual({
      ok: true, created: 500, updated: 0, unchanged: 0, replayed: false,
    });
    expect(await db.prepare("SELECT count(*) AS count FROM skus WHERE code LIKE 'SKU-%' AND length(description) = 1200")
      .first('count')).toBe(500);
    expect(await db.prepare('SELECT count(*) AS count FROM audit_logs').first('count')).toBe(501);
    const oversized = workbook({ 商品资料: [headings, ...rows, ['SKU-extra', '超限产品']] });
    await expect(readSkuImportWorkbook(oversized)).rejects.toThrow('最多导入 500 行');
  });

  it('requires mapping permission before both preview and apply', async () => {
    const file = workbook({ 商品资料: [headings, ['N-1', '新品']] });
    const result = await preview(file);
    vi.spyOn(runtime, 'requestContext').mockResolvedValue({ db, user: { ...operator, permissions: ROLE_PERMISSIONS.viewer, role: 'viewer' } });
    expect((await upload(file, 'preview')).status).toBe(403);
    expect((await upload(file, 'apply', result.previewKey)).status).toBe(403);
  });
});

type TestCell = string | number | { formula: string };

function workbook(sheets: Record<string, TestCell[][]>) {
  const main = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const officeRel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const packageRel = 'http://schemas.openxmlformats.org/package/2006/relationships';
  const sheetEntries = Object.entries(sheets);
  const xmlFiles: Record<string, string> = {
    '[Content_Types].xml': `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
      <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
      <Default Extension="xml" ContentType="application/xml"/>
      <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
      ${sheetEntries.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}
    </Types>`,
    '_rels/.rels': `<Relationships xmlns="${packageRel}"><Relationship Id="rId1" Type="${officeRel}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml': `<workbook xmlns="${main}" xmlns:r="${officeRel}"><sheets>${sheetEntries.map(([name], i) =>
      `<sheet name="${escapeXml(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<Relationships xmlns="${packageRel}">${sheetEntries.map((_, i) =>
      `<Relationship Id="rId${i + 1}" Type="${officeRel}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`,
  };
  for (const [index, [, rows]] of sheetEntries.entries()) {
    const contents = rows.map((columns, i) => {
      const row = i + 1;
      const cells = columns.map((cell, j) => {
        const address = `${String.fromCharCode(65 + j)}${row}`;
        if (typeof cell === 'number') return `<c r="${address}"><v>${cell}</v></c>`;
        if (typeof cell === 'object') return `<c r="${address}"><f>${escapeXml(cell.formula)}</f><v>7</v></c>`;
        return `<c r="${address}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(cell)}</t></is></c>`;
      }).join('');
      return `<row r="${row}">${cells}</row>`;
    }).join('');
    xmlFiles[`xl/worksheets/sheet${index + 1}.xml`] = `<worksheet xmlns="${main}"><sheetData>${contents}</sheetData></worksheet>`;
  }
  return zipSync(Object.fromEntries(Object.entries(xmlFiles).map(([path, contents]) => [path, strToU8(contents)])));
}

function escapeXml(value: string) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
}
