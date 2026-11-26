import { sql } from 'drizzle-orm';
import { check, index, integer, primaryKey, sqliteTable, text, type AnySQLiteColumn } from 'drizzle-orm/sqlite-core';

export function defineNineStoreOrderHistory(references: { tenantId: AnySQLiteColumn }) {
  return sqliteTable('nine_store_order_history', {
    tenantId: text('tenant_id').notNull().references(() => references.tenantId),
    sourceTable: text('source_table').notNull(),
    sourceRecordId: text('source_record_id').notNull(),
    storeKey: text('store_key').notNull(),
    orderNo: text('order_no').notNull(),
    sku: text('sku'),
    eventDate: text('event_date'),
    quantity: integer('quantity'),
    fulfillment: text('fulfillment'),
    observedAt: text('observed_at').notNull(),
    archivedAt: text('archived_at').notNull(),
    change: text('change', { enum: ['updated', 'removed'] }).notNull(),
  }, (table) => [
    primaryKey({ columns: [table.tenantId, table.sourceTable, table.sourceRecordId, table.observedAt] }),
    index('idx_nine_store_history_archive').on(table.tenantId, table.archivedAt, table.sourceTable),
    index('idx_nine_store_history_store').on(table.tenantId, table.storeKey, table.archivedAt),
    check('ck_nine_store_history_source', sql`${table.sourceTable} IN ('amazon-orders', 'shopify-orders', 'wayfair-orders', 'refunds')`),
    check('ck_nine_store_history_change', sql`${table.change} IN ('updated', 'removed')`),
    check('ck_nine_store_history_dates', sql`${table.archivedAt} > ${table.observedAt}`),
  ]);
}
