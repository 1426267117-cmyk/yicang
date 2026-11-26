import { z } from 'zod';
import { sha256Hex, stableJson } from './connectors/stable';
import { HttpError, type UserContext } from './db';

export const financeScopes = ['committed', 'draft', 'cancelled', 'all'] as const;
export type FinanceScope = (typeof financeScopes)[number];
export const financePageSize = 30;
export const financeLedgerPageSize = 40;
export type FinanceLedgerKind = 'payment' | 'invoice';

const id = z.string().trim().min(1).max(120);
const currency = z.string().regex(/^[A-Z]{3}$/);
const entryFields = {
  purchaseOrderId: id,
  amountMinor: z.number().int().positive().max(1_000_000_000_000),
  currency,
  reference: z.string().trim().min(1).max(120),
  note: z.string().trim().max(500).optional(),
};
const paymentFields = { ...entryFields, paidAt: z.iso.datetime({ offset: true }).transform((value) => new Date(value).toISOString()) };
const invoiceFields = { ...entryFields, invoiceOn: z.iso.date() };

export const newPaymentSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('payment'), ...paymentFields }),
  z.strictObject({ kind: z.literal('reversal'), originalPaymentId: id, ...paymentFields }),
]);
export type NewPayment = z.infer<typeof newPaymentSchema>;
export const newInvoiceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('invoice'), ...invoiceFields }),
  z.strictObject({ kind: z.literal('reversal'), originalInvoiceId: id, ...invoiceFields }),
]);
export type NewInvoice = z.infer<typeof newInvoiceSchema>;

const pageParameter = z.coerce.number().int().min(1).max(10_000).optional().default(1);
export const financeQuerySchema = z.union([
  z.strictObject({ orderId: id, ledger: z.enum(['payment', 'invoice']).default('payment'), page: pageParameter }),
  z.strictObject({ scope: z.enum(financeScopes).optional().default('committed'), search: z.string().trim().max(120).optional().default(''), page: pageParameter }),
]);

type FinanceStatus = 'draft' | 'issued' | 'partially_received' | 'received' | 'closed_short' | 'cancelled';
type FinanceOrderRow = {
  id: string;
  order_no: string;
  supplier_name: string;
  status: FinanceStatus;
  currency: string | null;
  ordered_minor: string | null;
  received_minor: string | null;
  paid_minor: string;
  payment_count: number;
  invoiced_minor: string;
  invoice_count: number;
  issued_at: string | null;
  payment_terms: string | null;
};
type FinanceTotalRow = Pick<FinanceOrderRow, 'currency' | 'ordered_minor' | 'received_minor' | 'paid_minor' | 'invoiced_minor'> & {
  order_count: number;
  valued_order_count: number;
  payment_count: number;
  invoice_count: number;
};
type LedgerRow = {
  id: string;
  kind: NewPayment['kind'] | NewInvoice['kind'];
  amount_minor: string;
  currency: string;
  occurred_at: string;
  reference: string;
  note: string | null;
  original_reference: string | null;
  reversible_minor: string | null;
  created_at: string;
  recorded_by: string;
};

export type FinanceOrder = ReturnType<typeof mapOrder>;
export type FinanceWorkspace = Awaited<ReturnType<typeof listFinanceOrders>>;
export type FinanceLedger = Awaited<ReturnType<typeof getFinanceLedger>>;

const committedStatuses = "('issued', 'partially_received', 'received', 'closed_short')";
const scopeCondition: Record<FinanceScope, string> = {
  committed: `AND po.status IN ${committedStatuses}`,
  draft: "AND po.status = 'draft'",
  cancelled: "AND po.status = 'cancelled'",
  all: '',
};

const ledgerDefinition = {
  payment: { table: 'purchase_payments', date: 'paid_at', original: 'original_payment_id', field: 'paid' },
  invoice: { table: 'purchase_invoices', date: 'invoice_on', original: 'original_invoice_id', field: 'invoiced' },
} as const;

// Multiplying or summing large database integers directly can overflow SQLite. Disjoint decimal
// chunks keep the SQL aggregates in range and let the response recover an exact integer.
const chunkBase = 10_000;
const chunkDivisors = [1, 10_000, 100_000_000, 1_000_000_000_000, 10_000_000_000_000_000];
const costPartIndexes = Array.from({ length: chunkDivisors.length * 2 - 1 }, (_, index) => index);
const moneyPartIndexes = chunkDivisors.map((_, index) => index);

