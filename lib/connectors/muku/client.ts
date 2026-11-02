import { sha256Hex, stableJson } from '../stable';
import { MukuDashboardConfig } from './config';
import { MukuConnectorError } from './errors';
import {
  MUKU_EXPORT_PATH,
  MUKU_LOCAL_EGRESS_CLIENT_CONNECT_TIMEOUT_MILLISECONDS,
} from './local-egress';
import {
  MUKU_DATASETS,
  isMukuBusinessDatasetId,
  isMukuDatasetId,
  type MukuBusinessDatasetId,
  type MukuDataPage,
  type MukuDatasetExport,
  type MukuExportFilters,
  type MukuManifestDataset,
  type MukuManifestResponse,
  type MukuPageRequest,
  type MukuPagination,
  type MukuRecord,
  type MukuResponseMetadata,
} from './types';

type FetchLike = typeof fetch;
type Sleep = (milliseconds: number) => Promise<void>;

type ClientOptions = {
  connectTimeoutMilliseconds?: number;
  readTimeoutMilliseconds?: number;
  maxAttempts?: number;
  maxPages?: number;
};

type UnknownResponse = Record<string, unknown>;

const defaultFetch: FetchLike = (input, init) => globalThis.fetch(input, init);

export class MukuDashboardClient {
  readonly #config: MukuDashboardConfig;
  readonly #fetchImpl: FetchLike;
  readonly #sleep: Sleep;
  readonly #random: () => number;
  readonly #connectTimeoutMilliseconds: number;
  readonly #readTimeoutMilliseconds: number;
  readonly #maxAttempts: number;
  readonly #maxPages: number;

