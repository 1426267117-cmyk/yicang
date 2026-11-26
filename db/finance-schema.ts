import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text, uniqueIndex, type AnySQLiteColumn } from 'drizzle-orm/sqlite-core';

type LedgerReferences = {
  tenantId: AnySQLiteColumn;
  purchaseOrderId: AnySQLiteColumn;
  memberId: AnySQLiteColumn;
};

export function definePurchasePayments(references: LedgerReferences) {
  const payments = sqliteTable('purchase_payments', {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull().references(() => references.tenantId),
    purchaseOrderId: text('purchase_order_id').notNull().references(() => references.purchaseOrderId),
    kind: text('kind', { enum: ['payment', 'reversal'] }).notNull(),
    amountMinor: integer('amount_minor').notNull(),
    currency: text('currency').notNull(),
    paidAt: text('paid_at').notNull(),
    reference: text('reference').notNull(),
    note: text('note'),
    originalPaymentId: text('original_payment_id').references((): AnySQLiteColumn => payments.id),
    createdByMemberId: text('created_by_member_id').notNull().references(() => references.memberId),
    idempotencyKey: text('idempotency_key').notNull(),
    requestHash: text('request_hash').notNull(),
    createdAt: text('created_at').notNull(),
  }, (table) => [
    uniqueIndex('uq_purchase_payments_idempotency').on(table.tenantId, table.idempotencyKey),
    index('idx_purchase_payments_order').on(table.tenantId, table.purchaseOrderId, table.paidAt),
    index('idx_purchase_payments_original').on(table.tenantId, table.originalPaymentId),
    check('ck_purchase_payments_amount', sql`${table.amountMinor} > 0`),
    check('ck_purchase_payments_currency', sql`${table.currency} GLOB '[A-Z][A-Z][A-Z]'`),
    check('ck_purchase_payments_kind', sql`(${table.kind} = 'payment' AND ${table.originalPaymentId} IS NULL) OR (${table.kind} = 'reversal' AND ${table.originalPaymentId} IS NOT NULL)`),
  ]);
  return payments;
}

export function definePurchaseInvoices(references: LedgerReferences) {
  const invoices = sqliteTable('purchase_invoices', {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull().references(() => references.tenantId),
    purchaseOrderId: text('purchase_order_id').notNull().references(() => references.purchaseOrderId),
    kind: text('kind', { enum: ['invoice', 'reversal'] }).notNull(),
    amountMinor: integer('amount_minor').notNull(),
    currency: text('currency').notNull(),
    invoiceOn: text('invoice_on').notNull(),
    reference: text('reference').notNull(),
    note: text('note'),
    originalInvoiceId: text('original_invoice_id').references((): AnySQLiteColumn => invoices.id),
    createdByMemberId: text('created_by_member_id').notNull().references(() => references.memberId),
    idempotencyKey: text('idempotency_key').notNull(),
    requestHash: text('request_hash').notNull(),
    createdAt: text('created_at').notNull(),
  }, (table) => [
    uniqueIndex('uq_purchase_invoices_idempotency').on(table.tenantId, table.idempotencyKey),
    index('idx_purchase_invoices_order').on(table.tenantId, table.purchaseOrderId, table.invoiceOn),
    index('idx_purchase_invoices_original').on(table.tenantId, table.originalInvoiceId),
    check('ck_purchase_invoices_amount', sql`${table.amountMinor} > 0`),
    check('ck_purchase_invoices_currency', sql`${table.currency} GLOB '[A-Z][A-Z][A-Z]'`),
    check('ck_purchase_invoices_kind', sql`(${table.kind} = 'invoice' AND ${table.originalInvoiceId} IS NULL) OR (${table.kind} = 'reversal' AND ${table.originalInvoiceId} IS NOT NULL)`),
  ]);
  return invoices;
}
