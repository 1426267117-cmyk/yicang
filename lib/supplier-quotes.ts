import { z } from 'zod';
import { sha256Hex, stableJson } from './connectors/stable';
import { HttpError, requirePermission, type UserContext } from './db';

const identifier = z.string().trim().min(1).max(160);
const orderQuantity = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const version = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1);
const currency = z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/u, '币种须填写三位字母');
const tier = z.strictObject({ minimumQuantity: orderQuantity, unitCostMinor: z.number().int().min(0).max(10_000_000_000) });
const tiers = z.array(tier).min(1).max(20);
const quoteKey = { skuId: identifier, supplierId: identifier, currency, expectedVersion: version };

export const quoteWriteSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('publish'), ...quoteKey,
    validFrom: z.iso.date(), validThrough: z.iso.date().nullable(), tiers,
    reference: z.string().trim().max(120).optional(), note: z.string().trim().max(500).optional(),
  }),
  z.strictObject({ action: z.literal('archive'), ...quoteKey, reason: z.string().trim().min(1).max(500) }),
]).superRefine((input, context) => {
  if (input.action === 'publish') {
    if (input.validThrough && input.validThrough < input.validFrom) {
      context.addIssue({ code: 'custom', path: ['validThrough'], message: '有效截止日期不得早于生效日期' });
    }
    if (input.tiers.some((entry, index) => index > 0 && entry.minimumQuantity <= input.tiers[index - 1].minimumQuantity)) {
      context.addIssue({ code: 'custom', path: ['tiers'], message: '阶梯起订量须从小到大填写且不能重复' });
    }
  } else if (input.expectedVersion === 0) {
    context.addIssue({ code: 'custom', path: ['expectedVersion'], message: '找不到可停用的报价版本' });
  }
});

export const quoteQuerySchema = z.strictObject({
  skuId: identifier,
  supplierId: identifier.optional(),
  currency: currency.optional(),
  quantity: z.coerce.number().pipe(orderQuantity).default(1),
  history: z.literal('1').optional(),
}).refine((input) => !input.history || Boolean(input.currency && input.supplierId), '报价历史须指定供应商和币种');

export type SupplierQuoteWrite = z.infer<typeof quoteWriteSchema>;
type SupplierQuoteQuery = z.infer<typeof quoteQuerySchema>;
type QuoteStatus = 'available' | 'scheduled' | 'expired' | 'archived' | 'inactive' | 'below_minimum';
export type SupplierQuoteTier = z.infer<typeof tier>;
export type QuoteSku = { id: string; code: string; name: string };
export type QuoteSupplier = { id: string; code: string; name: string; active: boolean };

type QuoteRow = {
  id: string;
  supplier_id: string;
  supplier_code: string;
  supplier_name: string;
  supplier_active: number;
  sku_active: number;
  currency: string;
  version: number;
  status: 'active' | 'archived';
  valid_from: string;
  valid_through: string | null;
  tiers_json: string;
  reference: string | null;
  note: string | null;
  recorded_by: string;
  created_at: string;
  prior_version: number | null;
  prior_valid_through: string | null;
  prior_tiers_json: string | null;
  prior_reference: string | null;
};

export type SupplierQuote = ReturnType<typeof mapQuote>;
export type SupplierQuoteBook = Awaited<ReturnType<typeof getSupplierQuoteBook>>;