  constructor(
    config: MukuDashboardConfig,
    fetchImpl: FetchLike = defaultFetch,
    sleep: Sleep = defaultSleep,
    random: () => number = Math.random,
    options: ClientOptions = {},
  ) {
    this.#config = config;
    this.#fetchImpl = fetchImpl;
    this.#sleep = sleep;
    this.#random = random;
    this.#connectTimeoutMilliseconds = positiveInteger(
      options.connectTimeoutMilliseconds,
      config.localEgressUrl ? MUKU_LOCAL_EGRESS_CLIENT_CONNECT_TIMEOUT_MILLISECONDS : 10_000,
    );
    this.#readTimeoutMilliseconds = positiveInteger(options.readTimeoutMilliseconds, 30_000);
    this.#maxAttempts = boundedInteger(options.maxAttempts, 4, 1, 4);
    this.#maxPages = boundedInteger(options.maxPages, 1_000, 1, 1_000);
  }

  async verifyManifest(): Promise<MukuManifestResponse> {
    const raw = await this.request('manifest', {});
    const metadata = parseMetadata(raw, 'manifest');
    if (!Array.isArray(raw.datasets) || !raw.datasets.every(isRecord)) {
      throw invalidResponse('manifest_datasets_missing');
    }
    const datasets = raw.datasets as MukuManifestDataset[];
    const datasetIds = datasets
      .map((dataset) => dataset.id ?? dataset.dataset ?? dataset.name)
      .filter((value): value is string => typeof value === 'string')
      .filter(isMukuDatasetId);
    const uniqueIds = [...new Set(datasetIds)];
    if (MUKU_DATASETS.some((dataset) => !uniqueIds.includes(dataset))) {
      throw new MukuConnectorError(
        'MUKU_MANIFEST_INCOMPLETE',
        'MUKU 能力清单缺少 ERP 所需的数据集',
        false,
        null,
        'manifest_incomplete',
      );
    }
    return {
      ...metadata,
      dataset: 'manifest',
      datasets,
      datasetIds: uniqueIds,
    };
  }

  async getPage<T extends MukuRecord = MukuRecord>(
    dataset: MukuBusinessDatasetId,
    filters: MukuPageRequest = {},
  ): Promise<MukuDataPage<T>> {
    if (!isMukuBusinessDatasetId(dataset)) throw invalidDataset();
    const page = boundedInteger(filters.page, 1, 1, 100_000);
    const pageSize = boundedInteger(filters.pageSize, 500, 1, 500);
    const raw = await this.request(dataset, { ...filters, page, pageSize });
    const metadata = parseMetadata(raw, dataset);
    const pagination = parsePagination(raw.pagination, page, pageSize);
    if (!Array.isArray(raw.data) || !raw.data.every(isRecord)) {
      throw invalidResponse('data_rows_invalid');
    }
    if (raw.data.length > pageSize) throw invalidPagination('page_size_exceeded');
    return {
      ...metadata,
      dataset,
      pagination,
      data: raw.data as T[],
    };
  }

  async getAllPages<T extends MukuRecord = MukuRecord>(
    dataset: MukuBusinessDatasetId,
    filters: MukuExportFilters = {},
    options: { pageSize?: number; maxPages?: number } = {},
  ): Promise<MukuDatasetExport<T>> {
    if (!isMukuBusinessDatasetId(dataset)) throw invalidDataset();
    const pageSize = boundedInteger(options.pageSize, 500, 1, 500);
    const maxPages = boundedInteger(options.maxPages, this.#maxPages, 1, this.#maxPages);
    const rows: T[] = [];
    const pageFingerprints = new Set<string>();
    let firstPage: MukuDataPage<T> | null = null;
    let expectedTotal: number | null = null;
    let expectedTotalPages: number | null = null;
    let page = 1;

    while (page <= maxPages) {
      const current = await this.getPage<T>(dataset, { ...filters, page, pageSize });
      const fingerprint = await sha256Hex(stableJson(current.data));
      if (pageFingerprints.has(fingerprint)) throw paginationLoop();
      pageFingerprints.add(fingerprint);

      if (!firstPage) {
        firstPage = current;
        expectedTotal = current.pagination.total;
        expectedTotalPages = current.pagination.totalPages;
      } else if (
        current.pagination.total !== expectedTotal
        || current.pagination.totalPages !== expectedTotalPages
      ) {
        throw invalidPagination('pagination_totals_changed');
      }
      rows.push(...current.data);
      if (!current.pagination.hasNext) {
        if (rows.length !== current.pagination.total) {
          throw invalidPagination('record_count_mismatch');
        }
        return {
          ok: true,
          apiVersion: firstPage.apiVersion,
          dataset,
          generatedAt: firstPage.generatedAt,
          source: firstPage.source,
          grain: firstPage.grain,
          businessTimezone: firstPage.businessTimezone,
          refreshCadence: firstPage.refreshCadence,
          zeroSemantics: firstPage.zeroSemantics,
          filters: firstPage.filters,
          data: rows,
          pageCount: page,
          pageSize,
          total: current.pagination.total,
        };
      }
      page += 1;
    }
    throw new MukuConnectorError(
      'MUKU_PAGE_LIMIT_EXCEEDED',
      'MUKU 数据分页超过安全上限，已停止读取',
      false,
      null,
      'page_limit_exceeded',
    );
  }

  private async request(dataset: string, parameters: MukuPageRequest) {
    const url = this.buildUrl(dataset, parameters);
    for (let attempt = 0; attempt < this.#maxAttempts; attempt += 1) {
      try {
        return await this.performAttempt(url);
      } catch (error) {
        if (!(error instanceof MukuConnectorError)) {
          throw networkError('unknown_network_failure');
        }
        if (!error.retryable || attempt + 1 >= this.#maxAttempts) throw error;
        await this.#sleep(
          error.retryAfterMilliseconds ?? this.retryDelay(attempt),
        );
      }
    }
    throw networkError('retry_exhausted');
  }

  private async performAttempt(url: URL): Promise<UnknownResponse> {
    const controller = new AbortController();
    let phase: 'connect' | 'read' = 'connect';
    let timedOut = false;
    let timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.#connectTimeoutMilliseconds);
    let response: Response;
    const fetchImpl = this.#fetchImpl;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          Authorization: this.#config.authorizationValue(),
        },
      });
    } catch {
      clearTimeout(timer);
      if (timedOut) throw timeoutError(phase);
      throw networkError('connection_failure');
    }
    clearTimeout(timer);
    const requestId = response.headers.get('x-request-id') ?? response.headers.get('cf-ray');
    if (response.status >= 300 && response.status < 400) {
      throw new MukuConnectorError(
        'MUKU_REDIRECT_REJECTED',
        'MUKU 接口返回非预期重定向，已停止请求以保护只读密钥',
        false,
        response.status,
        'redirect_rejected',
        requestId,
      );
    }
    if (!response.ok) {
      const retryable = response.status === 429 || response.status >= 500;
      const code = response.status === 401 || response.status === 403
        ? 'MUKU_AUTH_FAILED'
        : response.status === 429
          ? 'MUKU_RATE_LIMITED'
          : 'MUKU_HTTP_ERROR';
      throw new MukuConnectorError(
        code,
        response.status === 401 || response.status === 403
          ? 'MUKU 只读授权无效或权限不足'
          : response.status === 429
            ? 'MUKU 接口请求过于频繁'
            : `MUKU 接口返回 HTTP ${response.status}`,
        retryable,
        response.status,
        retryable ? 'upstream_retryable' : 'upstream_rejected',
        requestId,
        parseRetryAfter(response.headers.get('Retry-After')),
      );
    }
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
    if (!contentType.includes('application/json')) {
      throw invalidResponse('content_type_invalid', response.status, requestId);
    }

    phase = 'read';
    timedOut = false;
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.#readTimeoutMilliseconds);
    let text: string;
    try {
      text = await response.text();
    } catch {
      clearTimeout(timer);
      if (timedOut) throw timeoutError(phase, response.status, requestId);
      throw networkError('response_read_failure', response.status, requestId);
    }
    clearTimeout(timer);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw invalidResponse('json_invalid', response.status, requestId);
    }
    if (!isRecord(parsed)) throw invalidResponse('response_not_object', response.status, requestId);
    return parsed;
  }

  private buildUrl(dataset: string, parameters: MukuPageRequest) {
    const url = new URL(MUKU_EXPORT_PATH, `${this.#config.baseUrl}/`);
    url.searchParams.set('dataset', dataset);
    for (const [key, value] of Object.entries(parameters)) {
      if (value === undefined) continue;
      if (typeof value === 'number') {
        url.searchParams.set(key, String(value));
        continue;
      }
      const normalized = value.trim();
      if (!normalized) continue;
      if (normalized.length > 128) {
        throw new MukuConnectorError(
          'MUKU_FILTER_INVALID',
          'MUKU 查询条件超过允许长度',
          false,
          null,
          'filter_too_long',
        );
      }
      if ((key === 'from' || key === 'to') && !/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
        throw new MukuConnectorError(
          'MUKU_FILTER_INVALID',
          'MUKU 日期条件必须使用 YYYY-MM-DD',
          false,
          null,
          'date_filter_invalid',
        );
      }
      url.searchParams.set(key, normalized);
    }
    return url;
  }

  private retryDelay(attempt: number) {
    const ceiling = Math.min(30_000, 500 * (2 ** attempt));
    return Math.floor(this.#random() * ceiling);
  }
}

