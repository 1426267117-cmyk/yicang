import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

export const tenants = sqliteTable('tenants', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  createdAt: text('created_at').notNull(),
});

export const members = sqliteTable('members', {
  id: text('id').primaryKey(),
  tenantId: text('tenant_id').notNull().references(() => tenants.id),
  authUserId: text('auth_user_id').notNull(),
  email: text('email').notNull(),
  displayName: text('display_name').notNull(),
  role: text('role', { enum: ['admin', 'operator', 'viewer'] }).notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [
  uniqueIndex('uq_members_auth_user').on(table.authUserId),
  index('idx_members_tenant').on(table.tenantId),
]);

export const warehouses = sqliteTable('warehouses', {
  id: text('id').primaryKey(),
  tenantId: text('tenant_id').notNull().references(() => tenants.id),
  code: text('code').notNull(),
  name: text('name').notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [uniqueIndex('uq_warehouses_tenant_code').on(table.tenantId, table.code)]);

export const skus = sqliteTable('skus', {
  id: text('id').primaryKey(),
  tenantId: text('tenant_id').notNull().references(() => tenants.id),
  code: text('code').notNull(),
  name: text('name').notNull(),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  createdAt: text('created_at').notNull(),
}, (table) => [uniqueIndex('uq_skus_tenant_code').on(table.tenantId, table.code)]);

export const inventoryBalances = sqliteTable('inventory_balances', {
  id: text('id').primaryKey(),
  tenantId: text('tenant_id').notNull().references(() => tenants.id),
  skuId: text('sku_id').notNull().references(() => skus.id),
  warehouseId: text('warehouse_id').notNull().references(() => warehouses.id),
  onHandQty: integer('on_hand_qty').notNull(),
  reservedQty: integer('reserved_qty').notNull().default(0),
  version: integer('version').notNull().default(1),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  uniqueIndex('uq_inventory_tenant_sku_warehouse').on(table.tenantId, table.skuId, table.warehouseId),
  index('idx_inventory_tenant_updated').on(table.tenantId, table.updatedAt),
  check('ck_inventory_non_negative', sql`${table.onHandQty} >= 0 AND ${table.reservedQty} >= 0`),
  check('ck_inventory_reserved_lte_on_hand', sql`${table.reservedQty} <= ${table.onHandQty}`),
]);

export const orders = sqliteTable('orders', {
  id: text('id').primaryKey(),
  tenantId: text('tenant_id').notNull().references(() => tenants.id),
  orderNo: text('order_no').notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  requestHash: text('request_hash').notNull(),
  channel: text('channel').notNull(),
  destination: text('destination').notNull(),
  customerName: text('customer_name').notNull(),
  currency: text('currency', { enum: ['CNY', 'USD', 'EUR', 'GBP'] }).notNull(),
  amountMinor: integer('amount_minor').notNull(),
  status: text('status', { enum: ['pending_review', 'reserved', 'shipped', 'cancelled'] }).notNull(),
  skuId: text('sku_id').notNull().references(() => skus.id),
  warehouseId: text('warehouse_id').notNull().references(() => warehouses.id),
  quantity: integer('quantity').notNull(),
  version: integer('version').notNull().default(1),
  createdBy: text('created_by').notNull(),
  updatedBy: text('updated_by').notNull(),
  lastActionKey: text('last_action_key').notNull(),
  requestId: text('request_id').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  uniqueIndex('uq_orders_tenant_order_no').on(table.tenantId, table.orderNo),
  uniqueIndex('uq_orders_tenant_idempotency').on(table.tenantId, table.idempotencyKey),
  index('idx_orders_tenant_created').on(table.tenantId, table.createdAt),
  index('idx_orders_tenant_status').on(table.tenantId, table.status),
  check('ck_orders_amount_positive', sql`${table.amountMinor} > 0`),
  check('ck_orders_quantity_positive', sql`${table.quantity} > 0`),
]);

export const inventoryMovements = sqliteTable('inventory_movements', {
  id: text('id').primaryKey(),
  tenantId: text('tenant_id').notNull().references(() => tenants.id),
  orderId: text('order_id').notNull().references(() => orders.id),
  skuId: text('sku_id').notNull().references(() => skus.id),
  warehouseId: text('warehouse_id').notNull().references(() => warehouses.id),
  type: text('type', { enum: ['reserve', 'release', 'ship'] }).notNull(),
  onHandDelta: integer('on_hand_delta').notNull(),
  reservedDelta: integer('reserved_delta').notNull(),
  operationKey: text('operation_key').notNull(),
  createdBy: text('created_by').notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [
  uniqueIndex('uq_movements_tenant_operation').on(table.tenantId, table.operationKey),
  index('idx_movements_tenant_order').on(table.tenantId, table.orderId),
]);

export const auditLogs = sqliteTable('audit_logs', {
  id: text('id').primaryKey(),
  tenantId: text('tenant_id').notNull().references(() => tenants.id),
  actorId: text('actor_id').notNull(),
  actorEmail: text('actor_email').notNull(),
  action: text('action').notNull(),
  entityType: text('entity_type').notNull(),
  entityId: text('entity_id').notNull(),
  beforeJson: text('before_json'),
  afterJson: text('after_json'),
  requestId: text('request_id').notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  source: text('source').notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [
  uniqueIndex('uq_audit_tenant_idempotency').on(table.tenantId, table.idempotencyKey),
  index('idx_audit_tenant_created').on(table.tenantId, table.createdAt),
]);
