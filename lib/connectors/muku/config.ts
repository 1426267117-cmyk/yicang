import { MukuConnectorError } from './errors';

export const MUKU_DASHBOARD_DEFAULT_BASE_URL =
  'https://muku-data-command-team.lik048289721736.chatgpt.site';

export class MukuDashboardConfig {
  readonly #apiKey: string;

  constructor(
    public readonly baseUrl: string,
    apiKey: string,
    public readonly credentialRef = 'env:MUKU_DASHBOARD_API_KEY',
  ) {
    this.#apiKey = apiKey;
  }

  authorizationValue() {
    return `Bearer ${this.#apiKey}`;
  }

  toJSON() {
    return {
      baseUrl: this.baseUrl,
      credentialRef: this.credentialRef,
      configured: true,
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
  return new MukuDashboardConfig(parsed.toString().replace(/\/$/, ''), apiKey);
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
