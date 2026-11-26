import { z } from 'zod';
import { HttpError, requirePermission, type UserContext } from './db';
import { feishuProcurementPreviewSchema, type FeishuProcurementPreview } from './feishu-procurement-preview-contract';
import { recordWarehouseStockCount } from './warehouse-service';

const regions = ['CA', 'GA', 'NJ'] as const;
const regionFields = { CA: 'ca', GA: 'ga', NJ: 'nj' } as const;
const reviewedStatuses = new Set(['三仓确认可用为 0', '销量与库存已配对', '近期销量待核', '部分仓缺记录']);
const identifier = z.string().trim().min(1).max(160);
const pageSize = 30;
const maxStockQuantity = 2_147_483_647;

export const openingStockQuerySchema = z.strictObject({
  q: z.string().trim().max(160).optional(),
  region: z.enum(regions).optional(),
  page: z.coerce.number().int().min(1).max(1_000).default(1),
});

export const openingStockPostSchema = z.strictObject({
  snapshotVersion: z.string().regex(/^[a-f0-9]{64}$/),
  sku: identifier,
  region: z.enum(regions),
  skuId: identifier,
  warehouseId: identifier,
  quantity: z.number().int().min(0).max(maxStockQuantity),
  confirmed: z.literal(true),
});

type OpeningQuery = z.infer<typeof openingStockQuerySchema>;
type OpeningPost = z.infer<typeof openingStockPostSchema>;
type Region = typeof regions[number];
type StockRow = FeishuProcurementPreview['skus'][number];
type Selection = { source: StockRow; region: Region };
type CandidateStatus = 'ready' | 'source_unverified' | 'sku_unmapped' | 'warehouse_unmapped' | 'already_initialized';
type Archive = { date: string; version: string; importedAt: string; snapshot: FeishuProcurementPreview };

export type OpeningStockCandidate = {
  sku: string;
  region: Region;
  quantity: number | null;
  skuId: string | null;
  warehouseId: string | null;
  warehouseName: string | null;
  status: CandidateStatus;
};

export async function getOpeningStock(db: D1Database, user: UserContext, query: OpeningQuery) {
  requireOpeningStockAdmin(user);
  const archive = await loadArchive(db, user.tenantId);
  if (!archive) return { ok: true as const, snapshot: null, rows: [], hasNext: false };

  const targetRegions = query.region ? [query.region] : regions;
  const term = (query.q ?? '').toUpperCase();
  const offset = (query.page - 1) * pageSize;
  const selection = archive.snapshot.skus
    .filter(({ sku }) => sku.toUpperCase().includes(term))
    .sort((a, b) => a.sku.localeCompare(b.sku))
    .flatMap((source) => targetRegions.map((region) => ({ source, region })))
    .slice(offset, offset + pageSize + 1);
  const rows = await resolveCandidates(db, user.tenantId, archive.snapshot, selection.slice(0, pageSize));
  return { ok: true as const, snapshot: { date: archive.date, version: archive.version, importedAt: archive.importedAt },
    rows, hasNext: selection.length > pageSize };
}

export async function postOpeningStock(db: D1Database, user: UserContext, input: OpeningPost, operationKey: string) {
  requireOpeningStockAdmin(user);
  const count = {
    skuId: input.skuId, warehouseId: input.warehouseId, expectedVersion: 0, countedQty: input.quantity,
    reason: `期初库存核对 · ${input.sku} ${input.region}`,
  };
  const guard = { skuCode: input.sku, warehouseCode: input.region, snapshotVersion: input.snapshotVersion };
  const completed = await db.prepare(`SELECT 1 AS completed FROM warehouse_stock_counts WHERE tenant_id = ? AND operation_key = ?`)
    .bind(user.tenantId, operationKey).first('completed');
  if (completed) return recordWarehouseStockCount(db, user, count, operationKey, guard);

  const archive = await loadArchive(db, user.tenantId);
  if (!archive || archive.version !== input.snapshotVersion) {
    throw new HttpError(409, '期初库存归档已更新，请刷新并重新核对。', 'OPENING_STOCK_STALE');
  }
  const source = archive.snapshot.skus.find(({ sku }) => sku === input.sku);
  if (!source) throw new HttpError(404, '此批次没有对应的 SKU。', 'OPENING_STOCK_SOURCE_NOT_FOUND');

  const [candidate] = await resolveCandidates(db, user.tenantId, archive.snapshot, [{ source, region: input.region }]);
  if (candidate.status !== 'ready' && candidate.status !== 'already_initialized') {
    throw new HttpError(409, '来源数量或归属待核，或尚未建立同码商品和仓库。', 'OPENING_STOCK_NOT_READY');
  }
  if (candidate.skuId !== input.skuId || candidate.warehouseId !== input.warehouseId || candidate.quantity !== input.quantity) {
    throw new HttpError(409, '商品、仓库或数量与当前归档不符，请刷新后核对。', 'OPENING_STOCK_SELECTION_CHANGED');
  }
  // The stock count service checks idempotency before it rejects an existing balance.
  return recordWarehouseStockCount(db, user, count, operationKey, guard);
}

