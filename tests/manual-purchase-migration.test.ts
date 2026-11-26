import { readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { Miniflare } from 'miniflare';
import { describe, expect, it } from 'vitest';

const migrations = new URL('../drizzle/', import.meta.url);
const manualMigration = '0017_manual_purchase_requests.sql';
const productDetailsMigration = '0030_purchase_product_details.sql';
const legacyMigrations = readdirSync(migrations).filter((file) => file.endsWith('.sql') && file < manualMigration).sort();
const procurementMigrations = readdirSync(migrations)
  .filter((file) => file.endsWith('.sql') && file >= manualMigration && file <= productDetailsMigration)
  .sort();

describe('手工采购数据库迁移', () => {
  it('D1 批量迁移保留旧申请、采购单、到货与库存，并回填申请来源', async () => {
    const runtime = new Miniflare({
      modules: true,
      script: 'export default { fetch(){ return new Response("ok") } }',
      d1Databases: ['DB'],
    });
    try {
      const db = await runtime.getD1Database('DB');
      for (const file of legacyMigrations) {
        await applyD1Migration(db, file);
      }
      const records = seedSql.split(';').map((sql) => sql.trim()).filter(Boolean);
      await db.batch(records.map((sql) => db.prepare(sql)));
      for (const file of procurementMigrations) {
        await applyD1Migration(db, file);
      }

      expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
      expect(await db.prepare(`
        SELECT request.source, request_line.purchase_demand_id, order_line.received_quantity,
          receipt_line.quantity, inventory.on_hand_qty
        FROM purchase_requests request
        JOIN purchase_request_lines request_line ON request_line.request_id = request.id
        JOIN purchase_order_lines order_line ON order_line.purchase_request_line_id = request_line.id
        JOIN purchase_receipt_lines receipt_line ON receipt_line.purchase_order_line_id = order_line.id
        JOIN inventory_balances inventory ON inventory.sku_id = receipt_line.sku_id
          AND inventory.warehouse_id = receipt_line.warehouse_id
        WHERE request.id = 'plan'
      `).first()).toEqual({
        source: 'planning', purchase_demand_id: 'demand', received_quantity: 1, quantity: 1, on_hand_qty: 1,
      });
      expect(await db.prepare("SELECT source FROM purchase_requests WHERE id = 'old'").first())
        .toEqual({ source: 'legacy' });
      expect(await db.prepare(`
        SELECT po.supplier_id, po.delivery_warehouse_id, line.sku_name_snapshot, line.product_details_json
        FROM purchase_orders po JOIN purchase_order_lines line ON line.purchase_order_id = po.id
        WHERE po.id = 'purchase-order'
      `).first()).toEqual({
        supplier_id: 'supplier', delivery_warehouse_id: 'warehouse',
        sku_name_snapshot: '测试商品', product_details_json: null,
      });
      await expect(db.prepare("UPDATE purchase_requests SET source = 'manual' WHERE id = 'plan'").run())
        .rejects.toThrow('PURCHASE_REQUEST_SOURCE_IMMUTABLE');
      await expect(db.prepare(`
        INSERT INTO purchase_request_lines
          (id, tenant_id, request_id, sku_id, requested_quantity, created_at)
        VALUES ('no-demand', 'company', 'old', 'sku', 1, '2026-11-24')
      `).run()).rejects.toThrow('INVALID_PURCHASE_DEMAND');

      await db.prepare(`
        UPDATE purchase_orders SET status = 'closed_short', action_note = '短到', closed_at = '2026-11-24'
        WHERE id = 'purchase-order'
      `).run();
      expect(await db.prepare("SELECT active FROM purchase_request_lines WHERE id = 'plan-line'").first())
        .toEqual({ active: 0 });

      await db.batch([
        db.prepare(`
          INSERT INTO purchase_requests (
            id, tenant_id, request_no, status, purchaser_member_id, reviewer_member_id, created_by_member_id,
            idempotency_key, request_hash, last_action_key, created_at, updated_at, source, note
          ) VALUES ('manual', 'company', 'MANUAL', 'approved', 'member', 'member', 'member',
            'manual', 'hash', 'action', '2026-11-24', '2026-11-24', 'manual', '采购样品')
        `),
        db.prepare(`
          INSERT INTO purchase_orders (
            id, tenant_id, order_no, purchase_request_id, status, idempotency_key,
            request_hash, last_action_key, created_by_member_id, created_at, updated_at
          ) VALUES ('supplier-pending', 'company', 'PO-2', 'manual', 'draft',
            'supplier-pending', 'hash', 'action', 'member', '2026-11-24', '2026-11-24')
        `),
      ]);
      await expect(db.prepare("UPDATE purchase_orders SET status = 'issued' WHERE id = 'supplier-pending'").run())
        .rejects.toThrow('INVALID_PURCHASE_SUPPLIER');
      expect(await db.prepare("SELECT status, supplier_id FROM purchase_orders WHERE id = 'supplier-pending'").first())
        .toEqual({ status: 'draft', supplier_id: null });
    } finally {
      await runtime.dispose();
    }
  });

  it('若既有采购单明细缺少来源申请明细，则整批回滚', () => {
    const db = seededDatabase();
    try {
      db.exec(`
        PRAGMA foreign_keys = OFF;
        DELETE FROM purchase_request_lines WHERE id = 'plan-line';
        PRAGMA foreign_keys = ON;
      `);
      expect(() => applyManualMigration(db)).toThrow('__manual_purchase_fk_check.valid');
      expect(db.prepare("SELECT name FROM pragma_table_info('purchase_requests') WHERE name = 'source'").get())
        .toBeUndefined();
      expect(db.prepare("SELECT id FROM purchase_order_lines WHERE id = 'order-line'").get())
        .toEqual({ id: 'order-line' });
      expect(db.prepare(`
        SELECT name FROM sqlite_master WHERE name = 'trg_purchase_orders_release_closed_remainders'
      `).get()).toEqual({ name: 'trg_purchase_orders_release_closed_remainders' });
    } finally {
      db.close();
    }
  });

  it('若旧采购单缺失且已有明细引用，采购资料迁移完整回滚', () => {
    const db = seededDatabase();
    try {
      for (const file of procurementMigrations.filter((entry) => entry !== productDetailsMigration)) {
        applySqliteMigration(db, file);
      }
      db.exec(`
        PRAGMA foreign_keys = OFF;
        DELETE FROM purchase_orders WHERE id = 'purchase-order';
        PRAGMA foreign_keys = ON;
      `);
      expect(() => applySqliteMigration(db, productDetailsMigration)).toThrow('__purchase_orders_fk_check.valid');
      expect(db.prepare("SELECT id FROM purchase_order_lines WHERE id = 'order-line'").get())
        .toEqual({ id: 'order-line' });
      expect(db.prepare("SELECT name FROM pragma_table_info('skus') WHERE name = 'specification'").get())
        .toBeUndefined();
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'trg_purchase_orders_validate_insert'").get())
        .toEqual({ name: 'trg_purchase_orders_validate_insert' });
    } finally {
      db.close();
    }
  });
});

async function applyD1Migration(db: D1Database, file: string) {
  const sql = readFileSync(new URL(file, migrations), 'utf8');
  const statements = sql.split('--> statement-breakpoint').map((statement) => statement.trim()).filter(Boolean);
  await db.batch(statements.map((statement) => db.prepare(statement)));
}

function applyManualMigration(db: DatabaseSync) {
  return applySqliteMigration(db, manualMigration);
}

function applySqliteMigration(db: DatabaseSync, file: string) {
  db.exec('BEGIN');
  try {
    db.exec(readFileSync(new URL(file, migrations), 'utf8'));
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function seededDatabase() {
  const db = new DatabaseSync(':memory:');
  for (const file of legacyMigrations) {
    db.exec(readFileSync(new URL(file, migrations), 'utf8'));
  }
  db.exec(seedSql);
  return db;
}

const seedSql = `
    INSERT INTO tenants (id, name, created_at) VALUES ('company', '测试', '2026-11-24');
    INSERT INTO members (id, tenant_id, auth_user_id, email, display_name, role, created_at)
    VALUES ('member', 'company', 'auth', 'test@example.invalid', '测试', 'admin', '2026-11-24');
    INSERT INTO skus (id, tenant_id, code, name, created_at)
    VALUES ('sku', 'company', 'SU-01', '测试商品', '2026-11-24');
    INSERT INTO warehouses (id, tenant_id, code, name, created_at)
    VALUES ('warehouse', 'company', 'WH', '测试仓库', '2026-11-24');
    INSERT INTO suppliers (
      id, tenant_id, code, name, idempotency_key, request_hash, created_by_member_id, created_at, updated_at
    ) VALUES ('supplier', 'company', 'SUP', '测试供货商', 'supplier', 'hash', 'member', '2026-11-24', '2026-11-24');
    INSERT INTO platform_stores (
      id, tenant_id, platform, connector_key, display_name, official_store_id, api_version, credential_ref,
      identity_verified_at, created_at, updated_at
    ) VALUES ('store', 'company', 'shopify', 'test', '测试店', 'store-source', '2026-07', 'credential',
      '2026-11-24', '2026-11-24', '2026-11-24');
    INSERT INTO platform_orders (
      id, tenant_id, platform_store_id, platform, source_order_id, source_created_at, source_updated_at,
      api_version, raw_json, raw_hash, fetched_at, first_seen_at, last_seen_at
    ) VALUES ('order', 'company', 'store', 'shopify', 'order-source', '2026-11-24', '2026-11-24',
      '2026-07', '{}', 'hash', '2026-11-24', '2026-11-24', '2026-11-24');
    INSERT INTO platform_order_lines (
      id, tenant_id, order_id, source_order_line_id, ordered_quantity, raw_json, raw_hash,
      first_seen_at, last_seen_at
    ) VALUES ('line', 'company', 'order', 'line-source', 2, '{}', 'hash', '2026-11-24', '2026-11-24');
    INSERT INTO purchase_demands (
      id, tenant_id, platform_store_id, order_id, order_line_id, platform, source_order_id, source_order_line_id,
      mapped_sku_id, status, ordered_quantity, required_quantity, source_updated_at, first_seen_at,
      last_refreshed_at, updated_at
    ) VALUES ('demand', 'company', 'store', 'order', 'line', 'shopify', 'order-source', 'line-source',
      'sku', 'open', 2, 2, '2026-11-24', '2026-11-24', '2026-11-24', '2026-11-24');
    INSERT INTO purchase_requests (
      id, tenant_id, request_no, status, purchaser_member_id, reviewer_member_id, created_by_member_id,
      idempotency_key, request_hash, last_action_key, created_at, updated_at
    ) VALUES
      ('plan', 'company', 'PLAN', 'approved', 'member', 'member', 'member', 'plan', 'hash', 'action', '2026-11-24', '2026-11-24'),
      ('old', 'company', 'OLD', 'draft', 'member', 'member', 'member', 'old', 'hash', 'action', '2026-11-24', '2026-11-24');
    INSERT INTO purchase_request_lines (
      id, tenant_id, request_id, purchase_demand_id, sku_id, requested_quantity, source_required_quantity,
      source_updated_at, created_at
    ) VALUES ('plan-line', 'company', 'plan', 'demand', 'sku', 2, 2, '2026-11-24', '2026-11-24');
    INSERT INTO audit_logs (
      id, tenant_id, actor_id, actor_email, action, entity_type, entity_id, after_json, request_id,
      idempotency_key, source, created_at
    ) VALUES ('audit-plan', 'company', 'auth', 'test@example.invalid', 'CREATE_PURCHASE_REQUEST_FROM_PLAN',
      'purchase_request', 'plan', '{}', 'plan', 'audit-plan', 'human', '2026-11-24');
    INSERT INTO purchase_orders (
      id, tenant_id, order_no, purchase_request_id, supplier_id, delivery_warehouse_id, status,
      idempotency_key, request_hash, last_action_key, created_by_member_id, created_at, updated_at
    ) VALUES ('purchase-order', 'company', 'PO', 'plan', 'supplier', 'warehouse', 'draft',
      'purchase-order', 'hash', 'action', 'member', '2026-11-24', '2026-11-24');
    INSERT INTO purchase_order_lines (
      id, tenant_id, purchase_order_id, purchase_request_line_id, sku_id, sku_code_snapshot, sku_name_snapshot,
      ordered_quantity, created_at, updated_at
    ) VALUES ('order-line', 'company', 'purchase-order', 'plan-line', 'sku', 'SU-01', '测试商品', 2,
      '2026-11-24', '2026-11-24');
    UPDATE purchase_orders SET status = 'issued' WHERE id = 'purchase-order';
    INSERT INTO purchase_receipts (
      id, tenant_id, receipt_no, purchase_order_id, warehouse_id, status, idempotency_key, request_hash,
      created_by_member_id, received_at, created_at
    ) VALUES ('receipt', 'company', 'RC', 'purchase-order', 'warehouse', 'posted', 'receipt', 'hash',
      'member', '2026-11-24', '2026-11-24');
    INSERT INTO purchase_receipt_lines (
      id, tenant_id, purchase_receipt_id, purchase_order_line_id, sku_id, warehouse_id, quantity, created_at
    ) VALUES ('receipt-line', 'company', 'receipt', 'order-line', 'sku', 'warehouse', 1, '2026-11-24');
`;
