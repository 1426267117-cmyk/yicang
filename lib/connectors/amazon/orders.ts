import { asRecord } from '../canonical';
import type { ConnectorPage } from '../types';
import { AmazonConnectorError } from './errors';
import { amazonOrderId, mapAmazonOrder, parseAmazonTime, type AmazonOrderGraph } from './mapper';

export { AmazonConnectorError } from './errors';
export type { AmazonOrderGraph } from './mapper';

const marketplaces = {
  na: ['A2EUQ1WTGCTBG2', 'ATVPDKIKX0DER', 'A1AM78C64UM0Y8', 'A2Q3Y263D00KWC'],
  eu: ['A28R8C7NBKEWEA', 'A1RKKUPIHCS9HS', 'A1F83G8C2ARO7P', 'A13V1IB3VIYZZH', 'AMEN7PMS3EDWL',
    'A1805IZSGTT6HS', 'A1PA6795UKMFR9', 'APJ6JRA9NG5V4', 'A2NODRKZP88ZB9', 'AE08WJ6YKNBMC',
    'A1C3SOZRARQ6R3', 'ARBP9OOSHTCHU', 'A33AVAJ2PDY3EV', 'A17E79C6D8DWNP', 'A2VIGQ35RCS4UG', 'A21TJRUUN4KGV'],
  fe: ['A19VAU5U5O7RUS', 'A39IBJ37TRP1C6', 'A1VC38T7YXB528'],
} satisfies Record<string, string[]>;
const ordersPath = '/orders/2026-01-01/orders';
const tokenEndpoint = 'https://api.amazon.com/auth/o2/token';
export const amazonOrderCloseLagMs = 120_000;
const defaultFetch: typeof fetch = (input, init) => globalThis.fetch(input, init);

export type AmazonOrderSourceConfig = {
  marketplaceId: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
};
export type AmazonOrderSourceOptions = {
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
};
export type AmazonOrderPageInput = { since: string; until: string; cursor?: string | null };
type RequestPurpose = 'token' | 'verify' | 'search' | 'page' | 'order';

function marketplaceRegion(id: string) {
  return Object.entries(marketplaces).find(([, ids]) => ids.includes(id))?.[0];
}

export function isAmazonMarketplaceId(id: string) {
  return marketplaceRegion(id) !== undefined;
}

function retryDelay(response: Response, now: number) {
  const value = response.headers.get('retry-after');
  if (!value) return null;
  const seconds = /^\d{1,8}$/u.test(value) ? Number(value) : Math.ceil((Date.parse(value) - now) / 1000);
  return Number.isSafeInteger(seconds) && seconds >= 0 ? seconds : null;
}

function httpError(response: Response, purpose: RequestPurpose, now: number) {
  const status = response.status;
  if (response.type === 'opaqueredirect' || (status >= 300 && status < 400)) {
    return new AmazonConnectorError('AMAZON_REDIRECT_REJECTED', false, status);
  }
  if (status === 401 || status === 403 || (purpose === 'token' && status === 400)) {
    return new AmazonConnectorError('AMAZON_AUTH_FAILED', false, status);
  }
  if (status === 429) return new AmazonConnectorError('AMAZON_RATE_LIMITED', true, status, retryDelay(response, now));
  if (purpose === 'verify' && (status === 400 || status === 404)) {
    return new AmazonConnectorError('AMAZON_STORE_IDENTITY_UNVERIFIED', false, status);
  }
  if (purpose === 'page' && status === 400) return new AmazonConnectorError('AMAZON_PAGE_TOKEN_REJECTED', false, status);
  return new AmazonConnectorError('AMAZON_HTTP_ERROR', status === 408 || status >= 500, status, retryDelay(response, now));
}

function validCursor(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 12_000 && /^[!-~]+$/u.test(value);
}

