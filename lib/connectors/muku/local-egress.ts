import {
  MukuDashboardConfig,
  MUKU_DASHBOARD_DEFAULT_BASE_URL,
} from './config';
import { MukuConnectorError } from './errors';
import { isMukuDatasetId } from './types';

export const MUKU_EXPORT_PATH = '/api/integrations/erp/v1/export';
export const MUKU_LOCAL_EGRESS_UPSTREAM_TIMEOUT_MILLISECONDS = 35_000;
export const MUKU_LOCAL_EGRESS_CLIENT_CONNECT_TIMEOUT_MILLISECONDS = 40_000;
export const MUKU_EXPORT_QUERY_KEYS = [
  'dataset',
  'from',
  'to',
  'page',
  'pageSize',
  'platform',
  'store',
  'sku',
  'warehouse',
  'status',
  'businessStatus',
  'sourceId',
] as const;

const MUKU_UPSTREAM_ORIGIN = new URL(MUKU_DASHBOARD_DEFAULT_BASE_URL).origin;
const ALLOWED_QUERY_KEYS = new Set<string>(MUKU_EXPORT_QUERY_KEYS);
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

type FetchLike = typeof fetch;

export function createMukuLocalEgressFetch(
  config: MukuDashboardConfig,
  fetchImpl: FetchLike = globalThis.fetch,
): FetchLike {
  if (!config.localEgressUrl) return fetchImpl;
  const localEgressUrl = new URL(config.localEgressUrl);

  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const upstreamUrl = new URL(request.url);
    validateMukuExportUrl(upstreamUrl);
    if (request.method !== 'GET') throw rejectedLocalRequest('method_not_allowed');

    const authorization = request.headers.get('authorization');
    if (!isSafeMukuBearerValue(authorization)) {
      throw rejectedLocalRequest('authorization_missing');
    }

    const destination = new URL(localEgressUrl);
    destination.search = upstreamUrl.search;
    return fetchImpl(destination, {
      method: 'GET',
      redirect: 'manual',
      signal: request.signal,
      headers: {
        Accept: 'application/json',
        Authorization: authorization,
        'Cache-Control': 'no-store',
      },
    });
  }) as FetchLike;
}

export function validateMukuExportUrl(url: URL) {
  if (url.origin !== MUKU_UPSTREAM_ORIGIN || url.pathname !== MUKU_EXPORT_PATH) {
    throw rejectedLocalRequest('upstream_not_allowed');
  }

  const seen = new Set<string>();
  for (const [key, value] of url.searchParams) {
    if (!ALLOWED_QUERY_KEYS.has(key) || seen.has(key)) {
      throw rejectedLocalRequest('query_not_allowed');
    }
    seen.add(key);
    if (!value || value.length > 128 || CONTROL_CHARACTERS.test(value)) {
      throw rejectedLocalRequest('query_value_invalid');
    }
  }

  const dataset = url.searchParams.get('dataset');
  if (!dataset || !isMukuDatasetId(dataset)) {
    throw rejectedLocalRequest('dataset_not_allowed');
  }
  validateDate(url.searchParams.get('from'));
  validateDate(url.searchParams.get('to'));
  validateInteger(url.searchParams.get('page'), 1, 100_000);
  validateInteger(url.searchParams.get('pageSize'), 1, 500);
}

export function isSafeMukuBearerValue(value: string | null | undefined): value is string {
  return typeof value === 'string'
    && value.length <= 4_096
    && /^Bearer \S+$/.test(value);
}

function validateDate(value: string | null) {
  if (value !== null && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw rejectedLocalRequest('date_invalid');
  }
}

function validateInteger(value: string | null, minimum: number, maximum: number) {
  if (value === null) return;
  if (!/^\d+$/.test(value)) throw rejectedLocalRequest('integer_invalid');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw rejectedLocalRequest('integer_out_of_range');
  }
}

function rejectedLocalRequest(diagnostic: string) {
  return new MukuConnectorError(
    'MUKU_LOCAL_EGRESS_REQUEST_REJECTED',
    'MUKU 本地开发出口拒绝了非白名单请求',
    false,
    null,
    diagnostic,
  );
}