function productParts(quantityField: 'ordered' | 'received') {
  return costPartIndexes.map((index) => {
    const products = chunkDivisors.flatMap((quantityDivisor, position) => {
      const priceDivisor = chunkDivisors[index - position];
      return priceDivisor ? [`(line.${quantityField}_quantity / ${quantityDivisor} % ${chunkBase})
        * (line.unit_cost_minor / ${priceDivisor} % ${chunkBase})`] : [];
    });
    return `SUM(${products.join(' + ')}) AS ${quantityField}_${index}`;
  }).join(', ');
}

function ledgerValues(kind: FinanceLedgerKind) {
  const { table, field } = ledgerDefinition[kind];
  const chunks = chunkDivisors.map((divisor, index) => `SUM((entry.amount_minor / ${divisor} % ${chunkBase})
    * (CASE WHEN entry.kind = '${kind}' THEN 1 ELSE -1 END)) AS ${field}_${index}`);
  return `${kind}_values AS (
    SELECT scoped.id, COUNT(*) AS ${kind}_count, ${chunks.join(', ')}
    FROM scoped_orders scoped
    JOIN ${table} entry ON entry.tenant_id = scoped.tenant_id AND entry.purchase_order_id = scoped.id
      AND entry.currency = scoped.currency
    GROUP BY scoped.id
  )`;
}

function encodeMinor(field: string, partIndexes: number[], aggregate: boolean) {
  const columns = partIndexes.map((index) => aggregate ? `SUM(${field}_${index})` : `${field}_${index}`);
  return `CASE WHEN ${columns[0]} IS NOT NULL THEN json_array(${columns.map((column) => `CAST(${column} AS TEXT)`).join(', ')}) END AS ${field}_minor`;
}

function decodeMinor(chunks: string | null) {
  if (chunks === null) return null;
  return (JSON.parse(chunks) as string[])
    .reduceRight((amount, part) => amount * BigInt(chunkBase) + BigInt(part), BigInt(0)).toString();
}

const financeMoneyColumns = (aggregate: boolean) => [
  encodeMinor('ordered', costPartIndexes, aggregate), encodeMinor('received', costPartIndexes, aggregate),
  encodeMinor('paid', moneyPartIndexes, aggregate), encodeMinor('invoiced', moneyPartIndexes, aggregate),
].join(', ');

function financeAmounts(orderCondition: string) {
  return `
    WITH scoped_orders AS (
      SELECT po.id, po.tenant_id, po.order_no, po.status, po.currency, po.issued_at,
        po.payment_terms, po.updated_at, po.version, COALESCE(po.supplier_name_snapshot, supplier.name) AS supplier_name
      FROM purchase_orders po
      JOIN suppliers supplier ON supplier.id = po.supplier_id AND supplier.tenant_id = po.tenant_id
      WHERE po.tenant_id = ? ${orderCondition}
    ), order_costs AS (
      SELECT scoped.id, COUNT(*) = SUM(CASE WHEN scoped.currency GLOB '[A-Z][A-Z][A-Z]'
        AND line.currency = scoped.currency AND typeof(line.unit_cost_minor) = 'integer'
        AND typeof(line.ordered_quantity) = 'integer' AND typeof(line.received_quantity) = 'integer'
        AND line.unit_cost_minor >= 0 THEN 1 ELSE 0 END) AS price_available,
        ${productParts('ordered')}, ${productParts('received')}
      FROM scoped_orders scoped
      JOIN purchase_order_lines line ON line.tenant_id = scoped.tenant_id AND line.purchase_order_id = scoped.id
      GROUP BY scoped.id
    ), ${ledgerValues('payment')}, ${ledgerValues('invoice')}, finance_amounts AS (
      SELECT scoped.*,
        ${['ordered', 'received'].flatMap((field) => costPartIndexes.map((index) =>
          `CASE WHEN costs.price_available THEN costs.${field}_${index} END AS ${field}_${index}`)).join(', ')},
        ${(['payment', 'invoice'] as const).flatMap((kind) => moneyPartIndexes.map((index) => {
          const column = `${ledgerDefinition[kind].field}_${index}`;
          return `COALESCE(${kind}.${column}, 0) AS ${column}`;
        })).join(', ')},
        COALESCE(payment.payment_count, 0) AS payment_count, COALESCE(invoice.invoice_count, 0) AS invoice_count
      FROM scoped_orders scoped
      LEFT JOIN order_costs costs ON costs.id = scoped.id
      LEFT JOIN payment_values payment ON payment.id = scoped.id
      LEFT JOIN invoice_values invoice ON invoice.id = scoped.id
    )`;
}

