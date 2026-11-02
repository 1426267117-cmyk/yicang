import { describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({ env: {} }));

import { handleHealthRequest } from '../app/api/health/route';
import { DATABASE_SCHEMA_READINESS } from '../db/initialize';
import type { requestContext } from '../lib/db';

describe('ERP 健康检查', () => {
  it('只有完整迁移的数据库才返回 ready', async () => {
    const response = await handleHealthRequest(
      new Request('https://erp.example/api/health'),
      (async () => ({
        db: {
          prepare: () => ({
            first: async () => ({ count: 7 }),
          }),
        } as unknown as D1Database,
      })) as unknown as typeof requestContext,
    );
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(body).toEqual({
      ok: true,
      database: 'ready',
      schemaReadiness: DATABASE_SCHEMA_READINESS,
      orders: 7,
    });
  });

  it('漏迁移时返回安全的 not-ready 响应，不泄露 SQL 细节', async () => {
    const response = await handleHealthRequest(
      new Request('https://erp.example/api/health'),
      (async () => {
        throw new Error('DATABASE_MIGRATIONS_PENDING');
      }) as unknown as typeof requestContext,
    );
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(503);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(body).toEqual({
      ok: false,
      code: 'DATABASE_MIGRATIONS_PENDING',
      message: '数据库迁移尚未完成，请重新部署当前版本',
    });
  });
});