function requireOpeningStockAdmin(user: UserContext) {
  requirePermission(user, 'members:manage');
  requirePermission(user, 'warehouse:manage');
}

async function loadArchive(db: D1Database, tenantId: string): Promise<Archive | null> {
  const row = await db.prepare(`
    SELECT snapshot_date AS date, payload_hash AS version, payload_json AS json, imported_at AS importedAt
    FROM feishu_procurement_previews WHERE tenant_id = ? ORDER BY snapshot_date DESC, id DESC LIMIT 1
  `).bind(tenantId).first<{ date: string; version: string; json: string; importedAt: string }>();
  if (!row) return null;
  return { date: row.date, version: row.version, importedAt: row.importedAt,
    snapshot: feishuProcurementPreviewSchema.parse(JSON.parse(row.json)) };
}

async function resolveCandidates(db: D1Database, tenantId: string, snapshot: FeishuProcurementPreview, selections: Selection[]) {
  if (!selections.length) return [];
  const codes = [...new Set(selections.map(({ source }) => source.sku))];
  const lookup = codes.map(() => '?').join(', ');
  const [skuRecords, warehouseRecords, balances] = await Promise.all([
    db.prepare(`SELECT id, code FROM skus WHERE tenant_id = ? AND active = 1 AND code IN (${lookup})`)
      .bind(tenantId, ...codes).all<{ id: string; code: string }>(),
    db.prepare(`SELECT id, code, name FROM warehouses WHERE tenant_id = ? AND code IN ('CA', 'GA', 'NJ')`)
      .bind(tenantId).all<{ id: string; code: Region; name: string }>(),
    db.prepare(`
      SELECT b.sku_id AS skuId, b.warehouse_id AS warehouseId
      FROM inventory_balances b JOIN skus s ON s.id = b.sku_id AND s.tenant_id = b.tenant_id
      JOIN warehouses w ON w.id = b.warehouse_id AND w.tenant_id = b.tenant_id
      WHERE b.tenant_id = ? AND s.code IN (${lookup}) AND w.code IN ('CA', 'GA', 'NJ')
    `).bind(tenantId, ...codes).all<{ skuId: string; warehouseId: string }>(),
  ]);
  const reviewed = new Set(snapshot.review.filter((entry) => entry.source.includes('库存')
    && (entry.category === '归属待核' || entry.category === '深圳共销' || entry.category === '非本公司'))
    .map(({ sku }) => sku.toUpperCase()));
  const skus = new Map(skuRecords.results.map((item) => [item.code, item.id]));
  const warehouses = new Map(warehouseRecords.results.map((item) => [item.code, item]));
  const initialized = new Map<string, Set<string>>();
  for (const balance of balances.results) {
    if (!initialized.has(balance.skuId)) initialized.set(balance.skuId, new Set());
    initialized.get(balance.skuId)!.add(balance.warehouseId);
  }
  return selections.map(({ source, region }): OpeningStockCandidate => {
    const skuId = skus.get(source.sku) ?? null;
    const warehouse = warehouses.get(region);
    const quantity = source[regionFields[region]];
    let status: CandidateStatus = 'ready';
    if (!isReviewedStock(source, quantity, reviewed)) status = 'source_unverified';
    else if (!skuId) status = 'sku_unmapped';
    else if (!warehouse) status = 'warehouse_unmapped';
    else if (initialized.get(skuId)?.has(warehouse.id)) status = 'already_initialized';
    return { sku: source.sku, region, quantity, skuId, warehouseId: warehouse?.id ?? null,
      warehouseName: warehouse?.name ?? null, status };
  });
}

function isReviewedStock(row: StockRow, quantity: number | null, reviewed: Set<string>) {
  if (quantity === null || !reviewedStatuses.has(row.status) || reviewed.has(row.sku.toUpperCase())) return false;
  const known = [row.ca, row.ga, row.nj].filter((amount) => amount !== null);
  if (known.length !== row.warehouseCount || known.some((amount) => amount > maxStockQuantity)) return false;
  if (row.status === '部分仓缺记录' ? known.length >= regions.length : known.length !== regions.length) return false;
  const total = known.reduce((sum, amount) => sum + amount, 0);
  return total === row.stockTotal && (row.status !== '三仓确认可用为 0' || total === 0);
}
