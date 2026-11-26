import { describe, expect, it, vi } from 'vitest';
import { createAmazonOrdersSource, isAmazonMarketplaceId } from '../lib/connectors/amazon/orders';

const marketplaceId = 'ATVPDKIKX0DER';
const now = Date.parse('2026-11-25T06:00:00Z');
const orderId = '000-0000000-0000001';
const credentials = {
  marketplaceId, clientId: 'test-client-id', clientSecret: 'test-client-secret', refreshToken: 'test-seller-refresh-token',
};
const window = { since: '2026-11-25T12:00:00+08:00', until: '2026-11-25T05:00:00Z' };
const anchor = (id = orderId, marketplace = marketplaceId) => ({ order: { orderId: id, salesChannel: { marketplaceId: marketplace } } });
const accessToken = (token = 'test-lwa-access-token') => ({ access_token: token, token_type: 'bearer', expires_in: 3600 });

function exampleOrder(id = orderId, marketplace = marketplaceId) {
  return {
    orderId: id, createdTime: '2026-11-25T03:05:03Z', lastUpdatedTime: '2026-11-25T04:15:04Z',
    salesChannel: { marketplaceId: marketplace, channelName: 'Amazon' },
    buyer: { buyerEmail: 'NEVER_STORE_BUYER' }, recipient: { fullname: 'NEVER_STORE_RECIPIENT' },
    proceeds: { grandTotal: { amount: '125.25', currencyCode: 'USD' } },
    fulfillment: { fulfillmentStatus: 'PARTIALLY_SHIPPED', fulfilledBy: 'MERCHANT', shipTo: 'NEVER_STORE_SHIP_TO' },
    orderItems: [{
      orderItemId: 'TEST-LINE-1', quantityOrdered: 3,
      product: { sellerSku: ' fixture-01 ', asin: 'TESTASIN01', title: 'Fixture Chair', customization: { data: 'NEVER_STORE_CUSTOM' },
        price: { unitPrice: { amount: '41.75', currencyCode: 'USD' } } },
      fulfillment: { quantityFulfilled: 1, quantityUnfulfilled: 2 },
      proceeds: { proceedsTotal: { amount: '125.25', currencyCode: 'USD' } },
    }],
  };
}

function stub(...responses: Response[]) {
  const fetch = vi.fn<typeof globalThis.fetch>();
  for (const response of responses) fetch.mockResolvedValueOnce(response);
  return fetch;
}

function workingSource(...responses: Response[]) {
  const fetch = stub(Response.json(accessToken()), Response.json(anchor()), ...responses);
  return { fetch, source: createAmazonOrdersSource(credentials, { fetch, now: () => now }) };
}

