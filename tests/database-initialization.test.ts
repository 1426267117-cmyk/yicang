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
});
