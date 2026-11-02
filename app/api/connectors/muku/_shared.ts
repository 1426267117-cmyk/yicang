import { env } from 'cloudflare:workers';
import { MukuDashboardClient } from '../../../../lib/connectors/muku/client';
import { resolveMukuConfig } from '../../../../lib/connectors/muku/config';
import {
  MukuConnectorError,
  sanitizedMukuConnectorError,
} from '../../../../lib/connectors/muku/errors';
import { HttpError, jsonError } from '../../../../lib/db';
import { MUKU_SYNC_DATASETS, type MukuSyncDataset } from '../../../../lib/muku-sync-service';

export const NO_STORE_HEADERS = { 'Cache-Control': 'no-store' } as const;

export function createMukuClient() {
  const config = resolveMukuConfig(env as unknown as Record<string, unknown>);
  return new MukuDashboardClient(config);
}

export function mukuErrorResponse(error: unknown) {
  if (error instanceof MukuConnectorError) {
    const safe = sanitizedMukuConnectorError(error);
    const status = error.code === 'MUKU_CONFIG_MISSING' || error.code === 'MUKU_BASE_URL_INVALID'
      ? 503
      : error.status === 401 || error.status === 403
        ? 502
        : error.retryable || error.status === 429 || (error.status !== null && error.status >= 500)
          ? 503
          : 422;
    return Response.json({ ok: false, ...safe }, { status, headers: NO_STORE_HEADERS });
  }
  const response = jsonError(error);
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'no-store');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function parseMukuDatasets(body: unknown): MukuSyncDataset[] {
  if (body === null || body === undefined) return [...MUKU_SYNC_DATASETS];
  if (!isRecord(body)) {
    throw new HttpError(400, '同步参数必须是 JSON 对象', 'INVALID_MUKU_SYNC_REQUEST');
  }
  if (body.datasets === undefined) return [...MUKU_SYNC_DATASETS];
  if (!Array.isArray(body.datasets) || body.datasets.length === 0) {
    throw new HttpError(400, 'datasets 必须是非空数组', 'INVALID_MUKU_SYNC_REQUEST');
  }
  const datasets = [...new Set(body.datasets)];
  if (datasets.some((dataset) => (
    typeof dataset !== 'string'
    || !(MUKU_SYNC_DATASETS as readonly string[]).includes(dataset)
  ))) {
    throw new HttpError(400, '包含尚未支持的 MUKU 数据集', 'INVALID_MUKU_DATASET');
  }
  return datasets as MukuSyncDataset[];
}

export function parsePagination(url: URL, options: { warehouse?: boolean } = {}) {
  const page = parsePositiveInteger(url.searchParams.get('page'), 1, 1_000_000, 'page');
  const pageSize = parsePositiveInteger(url.searchParams.get('pageSize'), 50, 200, 'pageSize');
  return {
    sku: cleanQueryValue(url.searchParams.get('sku')),
    ...(options.warehouse ? { warehouse: cleanQueryValue(url.searchParams.get('warehouse')) } : {}),
    page,
    pageSize,
  };
}

function parsePositiveInteger(raw: string | null, fallback: number, max: number, field: string) {
  if (raw === null || raw === '') return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new HttpError(400, `${field} 必须是正整数`, 'INVALID_PAGINATION');
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new HttpError(400, `${field} 超出允许范围`, 'INVALID_PAGINATION');
  }
  return value;
}

function cleanQueryValue(value: string | null) {
  const cleaned = value?.trim();
  return cleaned ? cleaned.slice(0, 200) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
