import { describe, expect, it, vi } from 'vitest';
import { createWayfairDropshipSource, wayfairDropshipOrderLimit } from '../lib/connectors/wayfair/dropship-orders';

const configuration = { environment: 'production', supplierIds: ['4242'], clientId: 'fixture-client', clientSecret: 'fixture-secret' } as const;
const date = '2026-11-25T06:00:00Z';
const options = { now: () => Date.parse(date), sleep: async () => {} };
const token = (accessToken = 'fixture-wayfair-token') => Response.json({ token_type: 'Bearer', access_token: accessToken, expires_in: 43_200 });
const variables = (body?: BodyInit | null) => (JSON.parse(String(body)) as { query: string; variables: Record<string, unknown> }).variables;
const list = (...orders: object[]) => Response.json({ data: { getDropshipPurchaseOrders: orders } });

function order(id = 1, supplierId = 4242) {
  return {
    id, poNumber: `PO-FIXTURE-${id}`, supplierId, poDate: '2026-11-24 10:16:44.000000 -04:00',
    customerName: 'never-store-customer', shipTo: { phoneNumber: 'never-store-phone' },
    products: [
      { partNumber: ' un-005 ', sku: 'WF-FIXTURE-05', name: 'Fixture Product', quantity: '2', isCancelled: false,
        customComment: 'never-store-custom', price: 15, totalCost: 30 },
      { partNumber: null, sku: 'WF-ONLY', name: null, quantity: null, isCancelled: null },
    ],
  };
}

function mockFetch(...responses: Response[]) {
  const fetch = vi.fn<typeof globalThis.fetch>();
  for (const response of responses) fetch.mockResolvedValueOnce(response);
  return fetch;
}

