import { z } from 'zod';
import { asRecord, booleanOrNull, normalizeSku, stringOrNull } from '../canonical';

const environments = {
  production: 'https://api.wayfair.com/',
  sandbox: 'https://sandbox.api.wayfair.com/',
} as const;
const tokenUrl = 'https://sso.auth.wayfair.com/oauth/token';
export const wayfairPoNumberPattern = /^[A-Za-z0-9#_.-][A-Za-z0-9#_. -]{2,89}$/u;
const isoTimestamp = z.iso.datetime({ offset: true });
export const wayfairDropshipOrderLimit = 25;
export const wayfairDropshipMinimumIntervalMs = 3_000;

const messages = {
  WAYFAIR_CONFIGURATION_INVALID: 'Wayfair 店铺或供应商授权配置不完整',
  WAYFAIR_QUERY_INVALID: 'Wayfair 采购单号、查询范围或日期无效',
  WAYFAIR_STORE_IDENTITY_UNVERIFIED: 'Wayfair 授权尚未通过指定采购单核验',
  WAYFAIR_SUPPLIER_MISMATCH: 'Wayfair 返回了未授权配置的供应商订单，已停止读取',
  WAYFAIR_AUTH_FAILED: 'Wayfair 授权失效或缺少读取订单的权限',
  WAYFAIR_RATE_LIMITED: 'Wayfair 订单读取达到调用限额',
  WAYFAIR_REDIRECT_REJECTED: 'Wayfair 请求发生非预期重定向，已停止读取',
  WAYFAIR_TIMEOUT: 'Wayfair 未在限定时间内返回数据',
  WAYFAIR_NETWORK_ERROR: '暂时无法连接 Wayfair',
  WAYFAIR_HTTP_ERROR: 'Wayfair 暂时无法返回采购订单',
  WAYFAIR_QUERY_REJECTED: 'Wayfair 暂时无法完成采购单查询，详细信息已脱敏',
  WAYFAIR_INVALID_RESPONSE: 'Wayfair 返回的采购订单数据无效',
} as const;

export class WayfairConnectorError extends Error {
  constructor(readonly code: keyof typeof messages, readonly retryable = false, readonly httpStatus: number | null = null) {
    super(messages[code]);
    this.name = 'WayfairConnectorError';
  }
}

export type WayfairDropshipConfig = {
  environment: keyof typeof environments;
  supplierIds: readonly string[];
  clientId: string;
  clientSecret: string;
};
export type WayfairDropshipOptions = {
  fetch?: typeof fetch; now?: () => number; timeoutMs?: number; sleep?: (milliseconds: number) => Promise<void>;
};
export type WayfairDropshipQuery = { hasResponse: boolean; fromDate?: string; poNumbers?: readonly string[] };
export type WayfairDropshipOrder = {
  id: string;
  poNumber: string;
  supplierId: string;
  createdAt: string | null;
  sourcePoDate: string | null;
  lines: Array<{ supplierSku: string | null; normalizedSupplierSku: string | null; wayfairSku: string | null;
    title: string | null; quantity: number | null; cancelled: boolean | null }>;
};

function normalizeTime(value: string) {
  const iso = value.replace(/^(\d{4}-\d{2}-\d{2}) /u, '$1T').replace(/ (?=[+-]\d{2}:\d{2}$)/u, '');
  if (!isoTimestamp.safeParse(iso).success) return null;
  const time = Date.parse(iso);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function sourceId(value: unknown) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  return typeof value === 'string' && /^[1-9]\d{0,19}$/u.test(value) ? value : null;
}

function lineQuantity(value: unknown) {
  const number = typeof value === 'string' && /^\d{1,16}$/u.test(value) ? Number(value) : value;
  return typeof number === 'number' && Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function validPoNumber(value: unknown): value is string {
  return typeof value === 'string' && value.trim() === value && wayfairPoNumberPattern.test(value);
}

function mapOrder(value: unknown, allowedSupplierIds: ReadonlySet<string>): WayfairDropshipOrder {
  const order = asRecord(value);
  const supplierId = sourceId(order?.supplierId);
  if (!supplierId || !allowedSupplierIds.has(supplierId)) throw new WayfairConnectorError('WAYFAIR_SUPPLIER_MISMATCH');
  const id = sourceId(order?.id);
  const poNumber = order?.poNumber;
  if (!id || !validPoNumber(poNumber) || !Array.isArray(order?.products)) throw new WayfairConnectorError('WAYFAIR_INVALID_RESPONSE');
  const sourcePoDate = stringOrNull(order.poDate);
  const lines = order.products.map((row: unknown) => {
    const line = asRecord(row);
    if (!line) throw new WayfairConnectorError('WAYFAIR_INVALID_RESPONSE');
    const supplierSku = stringOrNull(line.partNumber);
    return { supplierSku, normalizedSupplierSku: normalizeSku(supplierSku), wayfairSku: stringOrNull(line.sku),
      title: stringOrNull(line.name), quantity: lineQuantity(line.quantity), cancelled: booleanOrNull(line.isCancelled) };
  });
  return { id, supplierId, poNumber, sourcePoDate, createdAt: sourcePoDate ? normalizeTime(sourcePoDate) : null, lines };
}

export function createWayfairDropshipSource(config: WayfairDropshipConfig, options: WayfairDropshipOptions = {}) {
  const { environment, clientId, clientSecret } = config;
  const {
    fetch: fetchImpl = (input, init) => globalThis.fetch(input, init), now = Date.now, timeoutMs = 15_000,
    sleep = (milliseconds) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
  } = options;
  const supplierIds = new Set<string>(Array.isArray(config.supplierIds) ? config.supplierIds : []);
  if (!Object.hasOwn(environments, environment) || supplierIds.size === 0
    || [...supplierIds].some((id) => typeof id !== 'string' || sourceId(id) !== id)
    || [clientId, clientSecret].some((value) => typeof value !== 'string' || !value.trim() || value.length > 2048)
    || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    throw new WayfairConnectorError('WAYFAIR_CONFIGURATION_INVALID');
  }
  const base = environments[environment];
  const graphqlUrl = new URL('v1/graphql', base).toString();
  // The published schema excludes isCancelled in the sandbox.
  const cancelledField = environment === 'sandbox' ? '' : 'isCancelled';
  const query = `query ReadDropshipOrders($limit: Int32, $hasResponse: Boolean, $fromDate: IsoDateTime, $poNumbers: [String]) {
    getDropshipPurchaseOrders(limit: $limit, hasResponse: $hasResponse, fromDate: $fromDate, poNumbers: $poNumbers, sortOrder: ASC) {
      id poNumber poDate supplierId
      products { partNumber sku name quantity ${cancelledField} }
    }
  }`;
  let verified = false;
  let cachedToken: { value: string; usableUntil: number } | null = null;
  let tokenRequest: Promise<string> | null = null;
  let previousGraphqlStart = -Infinity;
  let graphqlQueue = Promise.resolve();

  async function postJson(url: string, payload: object, token?: string) {
    const signal = AbortSignal.timeout(timeoutMs);
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    let response: Response;
    try {
      response = await fetchImpl(url, { method: 'POST', redirect: 'manual', cache: 'no-store', signal, headers, body: JSON.stringify(payload) });
    } catch {
      throw new WayfairConnectorError(signal.aborted ? 'WAYFAIR_TIMEOUT' : 'WAYFAIR_NETWORK_ERROR', true);
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      const { status } = response;
      if (response.type === 'opaqueredirect' || (status >= 300 && status < 400)) {
        throw new WayfairConnectorError('WAYFAIR_REDIRECT_REJECTED', false, status);
      }
      if (status === 401 || status === 403 || (url === tokenUrl && status === 400)) {
        throw new WayfairConnectorError('WAYFAIR_AUTH_FAILED', false, status);
      }
      if (status === 429) throw new WayfairConnectorError('WAYFAIR_RATE_LIMITED', true, status);
      throw new WayfairConnectorError('WAYFAIR_HTTP_ERROR', status === 408 || status >= 500, status);
    }
    const result: unknown = await response.json().catch(() => null);
    if (signal.aborted) throw new WayfairConnectorError('WAYFAIR_TIMEOUT', true);
    const body = asRecord(result);
    if (!body) throw new WayfairConnectorError('WAYFAIR_INVALID_RESPONSE');
    return body;
  }

  async function renewToken() {
    const response = await postJson(tokenUrl, { grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret, audience: base });
    const token = response.access_token;
    const seconds = response.expires_in;
    if (typeof token !== 'string' || token.length > 20_000 || !/^[!-~]+$/u.test(token)
      || typeof seconds !== 'number' || !Number.isSafeInteger(seconds) || seconds <= 0 || seconds > 86_400
      || typeof response.token_type !== 'string' || response.token_type.toLowerCase() !== 'bearer') {
      throw new WayfairConnectorError('WAYFAIR_INVALID_RESPONSE');
    }
    const lifetime = seconds * 1000;
    cachedToken = { value: token, usableUntil: now() + lifetime - Math.min(60_000, lifetime / 10) };
    return token;
  }

  async function accessToken() {
    if (cachedToken && cachedToken.usableUntil > now()) return cachedToken.value;
    tokenRequest ??= renewToken().finally(() => { tokenRequest = null; });
    return tokenRequest;
  }

  function queryOrders(payload: object, token: string) {
    const result = graphqlQueue.then(async () => {
      const delay = previousGraphqlStart + wayfairDropshipMinimumIntervalMs - now();
      if (delay > 0) await sleep(delay);
      previousGraphqlStart = now();
      return postJson(graphqlUrl, payload, token);
    });
    graphqlQueue = result.then(() => {}, () => {});
    return result;
  }

  async function loadOrders(input: WayfairDropshipQuery) {
    const { hasResponse, fromDate, poNumbers } = input;
    const normalizedFrom = typeof fromDate === 'string' && fromDate.length <= 45 ? normalizeTime(fromDate) : null;
    if (typeof hasResponse !== 'boolean' || (fromDate !== undefined && (!normalizedFrom || Date.parse(normalizedFrom) > now()))
      || (poNumbers !== undefined && (!Array.isArray(poNumbers) || poNumbers.length === 0 || poNumbers.length > wayfairDropshipOrderLimit
        || !poNumbers.every(validPoNumber) || new Set(poNumbers).size !== poNumbers.length))) {
      throw new WayfairConnectorError('WAYFAIR_QUERY_INVALID');
    }
    const payload = { query, variables: { limit: wayfairDropshipOrderLimit, hasResponse,
      ...(normalizedFrom ? { fromDate: normalizedFrom.replace('T', ' ').replace('Z', '000 +00:00') } : {}),
      ...(poNumbers ? { poNumbers } : {}),
    } };
    const token = await accessToken();
    const response = await queryOrders(payload, token).catch(async (error: unknown) => {
      if (!(error instanceof WayfairConnectorError) || error.httpStatus !== 401) throw error;
      if (cachedToken?.value === token) cachedToken = null;
      return queryOrders(payload, await accessToken());
    });
    if (response.errors != null && (!Array.isArray(response.errors) || response.errors.length > 0)) {
      throw new WayfairConnectorError('WAYFAIR_QUERY_REJECTED');
    }
    const rows = asRecord(response.data)?.getDropshipPurchaseOrders;
    if (!Array.isArray(rows) || rows.length > wayfairDropshipOrderLimit) throw new WayfairConnectorError('WAYFAIR_INVALID_RESPONSE');
    const orders = rows.map((row) => mapOrder(row, supplierIds));
    if (new Set(orders.map((order) => order.id)).size !== orders.length
      || new Set(orders.map((order) => order.poNumber)).size !== orders.length
      || (poNumbers && orders.some((order) => !poNumbers.includes(order.poNumber)))) {
      throw new WayfairConnectorError('WAYFAIR_INVALID_RESPONSE');
    }
    return { orders, hasResponse, possiblyTruncated: !poNumbers && orders.length === wayfairDropshipOrderLimit };
  }

  async function verifyOrder(poNumber: string, hasResponse: boolean) {
    verified = false;
    const { orders } = await loadOrders({ poNumbers: [poNumber], hasResponse });
    if (orders.length !== 1) throw new WayfairConnectorError('WAYFAIR_STORE_IDENTITY_UNVERIFIED');
    verified = true;
  }

  function readOrders(input: WayfairDropshipQuery) {
    if (!verified) return Promise.reject(new WayfairConnectorError('WAYFAIR_STORE_IDENTITY_UNVERIFIED'));
    return loadOrders(input);
  }

  return { verifyOrder, readOrders };
}
