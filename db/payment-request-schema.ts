import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text, uniqueIndex, type AnySQLiteColumn } from 'drizzle-orm/sqlite-core';

type MemberReferences = { tenantId: AnySQLiteColumn; memberId: AnySQLiteColumn };

export function definePurchasePaymentRequests(references: MemberReferences & { purchaseOrderId: AnySQLiteColumn }) {
  return sqliteTable('purchase_payment_requests', {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull().references(() => references.tenantId),
    purchaseOrderId: text('purchase_order_id').notNull().references(() => references.purchaseOrderId),
    requestedByMemberId: text('requested_by_member_id').notNull().references(() => references.memberId),
    businessType: text('business_type', { enum: ['prepayment', 'balance'] }).notNull(),
    amountMinor: integer('amount_minor').notNull(),
    currency: text('currency').notNull(),
    dueOn: text('due_on').notNull(),
    reason: text('reason').notNull(),
    reference: text('reference'),
    submissionHash: text('submission_hash').notNull(),
    status: text('status', { enum: ['pending', 'approved', 'rejected', 'withdrawn', 'cancelled'] }).notNull(),
    version: integer('version').notNull(),
    reviewedByMemberId: text('reviewed_by_member_id').references(() => references.memberId),
    reviewNote: text('review_note'),
    reviewedAt: text('reviewed_at'),
    closedByMemberId: text('closed_by_member_id').references(() => references.memberId),
    closeNote: text('close_note'),
    closedAt: text('closed_at'),
    lastOperationKey: text('last_operation_key').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  }, (table) => [
    index('idx_payment_requests_order').on(table.tenantId, table.purchaseOrderId, table.status),
    index('idx_payment_requests_requester').on(table.tenantId, table.requestedByMemberId, table.createdAt),
    check('ck_payment_requests_amount', sql`${table.amountMinor} > 0`),
    check('ck_payment_requests_currency', sql`${table.currency} GLOB '[A-Z][A-Z][A-Z]'`),
    check('ck_payment_requests_type', sql`${table.businessType} IN ('prepayment', 'balance')`),
    check('ck_payment_requests_status', sql`${table.status} IN ('pending', 'approved', 'rejected', 'withdrawn', 'cancelled')`),
    check('ck_payment_requests_version', sql`${table.version} > 0`),
  ]);
}

export function definePurchasePaymentRequestLinks(references: MemberReferences & { requestId: AnySQLiteColumn; paymentId: AnySQLiteColumn }) {
  return sqliteTable('purchase_payment_request_links', {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull().references(() => references.tenantId),
    requestId: text('request_id').notNull().references(() => references.requestId),
    paymentId: text('payment_id').notNull().references(() => references.paymentId),
    linkedByMemberId: text('linked_by_member_id').notNull().references(() => references.memberId),
    linkedAt: text('linked_at').notNull(),
    detachedByMemberId: text('detached_by_member_id').references(() => references.memberId),
    detachedAt: text('detached_at'),
    lastOperationKey: text('last_operation_key').notNull(),
  }, (table) => [
    uniqueIndex('uq_payment_request_one_active_link').on(table.tenantId, table.paymentId)
      .where(sql`${table.detachedAt} IS NULL`),
    index('idx_payment_request_links_request').on(table.tenantId, table.requestId, table.detachedAt),
    check('ck_payment_request_link_detach', sql`(${table.detachedAt} IS NULL) = (${table.detachedByMemberId} IS NULL)`),
  ]);
}
