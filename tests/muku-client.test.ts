import { describe, expect, it, vi } from 'vitest';
import { MukuDashboardClient } from '../lib/connectors/muku/client';
import { MukuDashboardConfig } from '../lib/connectors/muku/config';
import { sanitizedMukuConnectorError } from '../lib/connectors/muku/errors';
import { MUKU_DATASETS } from '../lib/connectors/muku/types';

const testKey = 'test-muku-read-only-key-with-more-than-32-characters';
const config = new MukuDashboardConfig('https://muku.example.test', testKey);
const metadata = {
  ok: true,
  apiVersion: 'v1',
  generatedAt: '2026-11-02T07:30:29.821Z',
  source: 'test-source',
  grain: 'test-grain',
  businessTimezone: null,
  refreshCadence: 'test-only',
  zeroSemantics: 'null remains unknown',
  filters: {},
};

describe('MUKU 只读 API 客户端', () => {
  it('验证完整 manifest，Bearer 只发送到固定 HTTPS 地址且不跟随重定向', async () => {
    const fakeFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.origin).toBe('https://muku.example.test');
      expect(url.pathname).toBe('/api/integrations/erp/v1/export');
      expect(url.searchParams.get('dataset')).toBe('manifest');
      expect(init?.redirect).toBe('manual');
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${testKey}`);
      return jsonResponse({
        ...metadata,
        dataset: 'manifest',
        datasets: MUKU_DATASETS.map((id) => ({ id })),
      });
    }) as typeof fetch;
    const client = new MukuDashboardClient(config, fakeFetch);

    const manifest = await client.verifyManifest();

    expect(manifest.datasetIds).toEqual(MUKU_DATASETS);
    expect(fakeFetch).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(client)).not.toContain(testKey);
  });

  it('完整读取分页并原样保留 null，不把未知值转换成 0', async () => {
    const fakeFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const page = Number(url.searchParams.get('page'));
      expect(url.searchParams.get('pageSize')).toBe('2');
      return page === 1
        ? dataPage('inventory', page, 2, 3, 2, true, [
          { recordKey: 'one', available: null, nested: { quantity: null } },
          { recordKey: 'two', available: 0 },
        ])
        : dataPage('inventory', page, 2, 3, 2, false, [
          { recordKey: 'three', available: 5 },
        ]);
    }) as typeof fetch;
    const client = new MukuDashboardClient(config, fakeFetch);

    const result = await client.getAllPages('inventory', {}, { pageSize: 2 });

    expect(result.pageCount).toBe(2);
    expect(result.total).toBe(3);
    expect(result.data).toEqual([
      { recordKey: 'one', available: null, nested: { quantity: null } },
      { recordKey: 'two', available: 0 },
      { recordKey: 'three', available: 5 },
    ]);
  });

  it('只对 429 和 5xx 做有限重试并尊重 Retry-After', async () => {
    const sleep = vi.fn(async () => undefined);
    const fakeFetch = vi.fn()
      .mockResolvedValueOnce(new Response(null, {
        status: 429,
        headers: { 'Retry-After': '0', 'x-request-id': 'rate-limit-request' },
      }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(dataPage('inventory', 1, 500, 1, 1, false, [
        { recordKey: 'recovered', available: null },
      ])) as typeof fetch;
    const client = new MukuDashboardClient(config, fakeFetch, sleep, () => 0);

    const result = await client.getPage('inventory');

    expect(result.data).toHaveLength(1);
    expect(fakeFetch).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenNthCalledWith(1, 0);
  });

  it.each([400, 401])('HTTP %s 不盲目重试且错误不泄露密钥', async (status) => {
    const fakeFetch = vi.fn(async () => new Response(null, { status })) as typeof fetch;
    const client = new MukuDashboardClient(config, fakeFetch, async () => undefined, () => 0);

    let failure: unknown;
    try {
      await client.getPage('inventory');
    } catch (error) {
      failure = error;
    }

    expect(fakeFetch).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(sanitizedMukuConnectorError(failure))).not.toContain(testKey);
    expect(failure).toMatchObject({
      code: status === 401 ? 'MUKU_AUTH_FAILED' : 'MUKU_HTTP_ERROR',
      retryable: false,
    });
  });

  it('拒绝重定向，避免 Bearer 被转发到其他站点', async () => {
    const fakeFetch = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { Location: 'https://example.invalid/collect' },
    })) as typeof fetch;
    const client = new MukuDashboardClient(config, fakeFetch);

    await expect(client.getPage('inventory')).rejects.toMatchObject({
      code: 'MUKU_REDIRECT_REJECTED',
      retryable: false,
    });
    expect(fakeFetch).toHaveBeenCalledTimes(1);
  });

  it('严格拒绝错误版本、错误数据集和错页响应', async () => {
    const wrongVersion = new MukuDashboardClient(config, vi.fn(async () => jsonResponse({
      ...metadata,
      apiVersion: 'v2',
      dataset: 'inventory',
      pagination: pagination(1, 500, 0, 0, false),
      data: [],
    })) as typeof fetch);
    await expect(wrongVersion.getPage('inventory')).rejects.toMatchObject({
      code: 'MUKU_VERSION_MISMATCH',
    });

    const wrongDataset = new MukuDashboardClient(config, vi.fn(async () => jsonResponse({
      ...metadata,
      dataset: 'source-status',
      pagination: pagination(1, 500, 0, 0, false),
      data: [],
    })) as typeof fetch);
    await expect(wrongDataset.getPage('inventory')).rejects.toMatchObject({
      code: 'MUKU_DATASET_MISMATCH',
    });

    const wrongPage = new MukuDashboardClient(config, vi.fn(async () => dataPage(
      'inventory', 2, 500, 0, 0, false, [],
    )) as typeof fetch);
    await expect(wrongPage.getPage('inventory')).rejects.toMatchObject({
      code: 'MUKU_PAGINATION_INVALID',
    });
  });

  it('分页返回重复内容时停止，避免重复入库或无限循环', async () => {
    const repeatedRows = [{ recordKey: 'same' }, { recordKey: 'same-again' }];
    const fakeFetch = vi.fn(async (input: RequestInfo | URL) => {
      const page = Number(new URL(String(input)).searchParams.get('page'));
      return dataPage('inventory', page, 2, 4, 2, page === 1, repeatedRows);
    }) as typeof fetch;
    const client = new MukuDashboardClient(config, fakeFetch);

    await expect(client.getAllPages('inventory', {}, { pageSize: 2 })).rejects.toMatchObject({
      code: 'MUKU_PAGINATION_LOOP',
    });
  });

  it('连接超时使用安全错误且按配置停止重试', async () => {
    const fakeFetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>(
      (_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
    )) as typeof fetch;
    const client = new MukuDashboardClient(
      config,
      fakeFetch,
      async () => undefined,
      () => 0,
      { connectTimeoutMilliseconds: 1, maxAttempts: 1 },
    );

    await expect(client.getPage('inventory')).rejects.toMatchObject({
      code: 'MUKU_CONNECT_TIMEOUT',
      retryable: true,
    });
    expect(fakeFetch).toHaveBeenCalledTimes(1);
  });
});

function dataPage(
  dataset: string,
  page: number,
  pageSize: number,
  total: number,
  totalPages: number,
  hasNext: boolean,
  data: Array<Record<string, unknown>>,
) {
  return jsonResponse({
    ...metadata,
    dataset,
    pagination: pagination(page, pageSize, total, totalPages, hasNext),
    data,
  });
}

function pagination(
  page: number,
  pageSize: number,
  total: number,
  totalPages: number,
  hasNext: boolean,
) {
  return { page, pageSize, total, totalPages, hasNext };
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
