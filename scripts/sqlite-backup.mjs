import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, closeSync, existsSync, fsyncSync, lstatSync, mkdtempSync, openSync,
  readFileSync, readSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';

const databaseFile = 'erp.sqlite';
const manifestFile = 'manifest.json';
const format = 'yicang-sqlite-backup-v1';
const sidecars = ['-wal', '-shm', '-journal'];
const sha256Pattern = /^[a-f0-9]{64}$/u;

class BackupError extends Error {}

function syncPath(path, directory = false) {
  if (directory && process.platform === 'win32') return;
  const handle = openSync(path, directory ? 'r' : 'r+');
  try { fsyncSync(handle); }
  finally { closeSync(handle); }
}

function checkedFile(path) {
  const information = lstatSync(path);
  if (!information.isFile() || information.size === 0) throw new BackupError('需要有效的普通文件。');
  return information;
}

async function databaseChecksum(path) {
  const { size } = checkedFile(path);
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return { file: databaseFile, bytes: size, sha256: hash.digest('hex') };
}

function checkStandaloneDatabase(path) {
  if (sidecars.some(suffix => existsSync(`${path}${suffix}`))) throw new BackupError('备份包含 SQLite 辅助文件，无法作为独立数据库使用。');
  const header = Buffer.alloc(100);
  const handle = openSync(path, 'r');
  try {
    if (readSync(handle, header, 0, header.length, 0) !== header.length
      || header.toString('ascii', 0, 16) !== 'SQLite format 3\u0000' || header[18] !== 1 || header[19] !== 1) {
      throw new BackupError('备份不是可独立读取的 SQLite 数据库。');
    }
  } finally { closeSync(handle); }
}

function checkMigrations(db) {
  const applied = db.prepare('SELECT migration_index, tag, sha256 FROM erp_schema_migrations ORDER BY migration_index').all();
  const journal = JSON.parse(readFileSync(new URL('../drizzle/meta/_journal.json', import.meta.url), 'utf8'));
  if (!applied.length || applied.length > journal.entries.length) {
    throw new BackupError('备份的迁移版本无法用当前工具验证。');
  }
  for (const [index, row] of applied.entries()) {
    const migration = journal.entries[index];
    if (row.migration_index !== index || row.tag !== migration?.tag || !/^\d{4}_[a-z0-9_]+$/u.test(row.tag)) {
      throw new BackupError(`备份的迁移记录在第 ${index} 号不匹配。`);
    }
    const sql = readFileSync(new URL(`../drizzle/${row.tag}.sql`, import.meta.url), 'utf8');
    const sha256 = createHash('sha256').update(sql.replaceAll('\r\n', '\n')).digest('hex');
    if (row.sha256 !== sha256) throw new BackupError(`备份的迁移哈希在第 ${index} 号不匹配。`);
  }
  return { count: applied.length, latest: applied.at(-1).tag };
}

function inspectDatabase(path, workspace) {
  checkStandaloneDatabase(path);
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    if (db.prepare('PRAGMA integrity_check(1)').get()?.integrity_check !== 'ok') {
      throw new BackupError('SQLite 完整性检查失败。');
    }
    if (db.prepare('PRAGMA foreign_key_check').get()) throw new BackupError('SQLite 外键检查失败。');
    const workspaces = db.prepare('SELECT name FROM tenants LIMIT 2').all();
    if (workspaces.length !== 1 || workspaces[0].name !== workspace) {
      throw new BackupError('数据库中的工作区与指定工作区不一致。');
    }
    const migrations = checkMigrations(db);
    db.prepare('SELECT id FROM orders LIMIT 1').get();
    db.prepare('SELECT id FROM purchase_orders LIMIT 1').get();
    db.prepare('SELECT id FROM inventory_balances LIMIT 1').get();
    return migrations;
  } finally { db.close(); }
}

function readManifest(directory, workspace) {
  const path = join(directory, manifestFile);
  if (checkedFile(path).size > 16_384) throw new BackupError('备份清单超过大小限制。');
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  if (manifest?.format !== format || manifest.workspace !== workspace
    || typeof manifest.createdAt !== 'string' || Number.isNaN(Date.parse(manifest.createdAt))
    || manifest.database?.file !== databaseFile || !Number.isSafeInteger(manifest.database.bytes)
    || !sha256Pattern.test(manifest.database.sha256 ?? '')) {
    throw new BackupError('备份清单无效或工作区不匹配。');
  }
  return manifest;
}