export async function getSupplierQuoteBook(db: D1Database, user: UserContext, query: SupplierQuoteQuery) {
  requirePermission(user, 'purchase:order:create');
  const today = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const limit = query.history ? 50 : 200;
  const [sku, results] = await db.batch<QuoteSku | QuoteRow>([
    db.prepare('SELECT id, code, name FROM skus WHERE tenant_id = ? AND id = ?').bind(user.tenantId, query.skuId),
    db.prepare(`
      SELECT quote.id, quote.supplier_id, supplier.code AS supplier_code, supplier.name AS supplier_name,
        supplier.active AS supplier_active, sku.active AS sku_active, quote.currency, quote.version,
        quote.status, quote.valid_from, quote.valid_through, quote.tiers_json, quote.reference, quote.note,
        member.display_name AS recorded_by, quote.created_at,
        prior.version AS prior_version, prior.valid_through AS prior_valid_through,
        prior.tiers_json AS prior_tiers_json, prior.reference AS prior_reference
      FROM purchase_supplier_quotes quote
      JOIN suppliers supplier ON supplier.tenant_id = quote.tenant_id AND supplier.id = quote.supplier_id
      JOIN skus sku ON sku.tenant_id = quote.tenant_id AND sku.id = quote.sku_id
      JOIN members member ON member.tenant_id = quote.tenant_id AND member.id = quote.created_by_member_id
      LEFT JOIN purchase_supplier_quotes prior ON prior.tenant_id = quote.tenant_id AND prior.id = ${query.history ? 'NULL' : `(
        SELECT current.id FROM purchase_supplier_quotes current
        WHERE quote.status = 'active' AND quote.valid_from > ?
          AND current.tenant_id = quote.tenant_id AND current.sku_id = quote.sku_id
          AND current.supplier_id = quote.supplier_id AND current.currency = quote.currency
          AND current.version < quote.version AND current.valid_from <= ? AND current.status = 'active'
          AND current.version > COALESCE((SELECT MAX(archived.version) FROM purchase_supplier_quotes archived
            WHERE archived.tenant_id = quote.tenant_id AND archived.sku_id = quote.sku_id
              AND archived.supplier_id = quote.supplier_id AND archived.currency = quote.currency
              AND archived.status = 'archived' AND archived.version < quote.version), 0)
        ORDER BY current.version DESC LIMIT 1
      )`}
      WHERE quote.tenant_id = ? AND quote.sku_id = ?
        AND (? IS NULL OR quote.supplier_id = ?) AND (? IS NULL OR quote.currency = ?)
        ${query.history ? '' : `AND quote.version = (SELECT MAX(latest.version) FROM purchase_supplier_quotes latest
          WHERE latest.tenant_id = quote.tenant_id AND latest.sku_id = quote.sku_id
            AND latest.supplier_id = quote.supplier_id AND latest.currency = quote.currency)`}
      ORDER BY ${query.history ? 'quote.version DESC' : 'quote.currency, supplier.code, quote.version DESC'} LIMIT ?
    `).bind(...(query.history ? [] : [today, today]), user.tenantId, query.skuId, query.supplierId ?? null, query.supplierId ?? null,
      query.currency ?? null, query.currency ?? null, limit + 1),
  ]);
  const skuRow = sku.results[0] as QuoteSku | undefined;
  if (!skuRow) throw new HttpError(404, '当前工作区找不到此 SKU', 'SUPPLIER_QUOTE_SKU_NOT_FOUND');
  const validResults = results.results as QuoteRow[];
  const quotes = validResults.slice(0, limit).map((row) => mapQuote(row, today, query.quantity));
  if (!query.history) {
    quotes.sort((a, b) => a.currency.localeCompare(b.currency)
      || (a.matchedTier?.unitCostMinor ?? Infinity) - (b.matchedTier?.unitCostMinor ?? Infinity)
      || a.supplier.code.localeCompare(b.supplier.code, 'zh-CN'));
  }
  return { sku: skuRow, quantity: query.quantity, today, quotes, more: validResults.length > limit };
}

function mapQuote(row: QuoteRow, today: string, quantity: number) {
  const priceTiers = tiers.parse(JSON.parse(row.tiers_json));
  const match = priceTiers.findLast((entry) => entry.minimumQuantity <= quantity);
  let status: QuoteStatus = 'available';
  if (row.status === 'archived') status = 'archived';
  else if (!row.sku_active || !row.supplier_active) status = 'inactive';
  else if (row.valid_from > today) status = 'scheduled';
  else if (row.valid_through && row.valid_through < today) status = 'expired';
  else if (!match) status = 'below_minimum';
  const priorTiers = status === 'scheduled' && row.prior_tiers_json !== null
    && (row.prior_valid_through === null || row.prior_valid_through >= today)
    ? tiers.parse(JSON.parse(row.prior_tiers_json)) : null;
  const matchedTier = status === 'available' ? match ?? null
    : priorTiers?.findLast((entry) => entry.minimumQuantity <= quantity) ?? null;
  return {
    id: row.id, supplier: { id: row.supplier_id, code: row.supplier_code, name: row.supplier_name, active: Boolean(row.supplier_active) },
    currency: row.currency, version: Number(row.version), status, validFrom: row.valid_from, validThrough: row.valid_through,
    tiers: priceTiers, matchedTier,
    matchedVersion: matchedTier === null ? null : Number(priorTiers ? row.prior_version : row.version),
    matchedReference: matchedTier === null ? null : priorTiers ? row.prior_reference : row.reference,
    totalMinor: matchedTier === null ? null : (BigInt(quantity) * BigInt(matchedTier.unitCostMinor)).toString(),
    reference: row.reference, note: row.note, createdAt: row.created_at, recordedBy: row.recorded_by,
  };
}