const financeOrderSelect = `SELECT id, order_no, supplier_name, status, currency, issued_at, payment_terms,
  ${financeMoneyColumns(false)}, payment_count, invoice_count FROM finance_amounts`;

export function requireFinanceAccess(user: UserContext, permission: 'finance:read' | 'finance:write' = 'finance:read') {
  if (!user.permissions.includes(permission)) throw new HttpError(403, '当前账号没有该项财务台账权限', 'FINANCE_PERMISSION_DENIED');
}

export async function listFinanceOrders(db: D1Database, user: UserContext, input: {
  scope: FinanceScope; search: string; page: number;
}) {
  requireFinanceAccess(user);
  const filter = input.search ? `AND (instr(lower(po.order_no), lower(?)) > 0
    OR instr(lower(COALESCE(po.supplier_name_snapshot, supplier.name)), lower(?)) > 0)` : '';
  const base = financeAmounts(`${scopeCondition[input.scope]} ${filter}`);
  const bindings = [user.tenantId, ...(input.search ? [input.search, input.search] : [])];
  const [orders, totals] = await db.batch<FinanceOrderRow | FinanceTotalRow>([
    db.prepare(`${base} ${financeOrderSelect}
      ORDER BY COALESCE(issued_at, updated_at) DESC, id DESC LIMIT ? OFFSET ?
    `).bind(...bindings, financePageSize, (input.page - 1) * financePageSize),
    db.prepare(`${base}
      SELECT currency, COUNT(*) AS order_count, COUNT(ordered_0) AS valued_order_count,
        ${financeMoneyColumns(true)}, SUM(payment_count) AS payment_count, SUM(invoice_count) AS invoice_count
      FROM finance_amounts GROUP BY currency ORDER BY currency
    `).bind(...bindings),
  ]);
  const currencies = (totals.results as FinanceTotalRow[]).map((row) => ({
    currency: row.currency,
    orderCount: Number(row.order_count),
    valuedOrderCount: Number(row.valued_order_count),
    orderedMinor: decodeMinor(row.ordered_minor),
    receivedMinor: decodeMinor(row.received_minor),
    paidMinor: decodeMinor(row.paid_minor) ?? '0',
    invoicedMinor: decodeMinor(row.invoiced_minor) ?? '0',
    paymentCount: Number(row.payment_count),
    invoiceCount: Number(row.invoice_count),
  }));
  return {
    orders: (orders.results as FinanceOrderRow[]).map(mapOrder),
    currencies,
    total: currencies.reduce((sum, row) => sum + row.orderCount, 0),
    page: input.page,
    pageSize: financePageSize,
  };
}

function remainingAmount(ledger: FinanceLedgerKind, alias: string) {
  const { table, original } = ledgerDefinition[ledger];
  return `${alias}.amount_minor - COALESCE((
    SELECT SUM(reversal.amount_minor) FROM ${table} reversal
    WHERE reversal.tenant_id = ${alias}.tenant_id AND reversal.purchase_order_id = ${alias}.purchase_order_id
      AND reversal.${original} = ${alias}.id AND reversal.kind = 'reversal'
  ), 0)`;
}

export async function getFinanceLedger(db: D1Database, user: UserContext, orderId: string, ledger: FinanceLedgerKind, page: number) {
  requireFinanceAccess(user);
  const { table, date, original } = ledgerDefinition[ledger];
  const [orders, entries] = await db.batch<FinanceOrderRow | LedgerRow>([
    db.prepare(`${financeAmounts('AND po.id = ?')} ${financeOrderSelect}`)
      .bind(user.tenantId, orderId),
    db.prepare(`
      SELECT entry.id, entry.kind, CAST(entry.amount_minor AS TEXT) AS amount_minor,
        entry.currency, entry.${date} AS occurred_at, entry.reference, entry.note, entry.created_at,
        member.display_name AS recorded_by, original.reference AS original_reference,
        CASE WHEN entry.kind = '${ledger}' THEN CAST(${remainingAmount(ledger, 'entry')} AS TEXT) END AS reversible_minor
      FROM ${table} entry
      JOIN members member ON member.id = entry.created_by_member_id AND member.tenant_id = entry.tenant_id
      LEFT JOIN ${table} original ON original.id = entry.${original}
        AND original.tenant_id = entry.tenant_id AND original.purchase_order_id = entry.purchase_order_id
      WHERE entry.tenant_id = ? AND entry.purchase_order_id = ?
      ORDER BY entry.${date} DESC, entry.created_at DESC, entry.id DESC LIMIT ? OFFSET ?
    `).bind(user.tenantId, orderId, financeLedgerPageSize, (page - 1) * financeLedgerPageSize),
  ]);
  const order = orders.results[0] as FinanceOrderRow | undefined;
  if (!order) throw new HttpError(404, '当前工作区找不到此采购单', 'FINANCE_ORDER_NOT_FOUND');
  return {
    order: mapOrder(order),
    entries: (entries.results as LedgerRow[]).map((row) => ({
      id: row.id,
      kind: row.kind,
      amountMinor: row.amount_minor,
      currency: row.currency,
      occurredAt: row.occurred_at,
      reference: row.reference,
      note: row.note,
      originalReference: row.original_reference,
      reversibleMinor: row.reversible_minor,
      createdAt: row.created_at,
      recordedBy: row.recorded_by,
    })),
    ledger,
    page,
    pageSize: financeLedgerPageSize,
  };
}

