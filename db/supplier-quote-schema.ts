import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text, uniqueIndex, type AnySQLiteColumn } from 'drizzle-orm/sqlite-core';

export function defineSupplierQuotes(references: {
  tenantId: AnySQLiteColumn;
  supplierId: AnySQLiteColumn;
  skuId: AnySQLiteColumn;
  memberId: AnySQLiteColumn;
}) {
  return sqliteTable('purchase_supplier_quotes', {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull().references(() => references.tenantId),
    supplierId: text('supplier_id').notNull().references(() => references.supplierId),
    skuId: text('sku_id').notNull().references(() => references.skuId),
    currency: text('currency').notNull(),
    version: integer('version').notNull(),
    status: text('status', { enum: ['active', 'archived'] }).notNull(),
    validFrom: text('valid_from').notNull(),
    validThrough: text('valid_through'),
    tiersJson: text('tiers_json').notNull(),
    reference: text('reference'),
    note: text('note'),
    createdByMemberId: text('created_by_member_id').notNull().references(() => references.memberId),
    idempotencyKey: text('idempotency_key').notNull(),
    requestHash: text('request_hash').notNull(),
    createdAt: text('created_at').notNull(),
  }, (table) => [
    uniqueIndex('uq_supplier_quotes_version').on(table.tenantId, table.skuId, table.supplierId, table.currency, table.version),
    uniqueIndex('uq_supplier_quotes_idempotency').on(table.tenantId, table.idempotencyKey),
    index('idx_supplier_quotes_sku').on(table.tenantId, table.skuId, table.supplierId, table.currency, table.version),
    check('ck_supplier_quotes_version', sql`${table.version} > 0`),
    check('ck_supplier_quotes_status', sql`${table.status} IN ('active', 'archived')`),
    check('ck_supplier_quotes_currency', sql`${table.currency} GLOB '[A-Z][A-Z][A-Z]'`),
    check('ck_supplier_quotes_validity', sql`${table.validThrough} IS NULL OR ${table.validThrough} >= ${table.validFrom}`),
    check('ck_supplier_quotes_tiers', sql`json_valid(${table.tiersJson}) AND json_type(${table.tiersJson}) = 'array' AND json_array_length(${table.tiersJson}) BETWEEN 1 AND 20`),
  ]);
}
