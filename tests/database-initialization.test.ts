import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

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

  it('新增正式迁移不写入店铺、订单或模拟业务数据', () => {
    const sql = [
      '../drizzle/0001_premium_the_stranger.sql',
      '../drizzle/0002_organic_titanium_man.sql',
      '../drizzle/0003_fancy_jane_foster.sql',
    ].map((migration) => readFileSync(new URL(migration, import.meta.url), 'utf8')).join('\n');
    expect(sql).not.toMatch(/INSERT\s+(?:OR\s+IGNORE\s+)?INTO\s+(platform_stores|platform_orders|platform_order_lines|platform_refunds|platform_fulfillments)/i);
  });

  it('真实平台数据在访问名单缺失时保持关闭', () => {
    const dbSource = readFileSync(new URL('../lib/db.ts', import.meta.url), 'utf8');
    const syncSource = readFileSync(
      new URL('../app/api/connectors/shopify/sync/route.ts', import.meta.url),
      'utf8',
    );
    expect(dbSource).toContain('ERP_ACCESS_POLICY_REQUIRED');
    expect(dbSource).toContain('ERP_ADMIN_BOOTSTRAP_EMAIL_REQUIRED');
    expect(dbSource).toContain('ERP_SYNC_OPERATOR_EMAIL_REQUIRED');
    expect(syncSource).toContain('requireProductionAccessPolicy(runtimeEnv, user.email)');
  });
});