export function createAmazonOrdersSource(config: AmazonOrderSourceConfig, options: AmazonOrderSourceOptions = {}) {
  const { marketplaceId, clientId, clientSecret, refreshToken } = config;
  const region = marketplaceRegion(marketplaceId);
  const { fetch: fetchImpl = defaultFetch, now = Date.now, timeoutMs = 15_000 } = options;
  if (!region || [clientId, clientSecret, refreshToken].some((value) => typeof value !== 'string' || !value.trim() || value.length > 2048)
    || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new AmazonConnectorError('AMAZON_CONFIGURATION_INVALID');
  }
  const base = `https://sellingpartnerapi-${region}.amazon.com`;
  let verified = false;
  let tokenCache: { value: string; usableUntil: number } | null = null;
  let refreshInProgress: Promise<string> | null = null;

  async function requestJson(url: string | URL, init: RequestInit, purpose: RequestPurpose) {
    const signal = AbortSignal.timeout(timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(url, { ...init, redirect: 'manual', cache: 'no-store', signal });
    } catch {
      throw new AmazonConnectorError(signal.aborted ? 'AMAZON_TIMEOUT' : 'AMAZON_NETWORK_ERROR', true);
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      throw httpError(response, purpose, now());
    }
    const parsed: unknown = await response.json().catch(() => null);
    if (signal.aborted) throw new AmazonConnectorError('AMAZON_TIMEOUT', true);
    const body = asRecord(parsed);
    if (!body || body.errors !== undefined) throw new AmazonConnectorError('AMAZON_INVALID_RESPONSE');
    return body;
  }

  async function renewAccessToken() {
    const response = await requestJson(tokenEndpoint, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret }),
    }, 'token');
    const { access_token: token, expires_in: expiresIn, token_type: tokenType } = response;
    if (typeof token !== 'string' || token.length > 2048 || !/^[!-~]+$/u.test(token)
      || typeof expiresIn !== 'number' || !Number.isInteger(expiresIn) || expiresIn <= 0
      || typeof tokenType !== 'string' || tokenType.toLowerCase() !== 'bearer') {
      throw new AmazonConnectorError('AMAZON_INVALID_RESPONSE');
    }
    const lifetime = Math.min(expiresIn, 3600) * 1000;
    tokenCache = { value: token, usableUntil: now() + lifetime - Math.min(60_000, lifetime / 10) };
    return token;
  }

  async function accessToken() {
    if (tokenCache && tokenCache.usableUntil > now()) return tokenCache.value;
    refreshInProgress ??= renewAccessToken().finally(() => { refreshInProgress = null; });
    return refreshInProgress;
  }

  async function ordersRequest(url: URL, purpose: Exclude<RequestPurpose, 'token'>) {
    function withToken(token: string) {
      return requestJson(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json', 'x-amz-access-token': token,
          'x-amz-date': new Date(now()).toISOString().replace(/[:-]|\.\d{3}/gu, ''),
          'User-Agent': 'YicangERP/0.1.0 (Language=TypeScript)',
        },
      }, purpose);
    }
    const token = await accessToken();
    try {
      return await withToken(token);
    } catch (error) {
      if (!(error instanceof AmazonConnectorError) || error.httpStatus !== 401) throw error;
      if (tokenCache?.value === token) tokenCache = null;
      return withToken(await accessToken());
    }
  }

  async function verifyOrder(orderId: string): Promise<void> {
    verified = false;
    if (typeof orderId !== 'string' || !amazonOrderId.test(orderId)) throw new AmazonConnectorError('AMAZON_STORE_IDENTITY_UNVERIFIED');
    // Orders does not expose the seller ID. The caller supplies a known order from this seller and marketplace.
    const response = await ordersRequest(new URL(`${ordersPath}/${orderId}`, base), 'verify');
    const order = asRecord(response.order);
    if (order?.orderId !== orderId || asRecord(order.salesChannel)?.marketplaceId !== marketplaceId) {
      throw new AmazonConnectorError('AMAZON_STORE_IDENTITY_UNVERIFIED');
    }
    verified = true;
  }

  async function searchOrders({ since, until, cursor }: AmazonOrderPageInput): Promise<ConnectorPage<AmazonOrderGraph>> {
    if (!verified) throw new AmazonConnectorError('AMAZON_STORE_IDENTITY_UNVERIFIED');
    const after = parseAmazonTime(since);
    const before = parseAmazonTime(until);
    if (after === null || before === null || after > before || before > now() - amazonOrderCloseLagMs) {
      throw new AmazonConnectorError('AMAZON_WINDOW_INVALID');
    }
    if (cursor != null && !validCursor(cursor)) throw new AmazonConnectorError('AMAZON_PAGE_TOKEN_REJECTED');
    const url = new URL(ordersPath, base);
    url.search = new URLSearchParams({
      lastUpdatedAfter: new Date(after).toISOString(), lastUpdatedBefore: new Date(before).toISOString(),
      marketplaceIds: marketplaceId, maxResultsPerPage: '100', includedData: 'FULFILLMENT,PROCEEDS',
    }).toString();
    if (cursor != null) url.searchParams.set('paginationToken', cursor);
    const response = await ordersRequest(url, cursor == null ? 'search' : 'page');
    if (!Array.isArray(response.orders)) throw new AmazonConnectorError('AMAZON_INVALID_RESPONSE');
    const pagination = asRecord(response.pagination);
    if (response.pagination != null && !pagination) throw new AmazonConnectorError('AMAZON_INVALID_RESPONSE');
    const next = pagination?.nextToken;
    if (next != null && (!validCursor(next) || next === cursor)) throw new AmazonConnectorError('AMAZON_PAGE_TOKEN_REJECTED');
    const nodes = response.orders.map((order) => mapAmazonOrder(order, marketplaceId));
    if (new Set(nodes.map((order) => order.sourceOrderId)).size !== nodes.length) throw new AmazonConnectorError('AMAZON_INVALID_RESPONSE');
    return { nodes, hasNextPage: next != null, endCursor: next ?? null };
  }

  async function readOrder(orderId: string): Promise<AmazonOrderGraph> {
    if (!verified) throw new AmazonConnectorError('AMAZON_STORE_IDENTITY_UNVERIFIED');
    if (!amazonOrderId.test(orderId)) throw new AmazonConnectorError('AMAZON_INVALID_RESPONSE');
    const url = new URL(`${ordersPath}/${orderId}`, base);
    url.searchParams.set('includedData', 'FULFILLMENT,PROCEEDS');
    const response = await ordersRequest(url, 'order');
    const order = mapAmazonOrder(response.order, marketplaceId);
    if (order.sourceOrderId !== orderId) throw new AmazonConnectorError('AMAZON_INVALID_RESPONSE');
    return order;
  }

  return { verifyOrder, searchOrders, readOrder };
}
