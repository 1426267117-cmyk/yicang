import { sha256Hex, stableId, stableJson } from './connectors/stable';
import { HttpError, requirePermission, type UserContext } from './db';
import { resolvePurchaseProductDetails, type PurchaseProductDetailsInput } from './purchase-product-details';
import { skuCatalogFieldKeys, skuCatalogPageSize, type SkuCatalogField, type SkuCatalogFilter, type SkuCatalogPage } from './purchase-sku-catalog';

export type PurchaseSkuRow = {
  id: string;
  code: string;
  name: string;
  specification: string | null;
  dimensions: string | null;
  image_url: string | null;
  description: string | null;
};

export function mapPurchaseSku(row: PurchaseSkuRow) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    productDetails: {
      ...resolvePurchaseProductDetails({
        name: row.name, specification: row.specification, dimensions: row.dimensions,
        imageUrl: row.image_url, description: row.description,
      }),
      name: row.name,
    },
  };
}

export async function findPurchaseSkus(db: D1Database, user: UserContext, query: string) {
  requirePermission(user, 'purchase:read');
  return (await findSkuRows(db, user.tenantId, query)).map(mapPurchaseSku);
}

export async function findWarehouseSkus(db: D1Database, user: UserContext, query: string) {
  requirePermission(user, 'warehouse:manage');
  return (await findSkuRows(db, user.tenantId, query)).map(({ id, code, name }) => ({ id, code, name }));
}

const activeSkuSearchWhere = `tenant_id = ? AND active = 1
  AND (? = '' OR INSTR(UPPER(code), ?) > 0 OR INSTR(LOWER(name), LOWER(?)) > 0)`;

async function findSkuRows(db: D1Database, tenantId: string, query: string) {
  const search = query.trim();
  const code = search.toUpperCase();
  const rows = await db.prepare(`
    SELECT id, code, name, specification, dimensions, image_url, description FROM skus
    WHERE ${activeSkuSearchWhere}
    ORDER BY CASE WHEN UPPER(code) = ? THEN 0 ELSE 1 END, code COLLATE NOCASE, code
    LIMIT 40
  `).bind(tenantId, search, code, search, code).all<PurchaseSkuRow>();
  return rows.results;
}

const catalogColumns: Record<SkuCatalogField, keyof PurchaseSkuRow> = {
  specification: 'specification', dimensions: 'dimensions', imageUrl: 'image_url', description: 'description',
};
// Match String.trim() so legacy cells containing only whitespace stay in the same filter.
const trimCharacters = 'char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)';
const emptyCatalogField = (field: SkuCatalogField) =>
  `NULLIF(TRIM(${catalogColumns[field]}, ${trimCharacters}), '') IS NULL`;
const incompleteCatalog = skuCatalogFieldKeys.map(emptyCatalogField).join(' OR ');

export async function listPurchaseSkuCatalog(
  db: D1Database,
  user: UserContext,
  { query, filter, page }: { query: string; filter: SkuCatalogFilter; page: number },
): Promise<SkuCatalogPage> {
  requirePermission(user, 'purchase:read');
  const search = query.trim();
  const code = search.toUpperCase();
  let fieldFilter = '';
  if (filter === 'incomplete') fieldFilter = ` AND (${incompleteCatalog})`;
  else if (filter === 'complete') fieldFilter = ` AND NOT (${incompleteCatalog})`;
  else if (filter !== 'all') fieldFilter = ` AND ${emptyCatalogField(filter)}`;
  const bind = [user.tenantId, search, code, search];
  const [count, rows] = await db.batch<PurchaseSkuRow & { total: number }>([
    db.prepare(`SELECT COUNT(*) AS total FROM skus WHERE ${activeSkuSearchWhere}${fieldFilter}`).bind(...bind),
    db.prepare(`SELECT id, code, name, specification, dimensions, image_url, description
      FROM skus WHERE ${activeSkuSearchWhere}${fieldFilter}
      ORDER BY CASE WHEN UPPER(code) = ? THEN 0 ELSE 1 END, code COLLATE NOCASE, code, id
      LIMIT ? OFFSET ?`).bind(...bind, code, skuCatalogPageSize, (page - 1) * skuCatalogPageSize),
  ]);
  const skus = await Promise.all(rows.results.map(async row => ({
    ...mapPurchaseSku(row),
    revision: await sha256Hex(stableJson(row)),
    missingFields: skuCatalogFieldKeys.filter(field => !row[catalogColumns[field]]?.trim()),
  })));
  return { skus, page, total: count.results[0]?.total ?? 0 };
}

