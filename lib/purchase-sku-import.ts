import { sha256Hex, stableId, stableJson } from './connectors/stable';
import { HttpError, requirePermission, type UserContext } from './db';
import { purchaseProductImagePath } from './purchase-product-details';
import {
  readSkuImportWorkbook,
  skuImportFieldLabels,
  skuImportFields,
  type SkuImportField,
} from './purchase-sku-import-workbook';

type ImportSkuRow = {
  id: string;
  code: string;
  name: string;
  specification: string | null;
  dimensions: string | null;
  image_url: string | null;
  description: string | null;
  active: number;
};

type SkuValues = Record<SkuImportField, string | null>;
type ImportStatus = 'new' | 'update' | 'unchanged' | 'error';
type PreviewRow = {
  rowNumber: number;
  code: string;
  name: string;
  status: ImportStatus;
  changedFields: string[];
  missingFields: string[];
  errors: string[];
  changes: Array<{ field: string; before: string | null; after: string | null }>;
};

type PlannedRow = {
  code: string;
  kind: ImportStatus;
  before: ImportSkuRow | null;
  after: SkuValues;
  id: string;
};

type ApplySummary = { created: number; updated: number; unchanged: number };

const importAction = 'IMPORT_PURCHASE_SKUS';
const importEntityType = 'sku_import';
const maxPlanChunkBytes = 192 * 1024;
const encoder = new TextEncoder();

export async function runSkuImport(db: D1Database, user: UserContext, bytes: Uint8Array<ArrayBuffer>,
  intent: 'preview' | 'apply', previousPreviewKey?: string) {
  requirePermission(user, 'purchase:mapping');
  const workbookHash = await hashWorkbook(bytes);
  const applying = intent === 'apply';
  if (applying && (!previousPreviewKey || !/^[0-9a-f]{64}$/u.test(previousPreviewKey))) {
    throw new HttpError(400, '请先生成导入预览', 'SKU_IMPORT_PREVIEW_REQUIRED');
  }
  const operationKey = applying ? `sku-import:${previousPreviewKey}` : null;
  if (operationKey) {
    const previous = await readImportReceipt(db, user, operationKey, workbookHash);
    if (previous) return { ...previous, replayed: true };
  }

  const { sheetName, rows } = await readSkuImportWorkbook(bytes);
  const { plan, previewRows, counts } = await planSkuImport(db, user, rows);
  const previewKey = await sha256Hex(stableJson({
    workbookHash, tenantId: user.tenantId, actorId: user.id, plan,
  }));
  if (!applying) return { previewKey, sheetName, rows: previewRows, counts };
  if (!operationKey) throw stalePreview();
  if (previewKey !== previousPreviewKey) {
    const prior = await readImportReceipt(db, user, operationKey, workbookHash);
    if (prior) return { ...prior, replayed: true };
    throw stalePreview();
  }
  if (counts.error) throw new HttpError(400, '请修正预览中的错误，再重新上传和预览', 'SKU_IMPORT_ROWS_INVALID');

  const summary = { created: counts.new, updated: counts.update, unchanged: counts.unchanged };
  if (!summary.created && !summary.updated) return { ...summary, replayed: false };
  try {
    await applySkuImport(db, user, operationKey, workbookHash, plan, summary);
  } catch (error) {
    const prior = await readImportReceipt(db, user, operationKey, workbookHash);
    if (prior) return { ...prior, replayed: true };
    if (error instanceof Error && /malformed JSON|UNIQUE constraint failed/iu.test(error.message)) throw stalePreview();
    throw error;
  }
  return { ...summary, replayed: false };
}

