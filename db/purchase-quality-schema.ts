import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text, uniqueIndex, type AnySQLiteColumn } from 'drizzle-orm/sqlite-core';

export function createPurchaseQualityTables(references: {
  tenant: () => AnySQLiteColumn;
  order: () => AnySQLiteColumn;
  orderLine: () => AnySQLiteColumn;
  member: () => AnySQLiteColumn;
}) {
  const requirements = sqliteTable('purchase_quality_requirements', {
    purchaseOrderId: text('purchase_order_id').primaryKey().references(references.order),
    tenantId: text('tenant_id').notNull().references(references.tenant),
    reason: text('reason').notNull(),
    createdByMemberId: text('created_by_member_id').notNull().references(references.member),
    operationKey: text('operation_key').notNull(),
    requestHash: text('request_hash').notNull(),
    createdAt: text('created_at').notNull(),
  }, (table) => [
    uniqueIndex('uq_purchase_quality_requirements_operation').on(table.tenantId, table.operationKey),
    check('ck_purchase_quality_requirement_reason', sql`length(trim(${table.reason})) BETWEEN 1 AND 500`),
  ]);

  const inspections = sqliteTable('purchase_quality_inspections', {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull().references(references.tenant),
    purchaseOrderId: text('purchase_order_id').notNull().references(references.order),
    batchReference: text('batch_reference').notNull(),
    note: text('note'),
    createdByMemberId: text('created_by_member_id').notNull().references(references.member),
    operationKey: text('operation_key').notNull(),
    requestHash: text('request_hash').notNull(),
    createdAt: text('created_at').notNull(),
  }, (table) => [
    uniqueIndex('uq_purchase_quality_inspections_operation').on(table.tenantId, table.operationKey),
    uniqueIndex('uq_purchase_quality_inspections_batch').on(table.tenantId, table.purchaseOrderId, sql`lower(${table.batchReference})`),
    index('idx_purchase_quality_inspections_order').on(table.tenantId, table.purchaseOrderId, table.createdAt, table.id),
    check('ck_purchase_quality_batch_reference', sql`length(trim(${table.batchReference})) BETWEEN 1 AND 100`),
    check('ck_purchase_quality_inspection_note', sql`${table.note} IS NULL OR length(trim(${table.note})) BETWEEN 1 AND 500`),
  ]);

  const lines = sqliteTable('purchase_quality_inspection_lines', {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull().references(references.tenant),
    inspectionId: text('inspection_id').notNull().references(() => inspections.id),
    purchaseOrderLineId: text('purchase_order_line_id').notNull().references(references.orderLine),
    passedQty: integer('passed_qty').notNull(),
    rejectedQty: integer('rejected_qty').notNull(),
    defectReason: text('defect_reason'),
  }, (table) => [
    uniqueIndex('uq_purchase_quality_inspection_order_line').on(table.inspectionId, table.purchaseOrderLineId),
    index('idx_purchase_quality_inspection_lines_inspection').on(table.tenantId, table.inspectionId),
    index('idx_purchase_quality_inspection_lines_order_line').on(table.tenantId, table.purchaseOrderLineId),
    check('ck_purchase_quality_inspection_line_quantities', sql`
      typeof(${table.passedQty}) = 'integer' AND typeof(${table.rejectedQty}) = 'integer'
      AND ${table.passedQty} >= 0 AND ${table.rejectedQty} >= 0
      AND ${table.passedQty} + ${table.rejectedQty} BETWEEN 1 AND 1000000
    `),
    check('ck_purchase_quality_inspection_defect_reason', sql`
      (${table.rejectedQty} = 0 AND ${table.defectReason} IS NULL)
      OR (${table.rejectedQty} > 0 AND ${table.defectReason} IS NOT NULL AND length(trim(${table.defectReason})) BETWEEN 1 AND 500)
    `),
  ]);
  return { requirements, inspections, lines };
}
