import { sql } from 'drizzle-orm';
import { check, primaryKey, sqliteTable, text, uniqueIndex, type AnySQLiteColumn } from 'drizzle-orm/sqlite-core';

export function makeNineStoreHandoffSchema(references: {
  tenants: { id: AnySQLiteColumn };
  orders: { id: AnySQLiteColumn };
  platformOrders: { id: AnySQLiteColumn };
  platformStores: { id: AnySQLiteColumn };
  platformOrderLines: { id: AnySQLiteColumn };
}) {
  const nineStoreOrderHandoffs = sqliteTable('nine_store_order_handoffs', {
    tenantId: text('tenant_id').notNull().references(() => references.tenants.id),
    platform: text('platform', { enum: ['amazon', 'shopify', 'wayfair'] }).notNull(),
    storeKey: text('store_key').notNull(),
    sourceOrderKey: text('source_order_key').notNull(),
    sourceOrderNo: text('source_order_no').notNull(),
    sourceRecordId: text('source_record_id').notNull(),
    sourceSku: text('source_sku').notNull(),
    sourceObservedAt: text('source_observed_at').notNull(),
    orderId: text('order_id').notNull().references(() => references.orders.id),
    requestHash: text('request_hash').notNull(),
    createdAt: text('created_at').notNull(),
  }, (table) => [
    primaryKey({ columns: [table.tenantId, table.storeKey, table.sourceOrderKey] }),
    uniqueIndex('uq_nine_store_handoff_source_record').on(table.tenantId, table.platform, table.sourceRecordId),
    uniqueIndex('uq_nine_store_handoff_erp_order').on(table.orderId),
    check('ck_nine_store_handoff_platform', sql`${table.platform} IN ('amazon', 'shopify', 'wayfair')`),
  ]);
  const nativeChannelHandoffProofs = sqliteTable('native_channel_handoff_proofs', {
    orderId: text('order_id').primaryKey().notNull().references(() => references.orders.id),
    tenantId: text('tenant_id').notNull().references(() => references.tenants.id),
    platformStoreId: text('platform_store_id').notNull().references(() => references.platformStores.id),
    officialStoreId: text('official_store_id').notNull(),
    platformOrderId: text('platform_order_id').notNull().references(() => references.platformOrders.id),
    platformLineId: text('platform_line_id').notNull().references(() => references.platformOrderLines.id),
    sourceVersion: text('source_version').notNull(),
  }, (table) => [uniqueIndex('uq_native_channel_handoff_order').on(table.tenantId, table.platformOrderId)]);
  return { nineStoreOrderHandoffs, nativeChannelHandoffProofs };
}