type LedgerInput = z.infer<z.ZodObject<typeof entryFields>> & {
  ledger: FinanceLedgerKind;
  kind: 'payment' | 'invoice' | 'reversal';
  occurredAt: string;
  originalEntryId: string | null;
};

export function addPurchasePayment(db: D1Database, user: UserContext, input: NewPayment, key: string) {
  const { paidAt, ...fields } = input;
  return addLedgerEntry(db, user, { ...fields, ledger: 'payment', occurredAt: paidAt,
    originalEntryId: input.kind === 'reversal' ? input.originalPaymentId : null }, key);
}

export function addPurchaseInvoice(db: D1Database, user: UserContext, input: NewInvoice, key: string) {
  const { invoiceOn, ...fields } = input;
  return addLedgerEntry(db, user, { ...fields, ledger: 'invoice', occurredAt: invoiceOn,
    originalEntryId: input.kind === 'reversal' ? input.originalInvoiceId : null }, key);
}

async function readPaymentBalance(db: D1Database, tenantId: string, purchaseOrderId: string) {
  const budget = await db.prepare(`${financeAmounts('AND po.id = ?')}
    SELECT version, ${encodeMinor('ordered', costPartIndexes, false)},
      ${encodeMinor('paid', moneyPartIndexes, false)}, payment_count FROM finance_amounts
  `).bind(tenantId, purchaseOrderId).first<Pick<FinanceOrderRow, 'ordered_minor' | 'paid_minor' | 'payment_count'> & { version: number }>();
  if (!budget) return null;
  const ordered = decodeMinor(budget.ordered_minor);
  return {
    version: budget.version, paymentCount: budget.payment_count,
    remaining: ordered === null ? null : BigInt(ordered) - BigInt(decodeMinor(budget.paid_minor) ?? '0'),
  };
}

