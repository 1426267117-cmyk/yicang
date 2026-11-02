let initialization: Promise<void> | undefined;

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
  const schema = await db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name IN (
      'tenants', 'platform_orders', 'platform_order_write_leases',
      'connector_credentials', 'purchase_demands',
      'purchase_requests', 'purchase_request_lines',
      'suppliers', 'purchase_orders', 'purchase_order_lines',
      'purchase_receipts', 'purchase_receipt_lines', 'inventory_inbound_movements',
      'muku_dataset_state', 'muku_sync_runs', 'muku_snapshots',
      'muku_inventory_records', 'muku_inventory_detail_records',
      'muku_inventory_risk_records', 'muku_source_status_records',
      'muku_sku_mappings', 'sku_procurement_policies'
    )
  `).all<{ name: string }>();
  const names = new Set(schema.results.map((row) => row.name));
  if (!names.has('tenants') || !names.has('platform_orders')
    || !names.has('platform_order_write_leases')
    || !names.has('connector_credentials') || !names.has('purchase_demands')
    || !names.has('purchase_requests') || !names.has('purchase_request_lines')
    || !names.has('suppliers') || !names.has('purchase_orders')
    || !names.has('purchase_order_lines') || !names.has('purchase_receipts')
    || !names.has('purchase_receipt_lines') || !names.has('inventory_inbound_movements')) {
    throw new Error('DATABASE_MIGRATIONS_PENDING');
  }
  if (!names.has('muku_dataset_state') || !names.has('muku_sync_runs')
    || !names.has('muku_snapshots') || !names.has('muku_inventory_records')
    || !names.has('muku_inventory_detail_records') || !names.has('muku_inventory_risk_records')
    || !names.has('muku_source_status_records') || !names.has('muku_sku_mappings')
    || !names.has('sku_procurement_policies')) {
    throw new Error('DATABASE_MIGRATIONS_PENDING');
  }
  await db.prepare('PRAGMA optimize').run();
}
