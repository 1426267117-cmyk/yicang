import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { assertDatabaseSchemaReady } from '../db/initialize';
import { openSqliteD1 } from '../lib/aws/sqlite-d1';

const migrationsPath = fileURLToPath(new URL('../drizzle/', import.meta.url));
const temporaryPaths: string[] = [];

function temporaryDirectory() {
  const path = mkdtempSync(join(tmpdir(), 'yicang-local-sqlite-'));
  temporaryPaths.push(path);
  return path;
}

afterEach(() => {
  for (const path of temporaryPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('AWS 单实例 SQLite 数据库', () => {
  it('两套同版本部署使用各自的数据库', async () => {
    const directory = temporaryDirectory();
    const guangzhou = openSqliteD1(join(directory, 'guangzhou.sqlite'), migrationsPath);
    const shenzhen = openSqliteD1(join(directory, 'shenzhen.sqlite'), migrationsPath);
    try {
      const insert = 'INSERT INTO tenants (id, name, created_at) VALUES (?, ?, ?)';
      await guangzhou.db.prepare(insert).bind('tenant_yicang_primary', '广州采购', '2026-11-24').run();
      await shenzhen.db.prepare(insert).bind('tenant_yicang_primary', '深圳采购', '2026-11-24').run();
      await guangzhou.db.prepare('INSERT INTO skus (id, tenant_id, code, name, active, created_at) VALUES (?, ?, ?, ?, 1, ?)')
        .bind('sku-local', 'tenant_yicang_primary', 'GZ-ONLY', '广州测试商品', '2026-11-24').run();
      expect(await guangzhou.db.prepare('SELECT code FROM skus').first('code')).toBe('GZ-ONLY');
      expect(await shenzhen.db.prepare('SELECT code FROM skus').first()).toBeNull();
    } finally {
      guangzhou.close();
      shenzhen.close();
    }
  });

  it('应用易仓迁移并在进程重开后保留写入', async () => {
    const filename = join(temporaryDirectory(), 'persistent', 'erp.sqlite');
    const first = openSqliteD1(filename, migrationsPath);
    try {
      await assertDatabaseSchemaReady(first.db);
      const name = "广州'采购";
      const inserted = await first.db.prepare('INSERT INTO tenants (id, name, created_at) VALUES (?, ?, ?)')
        .bind('guangzhou', name, '2026-11-24').run();
      expect(inserted.meta.changes).toBe(1);
      expect(await first.db.prepare('SELECT name FROM tenants WHERE id = ?').bind('guangzhou').first('name'))
        .toBe(name);
      expect((await first.db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
    } finally {
      first.close();
    }

    const reopened = openSqliteD1(filename, migrationsPath);
    try {
      expect(await reopened.db.prepare('SELECT name FROM tenants').first()).toEqual({ name: "广州'采购" });
      expect(await reopened.db.prepare('SELECT name FROM tenants WHERE id = ?').bind('shenzhen').first()).toBeNull();
    } finally {
      reopened.close();
    }
  });

  it('批量语句失败时回滚前面的写入，并保留后续操作能力', async () => {
    const { db, close } = openSqliteD1(':memory:', migrationsPath);
    try {
      const insert = db.prepare('INSERT INTO tenants (id, name, created_at) VALUES (?, ?, ?)');
      await expect(db.batch([
        insert.bind('guangzhou', '广州采购', '2026-11-24'),
        insert.bind('guangzhou', '重复数据', '2026-11-24'),
      ])).rejects.toThrow('UNIQUE constraint failed');
      expect(await db.prepare('SELECT COUNT(*) AS count FROM tenants').first('count')).toBe(0);
      const [written, read] = await db.batch([
        insert.bind('guangzhou', '广州采购', '2026-11-24'),
        db.prepare('SELECT name FROM tenants WHERE id = ?').bind('guangzhou'),
      ]);
      expect(written.meta.changes).toBe(1);
      expect(read.results).toEqual([{ name: '广州采购' }]);
      expect(await db.prepare('SELECT name FROM tenants').raw({ columnNames: true }))
        .toEqual([['name'], ['广州采购']]);
    } finally {
      close();
    }
  });

  it('发现历史迁移被修改时拒绝启动，保留既有数据', async () => {
    const directory = temporaryDirectory();
    const filename = join(directory, 'erp.sqlite');
    const copiedMigrations = join(directory, 'migrations');
    const manifest = readFileSync(join(migrationsPath, 'meta', '_journal.json'), 'utf8');
    const journal = JSON.parse(manifest) as { entries: { tag: string }[] };
    mkdirSync(join(copiedMigrations, 'meta'), { recursive: true });
    writeFileSync(join(copiedMigrations, 'meta', '_journal.json'), manifest);
    for (const { tag } of journal.entries) {
      writeFileSync(join(copiedMigrations, `${tag}.sql`), readFileSync(join(migrationsPath, `${tag}.sql`)));
    }
    const local = openSqliteD1(filename, copiedMigrations);
    try {
      await local.db.prepare("INSERT INTO tenants VALUES ('guangzhou', '广州采购', '2026-11-24')").run();
    } finally {
      local.close();
    }
    writeFileSync(join(copiedMigrations, `${journal.entries[0].tag}.sql`), '-- 已被意外修改的历史迁移');

    expect(() => openSqliteD1(filename, copiedMigrations)).toThrow('已应用的迁移与代码版本不一致');
    const persisted = new DatabaseSync(filename, { readOnly: true });
    try {
      expect(persisted.prepare('SELECT name FROM tenants').get()).toEqual({ name: '广州采购' });
    } finally {
      persisted.close();
    }
  });
});
