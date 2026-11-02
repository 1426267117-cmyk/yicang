import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  assertDatabaseSchemaReady,
  DATABASE_REQUIRED_COLUMNS,
  DATABASE_REQUIRED_TABLES,
  DATABASE_SCHEMA_READINESS,
} from '../db/initialize';

describe('数据库初始化', () => {
  it('只创建结构和工作区，不自动写入业务记录', () => {
    const sql = readFileSync(
      new URL('../db/runtime-schema/0000_magical_sleepwalker.sql', import.meta.url),
      'utf8',
    );

    expect(sql).not.toMatch(
      /INSERT\s+OR\s+IGNORE\s+INTO\s+(warehouses|skus|inventory_balances|orders|inventory_movements)/i,
    );
  });

  it('请求处理只检查迁移状态，不在运行时建表', () => {
    const source = readFileSync(new URL('../db/initialize.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('runtime-schema');
    expect(source).not.toMatch(/CREATE\s+TABLE/i);
    expect(source).toContain('DATABASE_MIGRATIONS_PENDING');
  });

  it('收货冲正、短到关闭和采购交付字段齐全时才判定数据库就绪', async () => {
    await expect(assertDatabaseSchemaReady(readinessDatabase())).resolves.toBeUndefined();
    expect(DATABASE_SCHEMA_READINESS).toBe('procurement-0016');
    expect(DATABASE_REQUIRED_TABLES).toEqual(expect.arrayContaining([
      'purchase_receipt_corrections',
      'purchase_receipt_correction_lines',
      'inventory_receipt_correction_movements',
    ]));
  });

  it('收货冲正表漏迁移时失败关闭', async () => {
    const tables = DATABASE_REQUIRED_TABLES.filter(
      (table) => table !== 'purchase_receipt_corrections',
    );
    await expect(assertDatabaseSchemaReady(readinessDatabase({ tables })))
      .rejects.toThrow('DATABASE_MIGRATIONS_PENDING');
  });

  it.each([
    ['purchase_receipt_corrections', 'reason'],
    ['purchase_receipt_correction_lines', 'quantity'],
    ['inventory_receipt_correction_movements', 'on_hand_delta'],
    ['purchase_orders', 'closed_at'],
    ['suppliers', 'contact_name'],
    ['warehouses', 'address'],
    ['purchase_orders', 'delivery_warehouse_id'],
    ['purchase_orders', 'supplier_name_snapshot'],
    ['purchase_orders', 'delivery_address_snapshot'],
  ] as const)('缺少 %s.%s 时失败关闭', async (table, missingColumn) => {
    const columns = readinessColumns();
    columns[table] = columns[table].filter((column) => column !== missingColumn);

    await expect(assertDatabaseSchemaReady(readinessDatabase({ columns })))
      .rejects.toThrow('DATABASE_MIGRATIONS_PENDING');
  });

  it('新增正式迁移不写入店铺、订单或模拟业务数据', () => {
    const sql = [
      '../drizzle/0001_premium_the_stranger.sql',
      '../drizzle/0002_organic_titanium_man.sql',
      '../drizzle/0003_fancy_jane_foster.sql',
    ].map((migration) => readFileSync(new URL(migration, import.meta.url), 'utf8')).join('\n');
    expect(sql).not.toMatch(/INSERT\s+(?:OR\s+IGNORE\s+)?INTO\s+(platform_stores|platform_orders|platform_order_lines|platform_refunds|platform_fulfillments)/i);
  });

  it('采购下单字段迁移仅追加可空列，不覆盖或删除历史记录', () => {
    const sql = readFileSync(
      new URL('../drizzle/0016_brief_doomsday.sql', import.meta.url),
      'utf8',
    );
    expect(sql).toContain('ALTER TABLE `suppliers` ADD `contact_name` text');
    expect(sql).toContain('ALTER TABLE `warehouses` ADD `address` text');
    expect(sql).toContain('ALTER TABLE `purchase_orders` ADD `delivery_warehouse_id` text');
    expect(sql).toContain('ALTER TABLE `purchase_orders` ADD `supplier_name_snapshot` text');
    expect(sql).toContain('ALTER TABLE `purchase_orders` ADD `delivery_address_snapshot` text');
    expect(sql).not.toMatch(/\b(?:DELETE|UPDATE|DROP|TRUNCATE|REPLACE)\b/i);
    expect(sql).not.toMatch(/\bADD\s+`[^`]+`\s+\w+\s+NOT\s+NULL\b/i);
  });

  it('开发开放模式保留管理员联调，正式模式强制名单和成员角色', () => {
    const dbSource = readFileSync(new URL('../lib/db.ts', import.meta.url), 'utf8');
    const syncSource = readFileSync(
      new URL('../app/api/connectors/shopify/sync/route.ts', import.meta.url),
      'utf8',
    );
    expect(dbSource).toContain("'AUTH_REQUIRED'");
    expect(dbSource).toContain("developmentOpenAccess ? 'admin' : member.role");
    expect(dbSource).toContain('ERP_ACCESS_POLICY_REQUIRED');
    expect(dbSource).toContain('ERP_ACCESS_NOT_ALLOWED');
    expect(dbSource).toContain('ERP_ADMIN_BOOTSTRAP_EMAIL_REQUIRED');
    expect(dbSource).toContain('ERP_SYNC_OPERATOR_EMAIL_REQUIRED');
    expect(syncSource).toContain('requireProductionAccessPolicy(runtimeEnv, user.email)');
  });
});

type RequiredTable = (typeof DATABASE_REQUIRED_TABLES)[number];
type RequiredColumnTable = keyof typeof DATABASE_REQUIRED_COLUMNS;

function readinessColumns(): Record<RequiredColumnTable, string[]> {
  return Object.fromEntries(
    Object.entries(DATABASE_REQUIRED_COLUMNS).map(([table, columns]) => [table, [...columns]]),
  ) as Record<RequiredColumnTable, string[]>;
}

function readinessDatabase(input: {
  tables?: readonly RequiredTable[];
  columns?: Record<RequiredColumnTable, string[]>;
} = {}) {
  const tables = input.tables ?? DATABASE_REQUIRED_TABLES;
  const columns = input.columns ?? readinessColumns();
  return {
    prepare(sql: string) {
      return {
        async all<T>() {
          if (sql.includes('sqlite_master')) {
            return { results: tables.map((name) => ({ name })) as T[] };
          }
          const match = sql.match(/PRAGMA table_info\('([^']+)'\)/u);
          const table = match?.[1] as RequiredColumnTable | undefined;
          return {
            results: (table ? columns[table] : []).map((name) => ({ name })) as T[],
          };
        },
      };
    },
  } as unknown as D1Database;
}
