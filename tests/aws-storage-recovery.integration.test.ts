import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { appendFileSync, copyFileSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertDatabaseSchemaReady } from '../db/initialize';
import { openSqliteD1 } from '../lib/aws/sqlite-d1';
import type { UserContext } from '../lib/db';
import { ROLE_PERMISSIONS } from '../lib/domain';
import { createOrder, executeOrderAction, getOrder } from '../lib/erp-service';

vi.mock('cloudflare:workers', () => ({ env: {} }));

const migrations = fileURLToPath(new URL('../drizzle/', import.meta.url));
const backupScript = fileURLToPath(new URL('../scripts/sqlite-backup.mjs', import.meta.url));
const run = promisify(execFile);
const now = '2026-11-25T05:00:00.000Z';
const user: UserContext = {
  id: 'recovery-admin', email: 'recovery@example.invalid', displayName: '恢复演练', role: 'admin',
  tenantId: 'tenant-recovery-test', tenantName: '恢复演练工作区', permissions: ROLE_PERMISSIONS.admin,
};
const recoveryOrderInput = {
  channel: 'Shopify', destination: '演练目的地', customerName: '恢复演练', currency: 'USD',
  amountMinor: 2500, quantity: 3, skuId: 'recovery-sku', warehouseId: 'recovery-warehouse',
} as const;

let directory: string;
let sourcePath: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'yicang-recovery-'));
  sourcePath = join(directory, 'erp.sqlite');
});

afterEach(() => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      for (const file of readdirSync(path)) unlinkSync(join(path, file));
      rmdirSync(path);
    } else unlinkSync(path);
  }
  rmdirSync(directory);
});

async function backupCommand(...args: string[]) {
  const { stdout } = await run(process.execPath, [backupScript, ...args], { windowsHide: true });
  return JSON.parse(stdout) as { ok: boolean; bundle: string; workspace: string; database: { file: string; bytes: number; sha256: string } };
}

function createBackup(workspace = user.tenantName) {
  return backupCommand('create', '--source', sourcePath, '--output-dir', directory, '--workspace', workspace);
}

function verifyBackup(bundle: string, workspace = user.tenantName) {
  return backupCommand('verify', '--bundle', join(directory, bundle), '--workspace', workspace);
}

