let initialization: Promise<void> | undefined;

export const DATABASE_SCHEMA_READINESS = 'erp-0035';

export const DATABASE_REQUIRED_TABLES = [
  'tenants',
  'members',
  'warehouses',
  'skus',
  'purchase_product_images',
  'inventory_balances',
  'orders',
  'inventory_movements',
  'audit_logs',
  'platform_stores',
  'platform_orders',
  'platform_order_write_leases',
  'platform_order_lines',
  'platform_refunds',
  'platform_refund_lines',
  'platform_order_transactions',
  'platform_fulfillments',
  'platform_fulfillment_lines',
  'platform_fulfillment_tracking',
  'platform_order_snapshots',
  'platform_sku_mappings',
  'connector_credentials',
  'connector_sync_runs',
  'connector_sync_state',
  'shopify_webhook_events',
  'shopify_inventory_mirror_state',
  'shopify_inventory_mirror_entries',
  'purchase_demands',
  'purchase_requests',
  'purchase_request_lines',
  'suppliers',
  'purchase_orders',
  'purchase_order_lines',
  'purchase_receipts',
  'purchase_receipt_lines',
  'inventory_inbound_movements',
  'purchase_receipt_corrections',
  'purchase_receipt_correction_lines',
  'inventory_receipt_correction_movements',
  'muku_dataset_state',
  'muku_sync_runs',
  'muku_snapshots',
  'muku_inventory_records',
  'muku_inventory_detail_records',
  'muku_inventory_risk_records',
  'muku_source_status_records',
  'muku_sku_mappings',
  'sku_procurement_policies',
  'sku_inventory_confirmations',
  'feishu_procurement_previews',
  'feishu_procurement_sync_state',
  'logistics_tracking_events',
  'purchase_payments',
  'warehouse_stock_counts',
  'warehouse_outbound_events',
  'purchase_invoices',
  'nine_store_order_snapshots',
  'nine_store_order_history',
  'nine_store_order_handoffs',
  'native_channel_handoff_proofs',
  'purchase_supplier_quotes',
  'purchase_quality_requirements',
  'purchase_quality_inspections',
  'purchase_quality_inspection_lines',
  'purchase_payment_requests',
  'purchase_payment_request_links',
] as const;

export const DATABASE_REQUIRED_TRIGGERS = [
  'trg_warehouse_stock_counts_apply',
  'trg_warehouse_outbound_events_validate',
  'trg_orders_require_warehouse_pack',
  'trg_purchase_receipt_lines_quality_gate',
  'trg_purchase_orders_validate_supplier_update',
  'trg_nine_store_order_history_archive',
  'trg_nine_store_handoff_require_pending_source',
  'trg_native_channel_handoff_validate',
  'trg_native_channel_handoff_require_pending_source',
  'trg_native_channel_handoff_no_update',
  'trg_native_channel_handoff_no_delete',
] as const;

export const DATABASE_REQUIRED_VIEWS = ['native_channel_order_identity', 'native_channel_handoff_candidates'] as const;