describe('Amazon Orders v2026-01-01 只读来源', () => {
  it('店铺核验后只读指定站点，按固定窗口续页，缓存当前卖家 LWA access token', async () => {
    const cursor = 'page/fixture+token=';
    const { fetch, source } = workingSource(
      Response.json({ orders: [exampleOrder()], pagination: { nextToken: cursor } }),
      Response.json({ orders: [] }),
    );
    await expect(source.searchOrders(window)).rejects.toMatchObject({ code: 'AMAZON_STORE_IDENTITY_UNVERIFIED' });
    expect(fetch).not.toHaveBeenCalled();
    await source.verifyOrder(orderId);
    const firstPage = await source.searchOrders(window);
    expect(firstPage).toMatchObject({ hasNextPage: true, endCursor: cursor, nodes: [{
      platform: 'amazon', sourceOrderId: orderId, fulfillmentStatus: 'PARTIALLY_SHIPPED',
      currentTotal: { amount: '125.25', currency: 'USD', minor: 12525 },
      lines: [{ rawSku: ' fixture-01 ', normalizedSku: 'FIXTURE-01', sourceProductId: 'TESTASIN01',
        orderedQuantity: 3, currentQuantity: null, unfulfilledQuantity: 2, unitPrice: { amount: '41.75', currency: 'USD', minor: 4175 } }],
    }] });
    expect(JSON.stringify(firstPage)).not.toContain('NEVER_STORE');
    await expect(source.searchOrders({ ...window, cursor })).resolves.toEqual({ hasNextPage: false, endCursor: null, nodes: [] });
    const [token, verify, first, second] = fetch.mock.calls;
    expect(String(token[0])).toBe('https://api.amazon.com/auth/o2/token');
    expect(token[1]).toMatchObject({ method: 'POST', redirect: 'manual', cache: 'no-store' });
    expect(Object.fromEntries(token[1]?.body as URLSearchParams)).toEqual({
      grant_type: 'refresh_token', refresh_token: credentials.refreshToken, client_id: credentials.clientId, client_secret: credentials.clientSecret,
    });
    expect(new URL(String(verify[0])).pathname).toBe(`/orders/2026-01-01/orders/${orderId}`);
    expect(new URL(String(verify[0])).search).toBe('');
    for (const call of [verify, first, second]) {
      expect(call[1]).toMatchObject({ method: 'GET', redirect: 'manual', cache: 'no-store',
        headers: { 'x-amz-access-token': 'test-lwa-access-token', 'x-amz-date': '20261125T060000Z' } });
      expect(new URL(String(call[0])).origin).toBe('https://sellingpartnerapi-na.amazon.com');
      expect(call[1]?.body).toBeUndefined();
    }
    const firstQuery = Object.fromEntries(new URL(String(first[0])).searchParams);
    const secondQuery = Object.fromEntries(new URL(String(second[0])).searchParams);
    expect(firstQuery).toEqual({ lastUpdatedAfter: '2026-11-25T04:00:00.000Z', lastUpdatedBefore: '2026-11-25T05:00:00.000Z',
      marketplaceIds: marketplaceId, maxResultsPerPage: '100', includedData: 'FULFILLMENT,PROCEEDS' });
    expect(secondQuery).toEqual({ ...firstQuery, paginationToken: cursor });
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it('按凭证和站点隔离来源，拒绝跨站锚点及订单，也拒绝未经核验的续页', async () => {
    const sellerFetch = stub(Response.json(accessToken()), Response.json(anchor(orderId, 'A2EUQ1WTGCTBG2')));
    const wrongSeller = createAmazonOrdersSource(credentials, { fetch: sellerFetch, now: () => now });
    await expect(wrongSeller.verifyOrder(orderId)).rejects.toMatchObject({ code: 'AMAZON_STORE_IDENTITY_UNVERIFIED' });
    await expect(wrongSeller.searchOrders({ ...window, cursor: 'fixture-next' })).rejects.toMatchObject({ code: 'AMAZON_STORE_IDENTITY_UNVERIFIED' });
    expect(sellerFetch).toHaveBeenCalledTimes(2);
    const { source } = workingSource(Response.json({ orders: [exampleOrder(), exampleOrder('000-0000000-0000002', 'A2EUQ1WTGCTBG2')] }));
    await source.verifyOrder(orderId);
    await expect(source.searchOrders(window)).rejects.toMatchObject({ code: 'AMAZON_ORDER_MARKETPLACE_MISMATCH' });
    const wrongOrderFetch = stub(Response.json(accessToken()), Response.json(anchor('000-0000000-0000009')));
    const wrongOrder = createAmazonOrdersSource(credentials, { fetch: wrongOrderFetch, now: () => now });
    await expect(wrongOrder.verifyOrder(orderId)).rejects.toMatchObject({ code: 'AMAZON_STORE_IDENTITY_UNVERIFIED' });
    await expect(wrongOrder.verifyOrder('../orders?unexpected=true')).rejects.toMatchObject({ code: 'AMAZON_STORE_IDENTITY_UNVERIFIED' });
    expect(wrongOrderFetch).toHaveBeenCalledTimes(2);
  });

  it.each([['A1PA6795UKMFR9', 'eu'], ['A1VC38T7YXB528', 'fe']])('为 %s 使用固定的 %s 区域端点', async (marketplace, region) => {
    expect(isAmazonMarketplaceId(marketplace)).toBe(true);
    const fetch = stub(Response.json(accessToken()), Response.json(anchor(orderId, marketplace)), Response.json({ orders: [] }));
    const source = createAmazonOrdersSource({ ...credentials, marketplaceId: marketplace }, { fetch, now: () => now });
    await source.verifyOrder(orderId);
    await source.searchOrders(window);
    const query = new URL(String(fetch.mock.calls[2][0]));
    expect(query.origin).toBe(`https://sellingpartnerapi-${region}.amazon.com`);
    expect(query.searchParams.get('marketplaceIds')).toBe(marketplace);
    expect(() => createAmazonOrdersSource({ ...credentials, marketplaceId: 'https://untrusted.invalid' }, { fetch }))
      .toThrow(expect.objectContaining({ code: 'AMAZON_CONFIGURATION_INVALID' }));
  });

  it('保留未知履约、金额及 SKU，没有数据时不推断金额或库存', async () => {
    const sample = { ...exampleOrder(), fulfillment: { fulfillmentStatus: 'UNKNOWN_PROVIDER_STATUS' }, proceeds: undefined,
      orderItems: [{ orderItemId: 'TEST-LINE-2', quantityOrdered: 3,
        product: { asin: 'TESTASIN02', price: { unitPrice: { currencyCode: 'ZZZ', amount: '12.34' } } } }] };
    const { source } = workingSource(Response.json({ orders: [sample] }));
    await source.verifyOrder(orderId);
    const { nodes: [order] } = await source.searchOrders(window);
    expect(order).toMatchObject({ fulfillmentStatus: 'UNKNOWN_PROVIDER_STATUS', currency: null,
      currentTotal: null, originalTotal: null, sourceCancelledAt: null, test: null, financialStatus: null, businessDate: null,
      fulfillments: [], refunds: [], lines: [{ normalizedSku: null, rawSku: null, orderedQuantity: 3, currentQuantity: null,
        unfulfilledQuantity: null, originalTotal: null, unitPrice: { amount: '12.34', currency: 'ZZZ', minor: null } }] });
  });

  it('拒绝无效时间、失效分页和重复令牌，不丢弃有问题的订单继续推进游标', async () => {
    const { fetch, source } = workingSource(
      new Response('never include body', { status: 400 }),
      Response.json({ orders: [], pagination: { nextToken: 'stuck' } }),
      Response.json({ orders: [{ ...exampleOrder(), orderItems: [{ orderItemId: 'INVALID-LINE' }] }] }),
    );
    await source.verifyOrder(orderId);
    await expect(source.searchOrders({ ...window, until: '2026-11-25T05:58:01Z' })).rejects.toMatchObject({ code: 'AMAZON_WINDOW_INVALID' });
    await expect(source.searchOrders({ ...window, since: '2026-02-30T05:00:00Z' })).rejects.toMatchObject({ code: 'AMAZON_WINDOW_INVALID' });
    expect(fetch).toHaveBeenCalledTimes(2);
    await expect(source.searchOrders({ ...window, cursor: 'expired-token' })).rejects.toMatchObject({ code: 'AMAZON_PAGE_TOKEN_REJECTED', httpStatus: 400 });
    await expect(source.searchOrders({ ...window, cursor: 'stuck' })).rejects.toMatchObject({ code: 'AMAZON_PAGE_TOKEN_REJECTED' });
    await expect(source.searchOrders(window)).rejects.toMatchObject({ code: 'AMAZON_INVALID_RESPONSE' });
  });

  it('在 access token 过期时刷新一次，限流、重定向和授权错误保持脱敏', async () => {
    const fetch = stub(Response.json(accessToken()), Response.json(anchor()), new Response(null, { status: 401 }),
      Response.json(accessToken('refreshed-access-token')),
      new Response('raw-private-error', { status: 429, headers: { 'Retry-After': '180' } }),
      new Response('token-sink', { status: 302, headers: { Location: 'https://untrusted.invalid/path' } }),
      new Response('test-client-secret', { status: 403 }));
    const source = createAmazonOrdersSource(credentials, { fetch, now: () => now });
    await source.verifyOrder(orderId);
    await expect(source.searchOrders(window)).rejects.toMatchObject({ code: 'AMAZON_RATE_LIMITED', retryable: true, retryAfterSeconds: 180 });
    expect(fetch.mock.calls[4][1]?.headers).toMatchObject({ 'x-amz-access-token': 'refreshed-access-token' });
    await expect(source.searchOrders(window)).rejects.toMatchObject({ code: 'AMAZON_REDIRECT_REJECTED', httpStatus: 302 });
    await expect(source.searchOrders(window)).rejects.toMatchObject({ code: 'AMAZON_AUTH_FAILED', retryable: false });
    expect(fetch).toHaveBeenCalledTimes(7);
    expect(fetch.mock.calls.every(([url]) => new URL(String(url)).hostname.endsWith('.amazon.com'))).toBe(true);
  });

  it('给认证和订单请求设置超时，不传递底层异常消息', async () => {
    const fetch = stub();
    fetch.mockImplementation((_input, init) => new Promise((_resolve, reject) => {
      const fallback = setTimeout(() => reject(new Error('private-transport-value')), 200);
      init?.signal?.addEventListener('abort', () => {
        clearTimeout(fallback);
        reject(new Error('private-transport-value'));
      }, { once: true });
    }));
    const source = createAmazonOrdersSource(credentials, { fetch, now: () => now, timeoutMs: 10 });
    await expect(source.verifyOrder(orderId)).rejects.toMatchObject({ code: 'AMAZON_TIMEOUT', retryable: true, message: 'Amazon 未在限定时间内返回数据' });
    fetch.mockResolvedValueOnce(Response.json(accessToken()));
    await expect(source.verifyOrder(orderId)).rejects.toMatchObject({ code: 'AMAZON_TIMEOUT', retryable: true });
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});