async function addLedgerEntry(db: D1Database, user: UserContext, input: LedgerInput, key: string) {
  requireFinanceAccess(user, 'finance:write');
  const { ledger, occurredAt, originalEntryId } = input;
  const { table, date, original } = ledgerDefinition[ledger];
  const label = ledger === 'invoice' ? '发票' : '付款';
  const idempotencyKey = key.trim();
  if (!/^[A-Za-z0-9_-]{16,100}$/u.test(idempotencyKey)) {
    throw new HttpError(400, `${label}登记缺少有效的幂等键，请刷新后重试`, 'INVALID_FINANCE_IDEMPOTENCY_KEY');
  }
  const now = new Date();
  const timestamp = now.toISOString();
  const todayInChina = new Date(now.valueOf() + 8 * 60 * 60_000).toISOString().slice(0, 10);
  if (occurredAt > (ledger === 'invoice' ? todayInChina : timestamp)) {
    throw new HttpError(400, '单据发生时间不能晚于当前时间', 'FINANCE_ENTRY_IN_FUTURE');
  }
  const isReversal = input.kind === 'reversal';
  const note = input.note || null;
  const { kind, purchaseOrderId, amountMinor, currency: entryCurrency, reference } = input;
  const hashFields = { kind, purchaseOrderId, amountMinor, currency: entryCurrency, reference, note };
  const originalInput = ledger === 'payment'
    ? { ...hashFields, paidAt: occurredAt, ...(isReversal ? { originalPaymentId: originalEntryId } : {}) }
    : { ...hashFields, invoiceOn: occurredAt, ...(isReversal ? { originalInvoiceId: originalEntryId } : {}) };
  const hash = await sha256Hex(stableJson(originalInput));
  const entryId = crypto.randomUUID();

  const linkedLedger = `original.kind = '${ledger}' AND original.tenant_id = po.tenant_id
    AND original.purchase_order_id = po.id AND original.currency = po.currency`;
  const reversalCondition = `AND EXISTS (
    SELECT 1 FROM ${table} original WHERE original.id = ? AND original.${date} <= ?
      AND ${linkedLedger} AND ${remainingAmount(ledger, 'original')} >= ?
      AND NOT EXISTS (SELECT 1 FROM ${table} known
        WHERE known.tenant_id = original.tenant_id AND known.purchase_order_id = original.purchase_order_id
          AND known.${original} = original.id AND known.kind = 'reversal' AND lower(known.reference) = lower(?))
  )`;
  const duplicateDocumentCondition = `AND NOT EXISTS (
    SELECT 1 FROM ${table} original WHERE lower(original.reference) = lower(?)
      AND ${linkedLedger} AND ${remainingAmount(ledger, 'original')} > 0
  )`;
  const recordingPayment = ledger === 'payment' && !isReversal;
  const balance = recordingPayment ? await readPaymentBalance(db, user.tenantId, purchaseOrderId) : null;
  const withinBudget = balance?.remaining != null && balance.remaining >= BigInt(amountMinor);
  // PO cost edits advance its version. Actual payments and reversals are append-only.
  // Check both observations in the write so two operators cannot use the same available balance.
  const paymentGuard = recordingPayment ? `AND ? = 1 AND po.version = ? AND (
    SELECT COUNT(*) FROM purchase_payments entry WHERE entry.tenant_id = po.tenant_id
      AND entry.purchase_order_id = po.id AND entry.currency = po.currency
  ) = ?` : '';
  const condition = isReversal ? reversalCondition : `AND po.status IN ${committedStatuses} ${duplicateDocumentCondition} ${paymentGuard}`;
  const conditionBindings = isReversal ? [originalEntryId, occurredAt, amountMinor, reference]
    : recordingPayment ? [reference, withinBudget ? 1 : 0, balance?.version ?? null, balance?.paymentCount ?? null] : [reference];
  const [write] = await db.batch([
    db.prepare(`
      INSERT INTO ${table} (id, tenant_id, purchase_order_id, kind, amount_minor, currency, ${date}, reference, note,
        ${original}, created_by_member_id, idempotency_key, request_hash, created_at)
      SELECT ?, po.tenant_id, po.id, ?, ?, po.currency, ?, ?, ?, ?, member.id, ?, ?, ?
      FROM purchase_orders po
      JOIN members member ON member.tenant_id = po.tenant_id AND member.auth_user_id = ?
        AND ((member.role = 'admin' AND member.access_profile IS NULL) OR member.access_profile = 'finance')
      JOIN suppliers supplier ON supplier.tenant_id = po.tenant_id AND supplier.id = po.supplier_id
      WHERE po.tenant_id = ? AND po.id = ? AND po.currency = ? ${condition}
      ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
    `).bind(entryId, input.kind, input.amountMinor, occurredAt, input.reference, note, originalEntryId,
      idempotencyKey, hash, timestamp, user.id, user.tenantId, input.purchaseOrderId, input.currency, ...conditionBindings),
    db.prepare(`
      INSERT INTO audit_logs (id, tenant_id, actor_id, actor_email, action, entity_type, entity_id,
        before_json, after_json, request_id, idempotency_key, source, created_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 'human', ?
      WHERE EXISTS (SELECT 1 FROM ${table} WHERE id = ? AND tenant_id = ?)
    `).bind(crypto.randomUUID(), user.tenantId, user.id, user.email,
      `purchase_${ledger}_${isReversal ? 'reversed' : 'recorded'}`, `purchase_${ledger}`, entryId,
      stableJson({ purchaseOrderId: input.purchaseOrderId, amountMinor: input.amountMinor, currency: input.currency,
        occurredAt, originalEntryId }), crypto.randomUUID(), idempotencyKey, timestamp,
      entryId, user.tenantId),
  ]);
  if (write.meta.changes === 1) return { id: entryId, replayed: false };

  const existing = await db.prepare(`SELECT id, request_hash FROM ${table} WHERE tenant_id = ? AND idempotency_key = ?`)
    .bind(user.tenantId, idempotencyKey).first<{ id: string; request_hash: string }>();
  if (existing) {
    if (existing.request_hash !== hash) {
      throw new HttpError(409, `此幂等键已用于其他${label}登记，请重新确认表单`, 'FINANCE_IDEMPOTENCY_CONFLICT');
    }
    return { id: existing.id, replayed: true };
  }
  const order = await db.prepare('SELECT currency, status FROM purchase_orders WHERE tenant_id = ? AND id = ?')
    .bind(user.tenantId, input.purchaseOrderId).first<{ currency: string | null; status: FinanceStatus }>();
  if (!order) throw new HttpError(404, '当前工作区找不到此采购单', 'FINANCE_ORDER_NOT_FOUND');
  if (order.currency !== input.currency) throw new HttpError(409, '登记币种与采购单不一致，请刷新后核对', 'FINANCE_CURRENCY_MISMATCH');
  if (isReversal) {
    throw new HttpError(409, `请核对原${label}的可冲正余额、冲正凭证编号及发生时间`, 'FINANCE_REVERSAL_CONFLICT');
  }
  const duplicate = await db.prepare(`
    SELECT 1 FROM ${table} original
    WHERE original.tenant_id = ? AND original.purchase_order_id = ? AND original.currency = ?
      AND original.kind = '${ledger}' AND lower(original.reference) = lower(?) AND ${remainingAmount(ledger, 'original')} > 0
  `).bind(user.tenantId, input.purchaseOrderId, input.currency, input.reference).first();
  if (duplicate) throw new HttpError(409, `此采购单已有同号${label}，请核对原记录和冲正记录`, 'DUPLICATE_FINANCE_REFERENCE');
  if (recordingPayment && ['issued', 'partially_received', 'received', 'closed_short'].includes(order.status)) {
    const current = await readPaymentBalance(db, user.tenantId, purchaseOrderId);
    if (current?.remaining == null) throw new HttpError(409, '采购单原币金额待补齐，无法核对本次付款额度', 'FINANCE_PAYMENT_AMOUNT_UNKNOWN');
    if (current.remaining < BigInt(amountMinor)) {
      throw new HttpError(409, '登记金额超过采购单当前应付余额，请核对已付及冲正记录', 'FINANCE_PAYMENT_BALANCE_EXCEEDED');
    }
    if (balance?.version !== current.version || balance?.paymentCount !== current.paymentCount) {
      throw new HttpError(409, '采购单或实付记录已更新，请刷新台账后重新确认金额', 'FINANCE_PAYMENT_BALANCE_CHANGED');
    }
  }
  throw new HttpError(409, `当前采购单或成员状态无法登记${label}，请刷新后核对`, 'FINANCE_ORDER_NOT_AVAILABLE');
}