export const DATABASE_REQUIRED_COLUMNS = {
  members: ['access_profile'],
  shopify_inventory_mirror_state: ['tenant_id', 'platform_store_id', 'cursor_sku', 'status', 'lease_id', 'lease_expires_at', 'last_attempted_at', 'last_completed_at', 'last_error_code'],
  shopify_inventory_mirror_entries: ['tenant_id', 'platform_store_id', 'sku', 'status', 'observed_at', 'snapshot_json', 'last_checked_at', 'last_error_code'],
  feishu_procurement_previews: [
    'snapshot_date',
    'payload_hash',
    'payload_json',
    'imported_by',
    'imported_at',
  ],
  feishu_procurement_sync_state: [
    'queued',
    'lease_id',
    'lease_expires_at',
    'last_attempt_at',
    'last_success_at',
    'last_error',
  ],
  purchase_requests: ['source'],
  skus: ['specification', 'dimensions', 'image_url', 'description'],
  purchase_product_images: ['tenant_id', 'id', 'content_type', 'content', 'created_at'],
  purchase_request_lines: ['product_details_json'],
  purchase_order_lines: ['product_details_json'],
  logistics_tracking_events: ['package_id', 'version', 'tracking_number', 'idempotency_key', 'request_hash'],
  purchase_payments: ['purchase_order_id', 'kind', 'amount_minor', 'original_payment_id', 'request_hash'],
  purchase_invoices: ['purchase_order_id', 'kind', 'amount_minor', 'original_invoice_id', 'request_hash'],
  nine_store_order_snapshots: ['tenant_id', 'observed_at', 'payload_hash', 'payload_json', 'imported_at'],
  nine_store_order_history: ['tenant_id', 'source_table', 'source_record_id', 'store_key', 'order_no', 'observed_at', 'archived_at', 'change'],
  nine_store_order_handoffs: ['tenant_id', 'store_key', 'source_order_key', 'source_record_id', 'source_observed_at', 'order_id', 'request_hash'],
  native_channel_handoff_proofs: ['order_id', 'tenant_id', 'platform_store_id', 'official_store_id', 'platform_order_id', 'platform_line_id', 'source_version'],
  warehouse_stock_counts: ['warehouse_id', 'inventory_version', 'reserved_qty', 'counted_qty', 'operation_key'],
  warehouse_outbound_events: ['order_id', 'version', 'step', 'quantity', 'sku_code', 'package_count'],
  purchase_receipt_corrections: [
    'purchase_receipt_id',
    'purchase_order_id',
    'reason',
    'idempotency_key',
  ],
  purchase_receipt_correction_lines: [
    'correction_id',
    'purchase_receipt_line_id',
    'purchase_order_line_id',
    'quantity',
  ],
  inventory_receipt_correction_movements: [
    'correction_id',
    'correction_line_id',
    'on_hand_delta',
    'operation_key',
  ],
  suppliers: ['contact_name', 'contact_phone', 'contact_email', 'address'],
  warehouses: ['contact_name', 'contact_phone', 'address'],
  purchase_orders: [
    'closed_at',
    'delivery_warehouse_id',
    'expected_delivery_at',
    'payment_terms',
    'trade_terms',
    'supplier_code_snapshot',
    'supplier_name_snapshot',
    'supplier_contact_name_snapshot',
    'supplier_contact_phone_snapshot',
    'supplier_contact_email_snapshot',
    'supplier_address_snapshot',
    'delivery_warehouse_code_snapshot',
    'delivery_warehouse_name_snapshot',
    'delivery_contact_name_snapshot',
    'delivery_contact_phone_snapshot',
    'delivery_address_snapshot',
  ],
} as const;

export function ensureDatabase(db: D1Database) {
  if (!initialization) {
    initialization = initialize(db).catch((error) => {
      initialization = undefined;
      throw error;
    });
  }
  return initialization;
}

async function initialize(db: D1Database) {
  await assertDatabaseSchemaReady(db);
  await db.prepare('PRAGMA optimize').run();
}

export async function assertDatabaseSchemaReady(db: D1Database) {
  const schema = await db.prepare(`
    SELECT name FROM sqlite_master WHERE type IN ('table', 'trigger', 'view')
  `).all<{ name: string }>();
  const names = new Set(schema.results.map((row) => row.name));
  if ([...DATABASE_REQUIRED_TABLES, ...DATABASE_REQUIRED_TRIGGERS, ...DATABASE_REQUIRED_VIEWS].some((entry) => !names.has(entry))) {
    throw new Error('DATABASE_MIGRATIONS_PENDING');
  }

  const columnChecks = await Promise.all(
    Object.entries(DATABASE_REQUIRED_COLUMNS).map(async ([table, requiredColumns]) => {
      const result = await db.prepare(`PRAGMA table_info('${table}')`).all<{ name: string }>();
      const columns = new Set(result.results.map((row) => row.name));
      return requiredColumns.every((column) => columns.has(column));
    }),
  );
  if (columnChecks.some((ready) => !ready)) {
    throw new Error('DATABASE_MIGRATIONS_PENDING');
  }
}