async function planSkuImport(db: D1Database, user: UserContext,
  rows: Awaited<ReturnType<typeof readSkuImportWorkbook>>['rows']) {
  const countsByCode = new Map<string, number>();
  const images = new Set<string>();
  for (const row of rows) {
    if (row.code) countsByCode.set(row.code, (countsByCode.get(row.code) ?? 0) + 1);
    if (row.fields.imageUrl?.startsWith(purchaseProductImagePath)) {
      images.add(row.fields.imageUrl.slice(purchaseProductImagePath.length));
    }
  }
  const [matches, allowedImages] = await Promise.all([
    db.prepare(`
      SELECT id, code, name, specification, dimensions, image_url, description, active FROM skus
      WHERE tenant_id = ? AND UPPER(code) IN (SELECT value FROM json_each(?))
    `).bind(user.tenantId, JSON.stringify([...countsByCode.keys()])).all<ImportSkuRow>(),
    images.size ? db.prepare(`
      SELECT id FROM purchase_product_images WHERE tenant_id = ? AND id IN (SELECT value FROM json_each(?))
    `).bind(user.tenantId, JSON.stringify([...images])).all<{ id: string }>() : null,
  ]);
  const availableImages = new Set(allowedImages?.results.map(row => row.id));
  const existingByCode = new Map<string, ImportSkuRow[]>();
  for (const row of matches.results) {
    const code = row.code.toUpperCase();
    const entries = existingByCode.get(code) ?? [];
    entries.push(row);
    existingByCode.set(code, entries);
  }

  const counts: Record<ImportStatus, number> = { new: 0, update: 0, unchanged: 0, error: 0 };
  const previewRows: PreviewRow[] = [];
  const plan: PlannedRow[] = [];
  for (const row of rows) {
    const current = existingByCode.get(row.code) ?? [];
    const before = current[0] ?? null;
    const previous = skuValues(before);
    const after = { ...previous, ...row.fields };
    const errors = [...row.errors];
    const image = row.fields.imageUrl;
    if ((countsByCode.get(row.code) ?? 0) > 1) errors.push('同一文件内 SKU 编码重复');
    if (current.length > 1) errors.push('ERP 内已有多个同编码档案，请先核对');
    if (before && before.active !== 1) errors.push('ERP 中同编码的 SKU 已停用');
    if (!before && !after.name) errors.push('新增 SKU 必须填写商品名称');
    if (image?.startsWith(purchaseProductImagePath) && !availableImages.has(image.slice(purchaseProductImagePath.length))) {
      errors.push('找不到当前工作区对应的已上传图片');
    }

    const changes = skuImportFields.filter(field => previous[field] !== after[field]).map(field => ({
      field: skuImportFieldLabels[field], before: previous[field], after: after[field],
    }));
    const status: ImportStatus = errors.length ? 'error' : !before ? 'new' : changes.length > 0 ? 'update' : 'unchanged';
    counts[status]++;
    previewRows.push({
      rowNumber: row.rowNumber, code: row.code, name: after.name ?? '', status,
      changedFields: changes.map(change => change.field), changes,
      missingFields: skuImportFields.filter(field => field !== 'name' && !after[field]?.trim()).map(field => skuImportFieldLabels[field]),
      errors,
    });
    plan.push({
      code: row.code, kind: status, before, after,
      id: before?.id ?? (status === 'new' ? await stableId('sku', user.tenantId, row.code) : ''),
    });
  }
  return { plan, previewRows, counts };
}

function skuValues(row: ImportSkuRow | null): SkuValues {
  return {
    name: row?.name ?? null,
    specification: row?.specification ?? null,
    dimensions: row?.dimensions ?? null,
    imageUrl: row?.image_url ?? null,
    description: row?.description ?? null,
  };
}