function mapOrder(row: FinanceOrderRow) {
  const canRecordInvoice = row.currency !== null && currency.safeParse(row.currency).success
    && ['issued', 'partially_received', 'received', 'closed_short'].includes(row.status);
  const orderedMinor = decodeMinor(row.ordered_minor);
  const receivedMinor = decodeMinor(row.received_minor);
  const paidMinor = decodeMinor(row.paid_minor) ?? '0';
  const invoicedMinor = decodeMinor(row.invoiced_minor) ?? '0';
  const invoiceCount = Number(row.invoice_count);
  const difference = (left: string, right: string) => (BigInt(left) - BigInt(right)).toString();
  const differenceMinor = canRecordInvoice && orderedMinor !== null ? difference(orderedMinor, paidMinor) : null;
  return {
    id: row.id,
    orderNo: row.order_no,
    supplierName: row.supplier_name,
    status: row.status,
    currency: row.currency,
    orderedMinor,
    receivedMinor,
    paidMinor,
    paymentCount: Number(row.payment_count),
    invoicedMinor,
    invoiceCount,
    differenceMinor,
    invoiceOrderDifferenceMinor: invoiceCount && orderedMinor !== null ? difference(invoicedMinor, orderedMinor) : null,
    invoiceReceiptDifferenceMinor: invoiceCount && receivedMinor !== null ? difference(invoicedMinor, receivedMinor) : null,
    invoicePaymentDifferenceMinor: invoiceCount ? difference(invoicedMinor, paidMinor) : null,
    issuedAt: row.issued_at,
    paymentTerms: row.payment_terms,
    canRecordInvoice,
    canRecordPayment: differenceMinor !== null && BigInt(differenceMinor) > BigInt(0),
  };
}
