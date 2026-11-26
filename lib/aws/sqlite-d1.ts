import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from 'node:sqlite';

export type SqliteD1 = {
  db: D1Database;
  close: () => void;
};

type Migration = {
  index: number;
  tag: string;
  hash: string;
  sql: string;
};

export function openSqliteD1(databasePath: string, migrationsPath: string): SqliteD1 {
  const migrations = readMigrations(migrationsPath);
  const filename = databasePath === ':memory:' ? databasePath : resolve(databasePath);
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });

  const connection = new DatabaseSync(filename, { enableForeignKeyConstraints: true });
  try {
    connection.exec('PRAGMA busy_timeout = 5000');
    applyMigrations(connection, migrations);
    connection.exec('PRAGMA journal_mode = WAL');
  } catch (error) {
    connection.close();
    throw error;
  }

  // The ERP uses this subset of the D1 binding. Replica sessions and legacy
  // database dumps belong to the Cloudflare runtime.
  const db: Pick<D1Database, 'prepare' | 'batch'> = {
    prepare(query) {
      return new SqliteStatement(connection, query);
    },
    async batch<T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
      return transaction(connection, () => statements.map((statement) => {
        if (!(statement instanceof SqliteStatement) || !statement.belongsTo(connection)) {
          throw new Error('SQLite 批量写入要求所有语句使用同一数据库');
        }
        return statement.execute<T>();
      }));
    },
  };
  return { db: db as D1Database, close: () => connection.close() };
}

class SqliteStatement implements D1PreparedStatement {
  constructor(
    private readonly connection: DatabaseSync,
    private readonly query: string,
    private readonly parameters: SQLInputValue[] = [],
  ) {}

  bind(...values: unknown[]) {
    return new SqliteStatement(this.connection, this.query, values.map(sqliteValue));
  }

  belongsTo(connection: DatabaseSync) {
    return this.connection === connection;
  }

  async first<T = Record<string, unknown>>(columnName?: string): Promise<T | null> {
    const row = this.connection.prepare(this.query).get(...this.parameters);
    if (!row) return null;
    if (columnName === undefined) return { ...row } as T;
    if (!Object.hasOwn(row, columnName)) throw new Error(`SQLite 查询未返回列 ${columnName}`);
    return row[columnName] as T;
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return this.execute<T>();
  }

  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return this.execute<T>();
  }

  raw<T = unknown[]>(options: { columnNames: true }): Promise<[string[], ...T[]]>;
  raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>;
  async raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[] | [string[], ...T[]]> {
    const statement = this.connection.prepare(this.query);
    const columns = statement.columns().map((column) => column.name);
    statement.setReturnArrays(true);
    const rows = statement.all(...this.parameters) as unknown as T[];
    return options?.columnNames ? [columns, ...rows] : rows;
  }

  execute<T>(): D1Result<T> {
    const start = performance.now();
    const statement = this.connection.prepare(this.query);
    const state = this.connection.prepare(
      'SELECT changes() AS changes, total_changes() AS total, last_insert_rowid() AS last_row_id',
    );
    let results: Record<string, SQLOutputValue>[] = [];
    let changes = 0;
    let lastRowId = 0;
    if (statement.columns().length) {
      const before = Number(state.get()?.total);
      results = statement.all(...this.parameters).map((row) => ({ ...row }));
      const after = state.get()!;
      if (Number(after.total) !== before) {
        changes = Number(after.changes);
        lastRowId = Number(after.last_row_id);
      }
    } else {
      const written = statement.run(...this.parameters);
      changes = Number(written.changes);
      lastRowId = Number(written.lastInsertRowid);
    }

    return {
      success: true,
      results: results as T[],
      meta: {
        duration: performance.now() - start,
        changes,
        changed_db: changes > 0,
        last_row_id: lastRowId,
        // Node exposes result rows and direct writes, without D1 scan statistics.
        rows_read: results.length,
        rows_written: changes,
        size_after: 0,
      },
    };
  }
}

function sqliteValue(value: unknown): SQLInputValue {
  if (value === null || typeof value === 'string' || typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new TypeError('SQLite 参数必须是有限数字、文本、布尔值、二进制数据或 null');
}

function readMigrations(directory: string): Migration[] {
  const journal = JSON.parse(readFileSync(join(directory, 'meta', '_journal.json'), 'utf8')) as {
    entries?: { idx?: unknown; tag?: unknown }[];
  };
  if (!Array.isArray(journal.entries) || !journal.entries.length) throw new Error('采购数据库迁移清单无效');
  return journal.entries.map((entry, index) => {
    if (entry.idx !== index || typeof entry.tag !== 'string' || !/^\d{4}_[a-z0-9_]+$/u.test(entry.tag)
      || Number(entry.tag.slice(0, 4)) !== index) {
      throw new Error('采购数据库迁移清单存在无效编号');
    }
    const sql = readFileSync(join(directory, `${entry.tag}.sql`), 'utf8');
    const hash = createHash('sha256').update(sql.replaceAll('\r\n', '\n')).digest('hex');
    return { index, tag: entry.tag, hash, sql };
  });
}

function applyMigrations(connection: DatabaseSync, migrations: Migration[]) {
  transaction(connection, () => {
    const hasJournal = connection.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'erp_schema_migrations'",
    ).get();
    if (!hasJournal && connection.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name NOT GLOB 'sqlite_*' LIMIT 1",
    ).get()) {
      throw new Error('现有 SQLite 文件缺少易仓迁移记录，需要单独验收导入');
    }
    connection.exec(`
      CREATE TABLE IF NOT EXISTS erp_schema_migrations (
        migration_index INTEGER PRIMARY KEY,
        tag TEXT NOT NULL UNIQUE,
        sha256 TEXT NOT NULL,
        applied_at TEXT NOT NULL
      )
    `);
    const applied = connection.prepare(
      'SELECT migration_index, tag, sha256 FROM erp_schema_migrations ORDER BY migration_index',
    ).all();
    if (applied.some((row, index) => !migrations[index] || row.migration_index !== index
      || row.tag !== migrations[index].tag || row.sha256 !== migrations[index].hash)) {
      throw new Error('SQLite 已应用的迁移与代码版本不一致');
    }
    const pending = migrations.slice(applied.length);
    for (const migration of pending) {
      connection.exec(migration.sql);
      connection.prepare(
        'INSERT INTO erp_schema_migrations VALUES (?, ?, ?, ?)',
      ).run(migration.index, migration.tag, migration.hash, new Date().toISOString());
    }
    if (pending.length && connection.prepare('PRAGMA foreign_key_check').get()) {
      throw new Error('SQLite 迁移未通过外键检查');
    }
  });
}

function transaction<T>(connection: DatabaseSync, work: () => T): T {
  connection.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    connection.exec('COMMIT');
    return result;
  } catch (error) {
    if (connection.isTransaction) connection.exec('ROLLBACK');
    throw error;
  }
}