async function verifyBundle(directory, workspace) {
  const manifest = readManifest(directory, workspace);
  const snapshot = join(directory, databaseFile);
  const database = await databaseChecksum(snapshot);
  if (database.sha256 !== manifest.database.sha256 || database.bytes !== manifest.database.bytes) {
    throw new BackupError('备份文件的 SHA-256 或大小与清单不一致。');
  }
  const migrations = inspectDatabase(snapshot, workspace);
  if (migrations.count !== manifest.migrations?.count || migrations.latest !== manifest.migrations?.latest) {
    throw new BackupError('备份的迁移版本与清单不一致。');
  }
  return { format, workspace, createdAt: manifest.createdAt, migrations, database };
}

async function createBundle(source, outputDir, workspace) {
  const sourcePath = resolve(source);
  checkedFile(sourcePath);
  const root = realpathSync(outputDir);
  const staging = mkdtempSync(join(root, '.sqlite-backup-'));
  const snapshot = join(staging, databaseFile);
  const manifest = join(staging, manifestFile);
  const createdAt = new Date().toISOString();
  const bundle = `sqlite-${createdAt.replace(/[:.]/gu, '-')}-${randomUUID()}`;
  const destination = join(root, bundle);
  let published = false;

  try {
    const original = new DatabaseSync(sourcePath, { readOnly: true });
    try {
      original.exec('PRAGMA busy_timeout = 5000');
      original.prepare('VACUUM INTO ?').run(snapshot);
    } finally { original.close(); }

    syncPath(snapshot);
    const database = await databaseChecksum(snapshot);
    const migrations = inspectDatabase(snapshot, workspace);
    const metadata = { format, workspace, createdAt, migrations, database };
    writeFileSync(manifest, `${JSON.stringify(metadata, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    syncPath(manifest);
    syncPath(staging, true);

    if (JSON.stringify(readManifest(staging, workspace)) !== JSON.stringify(metadata)) {
      throw new BackupError('备份清单回读与写入内容不一致。');
    }
    if (existsSync(destination)) throw new BackupError('备份目录重名，请重试。');
    renameSync(staging, destination);
    published = true;
    syncPath(root, true);
    return { bundle, ...metadata };
  } finally {
    if (!published) {
      for (const path of [manifest, snapshot, ...sidecars.map(suffix => `${snapshot}${suffix}`)]) {
        if (existsSync(path)) unlinkSync(path);
      }
      rmdirSync(staging);
    }
  }
}

const usage = `创建: node scripts/sqlite-backup.mjs create --source <数据库> --output-dir <备份目录> --workspace <库内工作区名>
验证: node scripts/sqlite-backup.mjs verify --bundle <备份包目录> --workspace <库内工作区名>`;

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === '--help') { console.log(usage); return; }
  if (command !== 'create' && command !== 'verify') throw new BackupError(usage);
  const { values } = parseArgs({ args, options: command === 'create'
    ? { source: { type: 'string' }, 'output-dir': { type: 'string' }, workspace: { type: 'string' } }
    : { bundle: { type: 'string' }, workspace: { type: 'string' } } });
  const { workspace } = values;
  if (!workspace || (command === 'create' ? !values.source || !values['output-dir'] : !values.bundle)) throw new BackupError(usage);
  process.umask(0o077);
  const result = command === 'create'
    ? await createBundle(values.source, values['output-dir'], workspace)
    : { bundle: basename(resolve(values.bundle)), ...await verifyBundle(resolve(values.bundle), workspace) };
  console.log(JSON.stringify({ ok: true, ...result }));
}

main().catch(error => {
  const knownCode = /^(?:E[A-Z][A-Z0-9_]+|ERR_[A-Z0-9_]+)$/u.test(error?.code ?? '') ? `（${error.code}）` : '';
  console.error(error instanceof BackupError ? error.message : `SQLite 备份操作失败${knownCode}。`);
  process.exitCode = 1;
});