export async function writeSupplierQuote(db: D1Database, user: UserContext, input: SupplierQuoteWrite, operationKey: string) {
  requirePermission(user, 'purchase:supplier:create');
  if (!/^[A-Za-z0-9._:-]{12,128}$/u.test(operationKey)) {
    throw new HttpError(400, '缺少有效的报价操作编号', 'INVALID_IDEMPOTENCY_KEY');
  }

  const publish = input.action === 'publish';
  const activeStatus = publish ? 'active' : 'archived';
  const quoteId = crypto.randomUUID();
  const now = new Date().toISOString();
  const nextVersion = input.expectedVersion + 1;
  const hashPayload = publish ? { ...input, reference: input.reference || null, note: input.note || null } : input;
  const requestHash = await sha256Hex(stableJson(hashPayload));
  const valueBindings = publish
    ? [input.validFrom, input.validThrough, JSON.stringify(input.tiers), input.reference || null, input.note || null]
    : [input.reason];

  const [write] = await db.batch([
    db.prepare(`
      WITH latest AS (
        SELECT quote.* FROM purchase_supplier_quotes quote
        WHERE quote.tenant_id = ? AND quote.sku_id = ? AND quote.supplier_id = ? AND quote.currency = ?
        ORDER BY version DESC LIMIT 1
      )
      INSERT INTO purchase_supplier_quotes (id, tenant_id, supplier_id, sku_id, currency, version,
        status, valid_from, valid_through, tiers_json, reference, note, created_by_member_id,
        idempotency_key, request_hash, created_at)
      SELECT ?, sku.tenant_id, supplier.id, sku.id, ?, ?, ?,
        ${publish ? '?, ?, ?, ?, ?' : 'latest.valid_from, latest.valid_through, latest.tiers_json, latest.reference, ?'},
        member.id, ?, ?, ?
      FROM skus sku
      JOIN suppliers supplier ON supplier.tenant_id = sku.tenant_id AND supplier.id = ?
      JOIN members member ON member.tenant_id = sku.tenant_id AND member.auth_user_id = ? AND member.role IN ('admin', 'operator')
      LEFT JOIN latest ON latest.sku_id = sku.id AND latest.tenant_id = sku.tenant_id
      WHERE sku.tenant_id = ? AND sku.id = ? AND COALESCE(latest.version, 0) = ?
        ${publish ? 'AND sku.active = 1 AND supplier.active = 1' : "AND latest.status = 'active'"}
      ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
    `).bind(user.tenantId, input.skuId, input.supplierId, input.currency, quoteId, input.currency, nextVersion,
      activeStatus, ...valueBindings, operationKey, requestHash, now, input.supplierId, user.id, user.tenantId,
      input.skuId, input.expectedVersion),
    db.prepare(`
      INSERT INTO audit_logs (id, tenant_id, actor_id, actor_email, action, entity_type, entity_id, before_json,
        after_json, request_id, idempotency_key, source, created_at)
      SELECT ?, ?, ?, ?, ?, 'purchase_supplier_quote', ?, ?, ?, ?, ?, 'human', ?
      WHERE EXISTS (SELECT 1 FROM purchase_supplier_quotes quote WHERE quote.id = ? AND quote.tenant_id = ?)
    `).bind(crypto.randomUUID(), user.tenantId, user.id, user.email,
      publish ? 'PUBLISH_SUPPLIER_QUOTE' : 'ARCHIVE_SUPPLIER_QUOTE', quoteId,
      input.expectedVersion ? stableJson({ version: input.expectedVersion }) : null,
      stableJson({ skuId: input.skuId, supplierId: input.supplierId, currency: input.currency, version: nextVersion, status: activeStatus }),
      crypto.randomUUID(), `quote:${operationKey}`, now, quoteId, user.tenantId),
  ]);
  if (write.meta.changes === 1) return { id: quoteId, version: nextVersion, replayed: false };

  const existing = await db.prepare(`SELECT id, version, request_hash FROM purchase_supplier_quotes
    WHERE tenant_id = ? AND idempotency_key = ?`).bind(user.tenantId, operationKey)
    .first<{ id: string; version: number; request_hash: string }>();
  if (existing) {
    if (existing.request_hash !== requestHash) {
      throw new HttpError(409, '此操作编号已用于另一条报价记录', 'IDEMPOTENCY_CONFLICT');
    }
    return { id: existing.id, version: existing.version, replayed: true };
  }
  const related = await db.prepare(`SELECT sku.active AS sku_active, supplier.active AS supplier_active
    FROM skus sku JOIN suppliers supplier ON supplier.tenant_id = sku.tenant_id AND supplier.id = ?
    WHERE sku.tenant_id = ? AND sku.id = ?`).bind(input.supplierId, user.tenantId, input.skuId)
    .first<{ sku_active: number; supplier_active: number }>();
  if (!related) throw new HttpError(404, '当前工作区找不到此商品或供应商', 'SUPPLIER_QUOTE_SCOPE_NOT_FOUND');
  if (publish && (!related.sku_active || !related.supplier_active)) {
    throw new HttpError(409, '商品或供应商已停用，无法登记报价', 'SUPPLIER_QUOTE_PARTY_INACTIVE');
  }
  throw new HttpError(409, '报价版本已变化，请刷新后核对当前报价', 'SUPPLIER_QUOTE_VERSION_CONFLICT');
}