describe('Wayfair 官方 Dropship 采购单只读来源', () => {
  it('按供应商授权核验已确认 PO，再读取未确认 PO，且不请求个人信息和采购写入', async () => {
    const fetch = mockFetch(token(), list(order()), list(order(2)));
    const sleep = vi.fn(options.sleep);
    const source = createWayfairDropshipSource(configuration, { ...options, fetch, sleep });
    await expect(source.readOrders({ hasResponse: false })).rejects.toMatchObject({ code: 'WAYFAIR_STORE_IDENTITY_UNVERIFIED' });
    expect(fetch).not.toHaveBeenCalled();
    await source.verifyOrder('PO-FIXTURE-1', true);
    const response = await source.readOrders({ hasResponse: false, fromDate: '2026-11-24T10:00:00+08:00' });
    expect(response).toEqual({ hasResponse: false, possiblyTruncated: false, orders: [{ id: '2', supplierId: '4242',
      poNumber: 'PO-FIXTURE-2', createdAt: '2026-11-24T14:16:44.000Z', sourcePoDate: '2026-11-24 10:16:44.000000 -04:00',
      lines: [
        { supplierSku: ' un-005 ', normalizedSupplierSku: 'UN-005', wayfairSku: 'WF-FIXTURE-05', title: 'Fixture Product', quantity: 2, cancelled: false },
        { supplierSku: null, normalizedSupplierSku: null, wayfairSku: 'WF-ONLY', title: null, quantity: null, cancelled: null },
      ],
    }] });
    const [authentication, identity, openOrders] = fetch.mock.calls;
    expect(authentication[0]).toBe('https://sso.auth.wayfair.com/oauth/token');
    expect(authentication[1]).toMatchObject({ method: 'POST', redirect: 'manual', cache: 'no-store' });
    expect(JSON.parse(String(authentication[1]?.body))).toEqual({ grant_type: 'client_credentials', client_id: configuration.clientId,
      client_secret: configuration.clientSecret, audience: 'https://api.wayfair.com/' });
    for (const call of [identity, openOrders]) {
      expect(call[0]).toBe('https://api.wayfair.com/v1/graphql');
      expect(call[1]).toMatchObject({ method: 'POST', redirect: 'manual', cache: 'no-store', headers: { Authorization: 'Bearer fixture-wayfair-token' } });
      const sent = JSON.parse(String(call[1]?.body)) as { query: string };
      expect(sent.query).toMatch(/^query ReadDropshipOrders/u);
      expect(sent.query).toContain('getDropshipPurchaseOrders');
      expect(sent.query).not.toMatch(/customer|shipTo|billTo|mutation|accept|price|totalCost|supplierAddress/iu);
    }
    expect(variables(identity[1]?.body)).toEqual({ limit: 25, hasResponse: true, poNumbers: ['PO-FIXTURE-1'] });
    expect(variables(openOrders[1]?.body)).toEqual({ limit: 25, hasResponse: false, fromDate: '2026-11-24 02:00:00.000000 +00:00' });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledExactlyOnceWith(3_000);
  });

  it('明确标识开放窗口达到上限，已知 PO 查询无伪造分页和发货状态', async () => {
    const batch = Array.from({ length: wayfairDropshipOrderLimit }, (_, index) => order(index + 1));
    const fetch = mockFetch(token(), list(order()), list(...batch), list(order(3)));
    const source = createWayfairDropshipSource(configuration, { ...options, fetch });
    await source.verifyOrder('PO-FIXTURE-1', true);
    expect(await source.readOrders({ hasResponse: false })).toMatchObject({ hasResponse: false, possiblyTruncated: true });
    const result = await source.readOrders({ hasResponse: true, poNumbers: ['PO-FIXTURE-3'] });
    expect(result).toMatchObject({ hasResponse: true, possiblyTruncated: false, orders: [{ poNumber: 'PO-FIXTURE-3' }] });
    expect(result.orders[0]).not.toHaveProperty('updatedAt');
    expect(result.orders[0]).not.toHaveProperty('fulfillmentStatus');
  });

  it('沙箱使用单独受众和端点，省略不受支持的取消字段', async () => {
    const sample = { ...order(), products: [{ partNumber: 'SKU-1', quantity: 'unavailable' }] };
    const fetch = mockFetch(token(), list(sample), list(sample));
    const source = createWayfairDropshipSource({ ...configuration, environment: 'sandbox' }, { ...options, fetch });
    await source.verifyOrder('PO-FIXTURE-1', false);
    const result = await source.readOrders({ hasResponse: false });
    expect(result.orders[0].lines[0]).toMatchObject({ cancelled: null, quantity: null });
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toMatchObject({ audience: 'https://sandbox.api.wayfair.com/' });
    expect(fetch.mock.calls[1][0]).toBe('https://sandbox.api.wayfair.com/v1/graphql');
    expect(JSON.parse(String(fetch.mock.calls[1][1]?.body)).query).not.toContain('isCancelled');
  });

  it('空结果不会完成身份核验，混入其他供应商订单或错误采购单时整批拒绝', async () => {
    const fetch = mockFetch(token(), list(), list(order(1, 9000)), list(order()), list(order(2), order(3, 9000)), list(order(4)));
    const source = createWayfairDropshipSource(configuration, { ...options, fetch });
    await expect(source.verifyOrder('PO-FIXTURE-1', true)).rejects.toMatchObject({ code: 'WAYFAIR_STORE_IDENTITY_UNVERIFIED' });
    await expect(source.verifyOrder('PO-FIXTURE-1', true)).rejects.toMatchObject({ code: 'WAYFAIR_SUPPLIER_MISMATCH' });
    await source.verifyOrder('PO-FIXTURE-1', true);
    await expect(source.readOrders({ hasResponse: false })).rejects.toMatchObject({ code: 'WAYFAIR_SUPPLIER_MISMATCH' });
    await expect(source.readOrders({ hasResponse: true, poNumbers: ['PO-FIXTURE-3'] })).rejects.toMatchObject({ code: 'WAYFAIR_INVALID_RESPONSE' });
  });

  it('按状态处理授权重试、限流、重定向和 GraphQL 部分错误，不返回上游正文', async () => {
    const fetch = mockFetch(token(), list(order()), new Response(null, { status: 401 }), token('fixture-renewed'),
      new Response('private rate error', { status: 429 }), new Response('private redirected location', { status: 302,
        headers: { Location: 'https://untrusted.invalid' } }),
      Response.json({ data: { getDropshipPurchaseOrders: [order(3)] }, errors: [{ message: 'private graphql error' }] }));
    const source = createWayfairDropshipSource(configuration, { ...options, fetch });
    await source.verifyOrder('PO-FIXTURE-1', true);
    await expect(source.readOrders({ hasResponse: false })).rejects.toMatchObject({ code: 'WAYFAIR_RATE_LIMITED', retryable: true });
    expect(fetch.mock.calls[4][1]?.headers).toMatchObject({ Authorization: 'Bearer fixture-renewed' });
    await expect(source.readOrders({ hasResponse: false })).rejects.toMatchObject({ code: 'WAYFAIR_REDIRECT_REJECTED' });
    await expect(source.readOrders({ hasResponse: false })).rejects.toMatchObject({ code: 'WAYFAIR_QUERY_REJECTED', message: 'Wayfair 暂时无法完成采购单查询，详细信息已脱敏' });
    expect(fetch).toHaveBeenCalledTimes(7);
  });

  it('拒绝不合法单号或日期，并对订单 HTTP 调用执行超时', async () => {
    const fetch = mockFetch(token(), list(order()));
    fetch.mockImplementation((_input, init) => new Promise((_resolve, reject) => {
      const fallback = setTimeout(() => reject(new Error('private-transport-text')), 200);
      init?.signal?.addEventListener('abort', () => {
        clearTimeout(fallback);
        reject(new Error('private-transport-text'));
      }, { once: true });
    }));
    const source = createWayfairDropshipSource(configuration, { ...options, fetch, timeoutMs: 10 });
    await source.verifyOrder('PO-FIXTURE-1', true);
    await expect(source.readOrders({ hasResponse: false, fromDate: '2026-11-25T06:00:01Z' })).rejects.toMatchObject({ code: 'WAYFAIR_QUERY_INVALID' });
    await expect(source.readOrders({ hasResponse: true, poNumbers: ['invalid@order'] })).rejects.toMatchObject({ code: 'WAYFAIR_QUERY_INVALID' });
    expect(fetch).toHaveBeenCalledTimes(2);
    await expect(source.readOrders({ hasResponse: false })).rejects.toMatchObject({ code: 'WAYFAIR_TIMEOUT', retryable: true });
  });
});
