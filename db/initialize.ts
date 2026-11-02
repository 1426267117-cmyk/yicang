let initialization: Promise<void> | undefined;

export const DATABASE_SCHEMA_READINESS = 'procurement-0016';

export const DATABASE_REQUIRED_TABLES = [
  'tenants',
  'members',
  'warehouses',
  'skus',
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
] as const;

export const DATABASE_REQUIRED_COLUMNS = {
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
    SELECT name FROM sqlite_master WHERE type = 'table'
  `).all<{ name: string }>();
  const names = new Set(schema.results.map((row) => row.name));
  if (DATABASE_REQUIRED_TABLES.some((table) => !names.has(table))) {
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
