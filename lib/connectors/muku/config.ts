import { MukuConnectorError } from './errors';

export const MUKU_DASHBOARD_DEFAULT_BASE_URL =
  'https://muku-data-command-team.lik048289721736.chatgpt.site';
export const MUKU_LOCAL_EGRESS_PATH = '/__muku-local-egress/v1/export';

export class MukuDashboardConfig {
  readonly #apiKey: string;
  public readonly localEgressUrl: string | null;

  constructor(
    public readonly baseUrl: string,
    apiKey: string,
    localEgressUrl: string | null = null,
    public readonly credentialRef = 'env:MUKU_DASHBOARD_API_KEY',
  ) {
    this.#apiKey = apiKey;
    this.localEgressUrl = localEgressUrl === null
      ? null
      : normalizeMukuLocalEgressUrl(localEgressUrl, baseUrl);
  }

  authorizationValue() {
    return `Bearer ${this.#apiKey}`;
  }

  toJSON() {
    return {
      baseUrl: this.baseUrl,
      credentialRef: this.credentialRef,
      configured: true,
      localEgressConfigured: this.localEgressUrl !== null,
    };
  }
}

export function resolveMukuConfig(runtimeEnv: Record<string, unknown>) {
  const rawBaseUrl = envString(runtimeEnv, 'MUKU_DASHBOARD_BASE_URL')
    ?? MUKU_DASHBOARD_DEFAULT_BASE_URL;
  const apiKey = envString(runtimeEnv, 'MUKU_DASHBOARD_API_KEY');
  if (!apiKey || apiKey.length < 32) {
    throw new MukuConnectorError(
      'MUKU_CONFIG_MISSING',
      'MUKU 看板只读密钥尚未安全配置',
      false,
      null,
      'api_key_missing',
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(rawBaseUrl);
  } catch {
    throw invalidBaseUrl();
  }
  if (
    parsed.protocol !== 'https:'
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
  ) {
    throw invalidBaseUrl();
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
  const normalizedBaseUrl = parsed.toString().replace(/\/$/, '');
  const localEgressUrl = envString(runtimeEnv, 'MUKU_LOCAL_EGRESS_URL');
  return new MukuDashboardConfig(
    normalizedBaseUrl,
    apiKey,
    localEgressUrl,
  );
}

export function normalizeMukuLocalEgressUrl(
  raw: string,
  normalizedBaseUrl: string,
) {
  let parsed: URL;
  try {
    if (raw !== raw.trim()) throw new Error('surrounding_whitespace');
    parsed = new URL(raw);
  } catch {
    throw invalidLocalEgressUrl();
  }
  const hostname = parsed.hostname.toLowerCase();
  if (
    parsed.protocol !== 'http:'
    || !['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname)
    || parsed.pathname !== MUKU_LOCAL_EGRESS_PATH
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || normalizedBaseUrl !== MUKU_DASHBOARD_DEFAULT_BASE_URL
  ) {
    throw invalidLocalEgressUrl();
  }
  return parsed.toString();
}

function envString(runtimeEnv: Record<string, unknown>, key: string) {
  const value = runtimeEnv[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function invalidBaseUrl() {
  return new MukuConnectorError(
    'MUKU_BASE_URL_INVALID',
    'MUKU 看板地址必须是安全的 HTTPS 地址',
    false,
    null,
    'invalid_base_url',
  );
}

function invalidLocalEgressUrl() {
  return new MukuConnectorError(
    'MUKU_LOCAL_EGRESS_INVALID',
    'MUKU 本地开发出口必须使用固定的本机 HTTP 地址',
    false,
    null,
    'invalid_local_egress_url',
  );
}
