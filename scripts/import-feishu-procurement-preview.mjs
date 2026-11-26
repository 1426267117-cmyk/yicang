import { closeSync, fstatSync, openSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  FEISHU_PROCUREMENT_PREVIEW_MAX_BYTES,
  INSERT_FEISHU_PROCUREMENT_PREVIEW,
  feishuProcurementPreviewInsertValues,
  feishuProcurementPreviewSchema,
} from '../lib/feishu-procurement-preview-contract.ts';

const tenantId = 'tenant_yicang_primary';
const [databaseArg, snapshotPath, ...extra] = process.argv.slice(2);

if (!databaseArg || !snapshotPath || extra.length) {
  console.error('Usage: node scripts/import-feishu-procurement-preview.mjs DATABASE SNAPSHOT_JSON');
  process.exitCode = 2;
} else {
  try {
    await importPreview(databaseArg, snapshotPath);
  } catch (error) {
    console.error(error instanceof Error ? error.message : '采购预览导入失败');
    process.exitCode = 1;
  }
}

async function importPreview(databaseArg, snapshotPath) {
  const databasePath = realpathSync(databaseArg);
  if (!statSync(databasePath).isFile()) throw new Error('请指定现有的 SQLite 数据库文件');
  const snapshot = readSnapshot(snapshotPath);
  const values = await feishuProcurementPreviewInsertValues(tenantId, 'local-cli', snapshot);

  const database = new DatabaseSync(databasePath, { enableForeignKeyConstraints: true });
  try {
    database.exec('PRAGMA busy_timeout = 5000');
    const tenant = database.prepare('SELECT 1 FROM tenants WHERE id = ?').get(tenantId);
    if (!tenant) throw new Error('ERP 工作区尚未初始化，请先登录工作区');
    const inserted = database.prepare(INSERT_FEISHU_PROCUREMENT_PREVIEW).run(...values);
    console.log(JSON.stringify({
      ok: true,
      snapshotDate: snapshot.snapshotDate,
      replayed: Number(inserted.changes) === 0,
    }));
  } finally {
    database.close();
  }
}

function readSnapshot(path) {
  const fd = openSync(path, 'r');
  try {
    const file = fstatSync(fd);
    if (!file.isFile() || file.size > FEISHU_PROCUREMENT_PREVIEW_MAX_BYTES) {
      throw new Error('请指定允许大小内的采购预览 JSON 文件');
    }
    const bytes = readFileSync(fd);
    if (bytes.byteLength > FEISHU_PROCUREMENT_PREVIEW_MAX_BYTES) {
      throw new Error('采购预览超过允许的文件大小');
    }
    let input;
    try {
      input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
      throw new Error('采购预览文件应为 UTF-8 JSON');
    }
    const parsed = feishuProcurementPreviewSchema.safeParse(input);
    if (!parsed.success) {
      const field = parsed.error.issues[0]?.path.join('.');
      throw new Error(field ? `采购预览字段格式无效（${field}）` : '采购预览数据格式无效');
    }
    return parsed.data;
  } finally {
    closeSync(fd);
  }
}