function parseMetadata(raw: UnknownResponse, expectedDataset: string): MukuResponseMetadata {
  if (raw.ok !== true) throw invalidResponse('ok_not_true');
  if (raw.apiVersion !== 'v1') {
    throw new MukuConnectorError(
      'MUKU_VERSION_MISMATCH',
      'MUKU 接口版本与 ERP 支持版本不一致',
      false,
      null,
      'api_version_mismatch',
    );
  }
  if (raw.dataset !== expectedDataset) {
    throw new MukuConnectorError(
      'MUKU_DATASET_MISMATCH',
      'MUKU 返回的数据集与请求不一致',
      false,
      null,
      'dataset_mismatch',
    );
  }
  if (typeof raw.generatedAt !== 'string' || Number.isNaN(Date.parse(raw.generatedAt))) {
    throw invalidResponse('generated_at_invalid');
  }
  return {
    ok: true,
    apiVersion: 'v1',
    generatedAt: raw.generatedAt,
    source: optionalString(raw.source),
    grain: optionalString(raw.grain),
    businessTimezone: optionalString(raw.businessTimezone),
    refreshCadence: optionalString(raw.refreshCadence),
    zeroSemantics: optionalString(raw.zeroSemantics),
    filters: isRecord(raw.filters) ? raw.filters : {},
  };
}