export async function createPurchaseSku(
  db: D1Database,
  user: UserContext,
  input: { code: string; name: string; productDetails?: Omit<PurchaseProductDetailsInput, 'name'> },
  idempotencyKey: string,
) {
  requirePermission(user, 'purchase:mapping');
  if (idempotencyKey.length < 8 || idempotencyKey.length > 128) {
    throw new HttpError(400, '缺少有效的 Idempotency-Key', 'INVALID_IDEMPOTENCY_KEY');
  }

  const normalized = { code: input.code.trim().toUpperCase(), name: input.name.trim() };
  const details = resolvePurchaseProductDetails({ ...input.productDetails, name: normalized.name });
  const { description, ...previousDetails } = details;
  const requestHash = await sha256Hex(stableJson(
    input.productDetails === undefined ? normalized : {
      ...normalized,
      productDetails: input.productDetails.description === undefined ? previousDetails : { ...previousDetails, description },
    },
  ));
  const replay = await readReplay(db, user.tenantId, idempotencyKey, requestHash);
  if (replay) return { sku: replay, replayed: true };

  // Match the ID generated by platform SKU mapping for the same tenant and code.
  const sku = {
    id: await stableId('sku', user.tenantId, normalized.code),
    ...normalized,
    productDetails: { ...details, name: normalized.name },
  };
  const now = new Date().toISOString();
  try {
    await assertSkuCodeAvailable(db, user.tenantId, sku.code);
    await db.batch([
      db.prepare(`
        INSERT INTO skus (id, tenant_id, code, name, specification, dimensions, image_url, description, active, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
      `).bind(
        sku.id, user.tenantId, sku.code, sku.name,
        details.specification, details.dimensions, details.imageUrl, details.description ?? null, now,
      ),
      db.prepare(`
        INSERT INTO audit_logs (
          id, tenant_id, actor_id, actor_email, action, entity_type, entity_id,
          before_json, after_json, request_id, idempotency_key, source, created_at
        ) VALUES (?, ?, ?, ?, 'CREATE_PURCHASE_SKU', 'sku', ?, NULL, ?, ?, ?, 'human', ?)
      `).bind(
        crypto.randomUUID(), user.tenantId, user.id, user.email, sku.id,
        stableJson({ ...sku, requestHash }), crypto.randomUUID(), idempotencyKey, now,
      ),
    ]);
  } catch (error) {
    const concurrent = await readReplay(db, user.tenantId, idempotencyKey, requestHash);
    if (concurrent) return { sku: concurrent, replayed: true };
    if (!(error instanceof HttpError)) await assertSkuCodeAvailable(db, user.tenantId, sku.code);
    throw error;
  }
  return { sku, replayed: false };
}

