import { sql } from 'drizzle-orm';
import { check, integer, sqliteTable, text, uniqueIndex, type AnySQLiteColumn } from 'drizzle-orm/sqlite-core';

export function createWarehouseOutboundEventsTable(references: {
  tenant: () => AnySQLiteColumn;
  order: () => AnySQLiteColumn;
}) {
  return sqliteTable('warehouse_outbound_events', {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull().references(references.tenant),
    orderId: text('order_id').notNull().references(references.order),
    version: integer('version').notNull(),
    step: text('step', { enum: ['pick', 'verify', 'pack'] }).notNull(),
    quantity: integer('quantity'),
    skuCode: text('sku_code'),
    packageCount: integer('package_count'),
    operationKey: text('operation_key').notNull(),
    requestHash: text('request_hash').notNull(),
    createdBy: text('created_by').notNull(),
    createdAt: text('created_at').notNull(),
  }, (table) => [
    uniqueIndex('uq_warehouse_outbound_order_version').on(table.tenantId, table.orderId, table.version),
    uniqueIndex('uq_warehouse_outbound_operation').on(table.tenantId, table.operationKey),
    check('ck_warehouse_outbound_stage', sql`
      (${table.version} = 1 AND ${table.step} = 'pick' AND typeof(${table.quantity}) = 'integer'
        AND ${table.quantity} BETWEEN 1 AND 2147483647 AND ${table.skuCode} IS NULL AND ${table.packageCount} IS NULL)
      OR (${table.version} = 2 AND ${table.step} = 'verify' AND typeof(${table.quantity}) = 'integer'
        AND ${table.quantity} BETWEEN 1 AND 2147483647 AND ${table.skuCode} IS NOT NULL
        AND length(trim(${table.skuCode})) BETWEEN 1 AND 160 AND ${table.packageCount} IS NULL)
      OR (${table.version} = 3 AND ${table.step} = 'pack' AND ${table.quantity} IS NULL AND ${table.skuCode} IS NULL
        AND typeof(${table.packageCount}) = 'integer' AND ${table.packageCount} BETWEEN 1 AND 2147483647)
    `),
  ]);
}