function parsePagination(value: unknown, expectedPage: number, expectedPageSize: number): MukuPagination {
  if (!isRecord(value)) throw invalidPagination('pagination_missing');
  const { page, pageSize, total, totalPages, hasNext } = value;
  if (
    !Number.isInteger(page)
    || !Number.isInteger(pageSize)
    || !Number.isInteger(total)
    || !Number.isInteger(totalPages)
    || typeof hasNext !== 'boolean'
  ) throw invalidPagination('pagination_types_invalid');
  const parsed = {
    page: page as number,
    pageSize: pageSize as number,
    total: total as number,
    totalPages: totalPages as number,
    hasNext,
  };
  if (
    parsed.page !== expectedPage
    || parsed.pageSize !== expectedPageSize
    || parsed.pageSize < 1
    || parsed.pageSize > 500
    || parsed.total < 0
    || parsed.totalPages < 0
  ) throw invalidPagination('pagination_values_invalid');
  if (parsed.hasNext && (parsed.totalPages === 0 || parsed.page >= parsed.totalPages)) {
    throw invalidPagination('has_next_inconsistent');
  }
  if (!parsed.hasNext && parsed.totalPages > 0 && parsed.page < parsed.totalPages) {
    throw invalidPagination('last_page_inconsistent');
  }
  return parsed;
}

function optionalString(value: unknown) {
  return typeof value === 'string' ? value : null;
}

function isRecord(value: unknown): value is MukuRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function invalidDataset() {
  return new MukuConnectorError(
    'MUKU_DATASET_INVALID',
    '不支持的 MUKU 数据集',
    false,
    null,
    'dataset_not_allowed',
  );
}

function invalidResponse(
  diagnostic: string,
  status: number | null = null,
  requestId: string | null = null,
) {
  return new MukuConnectorError(
    'MUKU_INVALID_RESPONSE',
    'MUKU 返回了无效或不完整的数据响应',
    false,
    status,
    diagnostic,
    requestId,
  );
}

function invalidPagination(diagnostic: string) {
  return new MukuConnectorError(
    'MUKU_PAGINATION_INVALID',
    'MUKU 分页信息不一致，已停止读取以保留旧数据',
    false,
    null,
    diagnostic,
  );
}

function paginationLoop() {
  return new MukuConnectorError(
    'MUKU_PAGINATION_LOOP',
    'MUKU 分页返回重复数据，已停止读取以避免重复入库',
    false,
    null,
    'duplicate_page_payload',
  );
}

function networkError(
  diagnostic: string,
  status: number | null = null,
  requestId: string | null = null,
) {
  return new MukuConnectorError(
    'MUKU_NETWORK_ERROR',
    'MUKU 网络请求在有限重试后仍失败',
    true,
    status,
    diagnostic,
    requestId,
  );
}

function timeoutError(
  phase: 'connect' | 'read',
  status: number | null = null,
  requestId: string | null = null,
) {
  return new MukuConnectorError(
    phase === 'connect' ? 'MUKU_CONNECT_TIMEOUT' : 'MUKU_READ_TIMEOUT',
    phase === 'connect' ? 'MUKU 连接超时' : 'MUKU 响应读取超时',
    true,
    status,
    `${phase}_timeout`,
    requestId,
  );
}

function parseRetryAfter(value: string | null) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1_000, 30_000);
  const date = Date.parse(value);
  if (Number.isNaN(date)) return null;
  return Math.min(Math.max(0, date - Date.now()), 30_000);
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < minimum || result > maximum) {
    throw new MukuConnectorError(
      'MUKU_REQUEST_INVALID',
      'MUKU 请求分页参数无效',
      false,
      null,
      'integer_out_of_range',
    );
  }
  return result;
}

function positiveInteger(value: number | undefined, fallback: number) {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result <= 0) {
    throw new MukuConnectorError(
      'MUKU_REQUEST_INVALID',
      'MUKU 客户端超时参数无效',
      false,
      null,
      'timeout_out_of_range',
    );
  }
  return result;
}

function defaultSleep(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