async function seedInventory(db: D1Database) {
  await db.batch([
    db.prepare('INSERT INTO tenants VALUES (?, ?, ?)').bind(user.tenantId, user.tenantName, now),
    db.prepare('INSERT INTO skus (id, tenant_id, code, name, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind('recovery-sku', user.tenantId, 'TEST-RECOVERY-SKU', '恢复演练商品', now),
    db.prepare('INSERT INTO warehouses (id, tenant_id, code, name, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind('recovery-warehouse', user.tenantId, 'TEST-RECOVERY-WH', '恢复演练仓', now),
    db.prepare(`INSERT INTO inventory_balances
      (id, tenant_id, sku_id, warehouse_id, on_hand_qty, reserved_qty, version, updated_at)
      VALUES (?, ?, ?, ?, 9, 0, 1, ?)`).bind('recovery-balance', user.tenantId, 'recovery-sku', 'recovery-warehouse', now),
  ]);
}

async function verifyIntegrity(db: D1Database) {
  await assertDatabaseSchemaReady(db);
  expect(await db.prepare('PRAGMA integrity_check').first('integrity_check')).toBe('ok');
  expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
}

describe('AWS SQLite 持久化与备份恢复验收', () => {
  it('并发重复建单和审批各写一次，返回原订单并准确标注重放', async () => {
    const first = openSqliteD1(sourcePath, migrations);
    const second = openSqliteD1(sourcePath, migrations);
    try {
      await seedInventory(first.db);
      const results = await Promise.allSettled([
        createOrder(first.db, user, recoveryOrderInput, 'recovery-concurrent-order'),
        createOrder(second.db, user, recoveryOrderInput, 'recovery-concurrent-order'),
      ]);
      expect(await first.db.prepare('SELECT COUNT(*) AS count FROM orders').first('count')).toBe(1);
      expect(results).toMatchObject([{ status: 'fulfilled' }, { status: 'fulfilled' }]);
      const created = results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
      expect(created.map((result) => result.replayed).sort()).toEqual([false, true]);
      expect(created[0].order.id).toBe(created[1].order.id);

      const orderId = created[0].order.id;
      const concurrentApprovals = await Promise.all([
        executeOrderAction(first.db, user, orderId, 'approve', 'recovery-concurrent-approve'),
        executeOrderAction(first.db, user, orderId, 'approve', 'recovery-concurrent-approve'),
      ]);
      expect(await first.db.prepare('SELECT reserved_qty FROM inventory_balances').first('reserved_qty')).toBe(3);
      expect(await first.db.prepare('SELECT COUNT(*) AS count FROM inventory_movements').first('count')).toBe(1);
      expect(concurrentApprovals.map((result) => result.replayed).sort()).toEqual([false, true]);

      const next = await createOrder(first.db, user, recoveryOrderInput, 'recovery-conflicting-order');
      const conflictingActions = await Promise.allSettled([
        executeOrderAction(first.db, user, next.order.id, 'approve', 'recovery-conflicting-action'),
        executeOrderAction(first.db, user, next.order.id, 'cancel', 'recovery-conflicting-action'),
      ]);
      expect(conflictingActions).toMatchObject([
        { status: 'fulfilled', value: { replayed: false } },
        { status: 'rejected', reason: { code: 'IDEMPOTENCY_CONFLICT' } },
      ]);
    } finally {
      second.close();
      first.close();
    }
  });

  it('在线生成 WAL 一致性备份，在独立库恢复业务记录并继续幂等处理', async () => {
    const live = openSqliteD1(sourcePath, migrations);
    const restoredPath = join(directory, 'restored.sqlite');
    let backupPath: string;
    let orderId: string;
    try {
      await seedInventory(live.db);
      const { order } = await createOrder(live.db, user, recoveryOrderInput, 'recovery-create-order');
      orderId = order.id;
      await executeOrderAction(live.db, user, orderId, 'approve', 'recovery-reserve-order');
      expect(await live.db.prepare('PRAGMA journal_mode').first('journal_mode')).toBe('wal');

      const writer = new DatabaseSync(sourcePath);
      try {
        writer.exec('BEGIN IMMEDIATE');
        writer.prepare('INSERT INTO tenants VALUES (?, ?, ?)').run('unsaved', '未提交的事务', now);
        const created = await createBackup();
        expect(created).toMatchObject({ ok: true, workspace: user.tenantName, database: { file: 'erp.sqlite', sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) } });
        expect(created).toEqual(await verifyBackup(created.bundle));
        expect(readdirSync(join(directory, created.bundle)).sort()).toEqual(['erp.sqlite', 'manifest.json']);
        expect(JSON.parse(readFileSync(join(directory, created.bundle, 'manifest.json'), 'utf8'))).toMatchObject({
          format: 'yicang-sqlite-backup-v1', migrations: { latest: expect.stringMatching(/^\d{4}_/u) },
        });
        backupPath = join(directory, created.bundle, 'erp.sqlite');
      } finally {
        writer.exec('ROLLBACK');
        writer.close();
      }

      await executeOrderAction(live.db, user, orderId, 'ship', 'recovery-post-backup-ship');
      expect(await live.db.prepare('SELECT status FROM orders WHERE id = ?').bind(orderId).first('status')).toBe('shipped');
    } finally { live.close(); }

    copyFileSync(backupPath, restoredPath);
    const restored = openSqliteD1(restoredPath, migrations);
    try {
      await verifyIntegrity(restored.db);
      expect(await getOrder(restored.db, user.tenantId, orderId)).toMatchObject({ id: orderId, status: 'reserved', quantity: 3 });
      expect(await restored.db.prepare('SELECT on_hand_qty, reserved_qty FROM inventory_balances').first())
        .toEqual({ on_hand_qty: 9, reserved_qty: 3 });
      expect((await restored.db.prepare('SELECT type FROM inventory_movements WHERE order_id = ?').bind(orderId).all()).results)
        .toEqual([{ type: 'reserve' }]);
      expect(await restored.db.prepare('SELECT COUNT(*) AS count FROM audit_logs WHERE entity_id = ?').bind(orderId).first('count')).toBe(2);
      expect(await executeOrderAction(restored.db, user, orderId, 'approve', 'recovery-reserve-order')).toMatchObject({ replayed: true });
      await executeOrderAction(restored.db, user, orderId, 'ship', 'recovery-restored-ship');
      expect(await restored.db.prepare('SELECT on_hand_qty, reserved_qty FROM inventory_balances').first())
        .toEqual({ on_hand_qty: 6, reserved_qty: 0 });
    } finally { restored.close(); }
  });

  it('备份工作区不符不发布，离线校验拒绝别的工作区和篡改文件', async () => {
    const live = openSqliteD1(sourcePath, migrations);
    try {
      await seedInventory(live.db);
      await expect(createBackup('另一个工作区')).rejects.toMatchObject({ stderr: expect.stringContaining('工作区与指定工作区不一致') });
      expect(readdirSync(directory).filter(name => /^\.?sqlite-/u.test(name))).toEqual([]);

      const backup = await createBackup();
      await expect(verifyBackup(backup.bundle, '另一个工作区')).rejects.toMatchObject({ stderr: expect.stringContaining('工作区不匹配') });
      appendFileSync(join(directory, backup.bundle, 'erp.sqlite'), 'tampered');
      await expect(verifyBackup(backup.bundle)).rejects.toMatchObject({ stderr: expect.stringContaining('SHA-256 或大小') });
      expect(await live.db.prepare('SELECT COUNT(*) AS count FROM tenants').first('count')).toBe(1);
    } finally { live.close(); }
  });

  it('强制终止进程后保留已提交写入，丢弃未提交事务并恢复可写', async () => {
    const initial = openSqliteD1(sourcePath, migrations);
    initial.close();
    const writer = spawn(process.execPath, ['-e', `
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(process.argv[1]);
      const insert = db.prepare('INSERT INTO tenants VALUES (?, ?, ?)');
      insert.run('committed', 'Committed', '2026-11-25');
      db.exec('BEGIN IMMEDIATE');
      insert.run('uncommitted', 'Uncommitted', '2026-11-25');
      process.send('transaction-open');
      setInterval(() => {}, 1000);
    `, sourcePath], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
    const exited = once(writer, 'exit');
    try {
      const [signal] = await Promise.race([once(writer, 'message'), exited]);
      expect(signal).toBe('transaction-open');
    } finally {
      writer.kill('SIGKILL');
      await exited;
    }

    const reopened = openSqliteD1(sourcePath, migrations);
    try {
      await verifyIntegrity(reopened.db);
      expect((await reopened.db.prepare('SELECT id FROM tenants').all()).results).toEqual([{ id: 'committed' }]);
      await reopened.db.prepare('INSERT INTO tenants VALUES (?, ?, ?)').bind('after-restart', 'After Restart', now).run();
      expect(await reopened.db.prepare('SELECT COUNT(*) AS count FROM tenants').first('count')).toBe(2);
    } finally { reopened.close(); }
  });
});
