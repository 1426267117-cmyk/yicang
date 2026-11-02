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
      'purchase_requests', 'purchase_request_lines'
    )
  `).all<{ name: string }>();
  const names = new Set(schema.results.map((row) => row.name));
  if (!names.has('tenants') || !names.has('platform_orders')
    || !names.has('platform_order_write_leases')
    || !names.has('connector_credentials') || !names.has('purchase_demands')
    || !names.has('purchase_requests') || !names.has('purchase_request_lines')) {
    throw new Error('DATABASE_MIGRATIONS_PENDING');
  }
  await db.prepare('PRAGMA optimize').run();
}