async function applySkuImport(db: D1Database, user: UserContext, key: string, workbookHash: string,
  plan: PlannedRow[], summary: ApplySummary) {
  const now = new Date().toISOString();
  // Recheck the reviewed values inside the same transaction as the writes. The invalid JSON branch
  // runs only if a SKU was created, altered, or removed after review, which aborts the whole batch.
  const guards = planChunks(plan).map(chunk => db.prepare(`
    SELECT CASE WHEN EXISTS (
      SELECT 1 FROM json_each(?) AS row
      LEFT JOIN skus AS sku ON sku.tenant_id = ? AND UPPER(sku.code) = json_extract(row.value, '$.code')
      WHERE sku.id IS NOT json_extract(row.value, '$.before.id')
        OR sku.code IS NOT json_extract(row.value, '$.before.code')
        OR sku.name IS NOT json_extract(row.value, '$.before.name')
        OR sku.active IS NOT json_extract(row.value, '$.before.active')
        OR sku.specification IS NOT json_extract(row.value, '$.before.specification')
        OR sku.dimensions IS NOT json_extract(row.value, '$.before.dimensions')
        OR sku.image_url IS NOT json_extract(row.value, '$.before.image_url')
        OR sku.description IS NOT json_extract(row.value, '$.before.description')
    ) THEN json_extract('SKU_IMPORT_STALE_PREVIEW', '$') END
  `).bind(chunk, user.tenantId));

  const actor = [user.tenantId, user.id, user.email];
  const batchId = crypto.randomUUID();
  const changes = planChunks(plan.filter(row => row.kind !== 'unchanged'));
  const writes = changes.flatMap(chunk => [
    db.prepare(`
      INSERT INTO skus (id, tenant_id, code, name, specification, dimensions, image_url, description, active, created_at)
      SELECT json_extract(value, '$.id'), ?, json_extract(value, '$.code'), json_extract(value, '$.after.name'),
        json_extract(value, '$.after.specification'), json_extract(value, '$.after.dimensions'),
        json_extract(value, '$.after.imageUrl'), json_extract(value, '$.after.description'), 1, ?
      FROM json_each(?) WHERE json_extract(value, '$.kind') = 'new'
    `).bind(user.tenantId, now, chunk),
    db.prepare(`
      UPDATE skus AS sku SET name = json_extract(item.value, '$.after.name'),
        specification = json_extract(item.value, '$.after.specification'), dimensions = json_extract(item.value, '$.after.dimensions'),
        image_url = json_extract(item.value, '$.after.imageUrl'), description = json_extract(item.value, '$.after.description')
      FROM json_each(?) AS item
      WHERE sku.tenant_id = ? AND sku.id = json_extract(item.value, '$.id') AND json_extract(item.value, '$.kind') = 'update'
    `).bind(chunk, user.tenantId),
    db.prepare(`
      INSERT INTO audit_logs (id, tenant_id, actor_id, actor_email, action, entity_type, entity_id,
        before_json, after_json, request_id, idempotency_key, source, created_at)
      SELECT lower(hex(randomblob(16))), ?, ?, ?,
        CASE json_extract(value, '$.kind') WHEN 'new' THEN 'CREATE_PURCHASE_SKU' ELSE 'UPDATE_PURCHASE_SKU' END,
        'sku', json_extract(value, '$.id'), json_extract(value, '$.before'),
        json_object('code', json_extract(value, '$.code'), 'productDetails', json_extract(value, '$.after')),
        ?, ? || ':' || json_extract(value, '$.id'), 'human', ?
      FROM json_each(?)
    `).bind(...actor, batchId, batchId, now, chunk),
  ]);

  await db.batch([...guards, ...writes, db.prepare(`
    INSERT INTO audit_logs (id, tenant_id, actor_id, actor_email, action, entity_type, entity_id,
      before_json, after_json, request_id, idempotency_key, source, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 'human', ?)
  `).bind(batchId, ...actor, importAction, importEntityType, batchId, stableJson({ workbookHash, ...summary }), batchId, key, now)]);
}

function planChunks(rows: PlannedRow[]) {
  const chunks: string[] = [];
  let parts: string[] = [];
  let size = 2;
  for (const row of rows) {
    const encoded = JSON.stringify(row);
    const length = encoder.encode(encoded).length + 1;
    if (size + length > maxPlanChunkBytes && parts.length > 0) {
      chunks.push(`[${parts.join(',')}]`);
      parts = [];
      size = 2;
    }
    size += length;
    parts.push(encoded);
  }
  if (parts.length) chunks.push(`[${parts.join(',')}]`);
  return chunks;
}

async function readImportReceipt(db: D1Database, user: UserContext, key: string, workbookHash: string) {
  const row = await db.prepare(`
    SELECT action, entity_type, actor_id, after_json FROM audit_logs WHERE tenant_id = ? AND idempotency_key = ?
  `).bind(user.tenantId, key).first<{ action: string; entity_type: string; actor_id: string; after_json: string }>();
  if (!row) return null;
  if (row.action !== importAction || row.entity_type !== importEntityType || row.actor_id !== user.id) throw stalePreview();
  const recorded = JSON.parse(row.after_json) as ApplySummary & { workbookHash: string };
  if (recorded.workbookHash !== workbookHash) throw stalePreview();
  return { created: recorded.created, updated: recorded.updated, unchanged: recorded.unchanged };
}

async function hashWorkbook(bytes: Uint8Array<ArrayBuffer>) {
  const buffer = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(buffer, byte => byte.toString(16).padStart(2, '0')).join('');
}

function stalePreview() {
  return new HttpError(409, '表格或 ERP 商品资料已发生变动，请重新预览后再确认', 'SKU_IMPORT_PREVIEW_STALE');
}
