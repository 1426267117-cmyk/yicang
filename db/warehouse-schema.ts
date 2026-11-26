import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text, uniqueIndex, type AnySQLiteColumn } from 'drizzle-orm/sqlite-core';

export function createWarehouseStockCountsTable(references: {
  tenant: () => AnySQLiteColumn;
  warehouse: () => AnySQLiteColumn;
  sku: () => AnySQLiteColumn;
}) {
  return sqliteTable('warehouse_stock_counts', {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull().references(references.tenant),
    skuId: text('sku_id').notNull().references(references.sku),
    warehouseId: text('warehouse_id').notNull().references(references.warehouse),
    beforeOnHandQty: integer('before_on_hand_qty').notNull(),
    reservedQty: integer('reserved_qty').notNull(),
    countedQty: integer('counted_qty').notNull(),
    inventoryVersion: integer('inventory_version').notNull(),
    reason: text('reason').notNull(),
    operationKey: text('operation_key').notNull(),
    requestHash: text('request_hash').notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: text('created_at').notNull(),
  }, (table) => [
    uniqueIndex('uq_warehouse_stock_counts_operation').on(table.tenantId, table.operationKey),
    index('idx_warehouse_stock_counts_history').on(table.tenantId, table.createdAt, table.id),
    index('idx_warehouse_stock_counts_warehouse').on(table.tenantId, table.warehouseId, table.createdAt, table.id),
    check('ck_warehouse_stock_counts_quantities', sql`
      ${table.reservedQty} >= 0 AND ${table.beforeOnHandQty} >= ${table.reservedQty}
      AND ${table.countedQty} >= ${table.reservedQty} AND ${table.countedQty} <= 2147483647
    `),
    check('ck_warehouse_stock_counts_version', sql`${table.inventoryVersion} >= 0`),
    check('ck_warehouse_stock_counts_reason', sql`length(trim(${table.reason})) BETWEEN 1 AND 500`),
  ]);
}