export async function updatePurchaseSku(
  db: D1Database,
  user: UserContext,
  skuId: string,
  input: PurchaseProductDetailsInput,
  expectedRevision?: string,
) {
  requirePermission(user, 'purchase:mapping');
  const row = await db.prepare(`
    SELECT id, code, name, specification, dimensions, image_url, description FROM skus
    WHERE tenant_id = ? AND id = ? AND active = 1
  `).bind(user.tenantId, skuId).first<PurchaseSkuRow>();
  if (!row) throw new HttpError(404, '当前工作区找不到该有效 SKU', 'PURCHASE_SKU_UNAVAILABLE');

  if (expectedRevision && expectedRevision !== await sha256Hex(stableJson(row))) {
    throw new HttpError(409, 'SKU 商品资料已变更，请刷新后再保存', 'PURCHASE_SKU_CHANGED');
  }
  const before = mapPurchaseSku(row);
  const details = resolvePurchaseProductDetails(before.productDetails, input);
  if (!details.name) throw new HttpError(400, '请输入商品名称', 'INVALID_PURCHASE_SKU');
  const sku = { ...before, name: details.name, productDetails: { ...details, name: details.name } };
  if (stableJson(before) === stableJson(sku)) return { sku };

  const match = [user.tenantId, skuId, row.name, row.specification, row.dimensions, row.image_url, row.description];
  const matchSql = 'tenant_id = ? AND id = ? AND active = 1 AND name IS ? AND specification IS ? AND dimensions IS ? AND image_url IS ? AND description IS ?';
  const now = new Date().toISOString();
  const [audit, updated] = await db.batch([
    db.prepare(`
      INSERT INTO audit_logs (
        id, tenant_id, actor_id, actor_email, action, entity_type, entity_id,
        before_json, after_json, request_id, idempotency_key, source, created_at
      )
      SELECT ?, ?, ?, ?, 'UPDATE_PURCHASE_SKU', 'sku', ?, ?, ?, ?, ?, 'human', ?
      FROM skus WHERE ${matchSql}
    `).bind(
      crypto.randomUUID(), user.tenantId, user.id, user.email, skuId, stableJson(before),
      stableJson(sku), crypto.randomUUID(), crypto.randomUUID(), now, ...match,
    ),
    db.prepare(`
      UPDATE skus SET name = ?, specification = ?, dimensions = ?, image_url = ?, description = ?
      WHERE ${matchSql}
    `).bind(details.name, details.specification, details.dimensions, details.imageUrl, details.description ?? null, ...match),
  ]);
  if (audit.meta.changes !== 1 || updated.meta.changes !== 1) {
    throw new HttpError(409, 'SKU 商品资料已变更，请刷新后再保存', 'PURCHASE_SKU_CHANGED');
  }
  return { sku };
}

async function assertSkuCodeAvailable(db: D1Database, tenantId: string, code: string) {
  const sku = await db.prepare(`
    SELECT active FROM skus WHERE tenant_id = ? AND UPPER(code) = ? LIMIT 1
  `).bind(tenantId, code).first<{ active: number }>();
  if (!sku) return;
  if (sku.active !== 1) {
    throw new HttpError(409, '同编码 ERP SKU 已停用', 'PURCHASE_SKU_INACTIVE');
  }
  throw new HttpError(409, 'ERP SKU 编码已存在，请选择已有商品', 'PURCHASE_SKU_CODE_EXISTS');
}

async function readReplay(db: D1Database, tenantId: string, idempotencyKey: string, requestHash: string) {
  const row = await db.prepare(`
    SELECT audit.action, audit.entity_type,
      CASE WHEN json_valid(audit.after_json) THEN json_extract(audit.after_json, '$.requestHash') END AS request_hash,
      sku.id, sku.code, sku.name, sku.specification, sku.dimensions, sku.image_url, sku.description
    FROM audit_logs audit
    LEFT JOIN skus sku ON sku.tenant_id = audit.tenant_id AND sku.id = audit.entity_id
    WHERE audit.tenant_id = ? AND audit.idempotency_key = ?
    LIMIT 1
  `).bind(tenantId, idempotencyKey).first<Pick<PurchaseSkuRow, 'specification' | 'dimensions' | 'image_url' | 'description'> & {
    action: string;
    entity_type: string;
    request_hash: string | null;
    id: string | null;
    code: string | null;
    name: string | null;
  }>();
  if (!row) return null;
  if (row.action !== 'CREATE_PURCHASE_SKU' || row.entity_type !== 'sku') {
    throw new HttpError(409, '该幂等键已用于另一项业务操作', 'IDEMPOTENCY_CONFLICT');
  }
  if (row.request_hash !== requestHash) {
    throw new HttpError(409, '同一幂等键不能用于不同的 SKU 参数', 'IDEMPOTENCY_CONFLICT');
  }
  if (!row.id || !row.code || !row.name) {
    throw new HttpError(409, 'SKU 建档结果暂时无法读取', 'PURCHASE_SKU_RESULT_MISSING');
  }
  return mapPurchaseSku({ ...row, id: row.id, code: row.code, name: row.name });
}
