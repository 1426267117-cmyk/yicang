import { SHOPIFY_API_VERSION, type ShopifyCredentialConfig } from './config';
import { ShopifyConnectorError } from './errors';

type FetchLike = typeof fetch;

type ShopifyGraphqlEnvelope<T> = {
  data?: T;
  errors?: Array<{
    message?: string;
    extensions?: { code?: string };
  }>;
};

export class ShopifyAdminClient {
  private tokenPromise: Promise<string> | null = null;

  constructor(
    private readonly config: ShopifyCredentialConfig,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly sleep: (milliseconds: number) => Promise<void> = defaultSleep,
    private readonly random: () => number = Math.random,
  ) {}

  async graphql<T>(query: string, variables: Record<string, unknown> = {}) {
    const token = await this.accessToken();
    const endpoint = `https://${this.config.domain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetchImpl(endpoint, {
          method: 'POST',
          redirect: 'error',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'X-Shopify-Access-Token': token,
          },
          body: JSON.stringify({ query, variables }),
        });
      } catch {
        if (attempt < 4) {
          await this.sleep(this.retryDelay(attempt));
          continue;
        }
        throw new ShopifyConnectorError(
          'SHOPIFY_NETWORK_ERROR',
          'Shopify 网络请求在有限重试后仍失败',
          true,
        );
      }

      if (!response.ok) {
        const retryable = response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500;
        if (retryable && attempt < 4) {
          await this.sleep(this.retryDelay(attempt, response.headers.get('Retry-After')));
          continue;
        }
        const code = response.status === 401 || response.status === 403
          ? 'SHOPIFY_AUTH_FAILED'
          : response.status === 429
            ? 'SHOPIFY_RATE_LIMITED'
            : 'SHOPIFY_HTTP_ERROR';
        throw new ShopifyConnectorError(
          code,
          response.status === 401 || response.status === 403
            ? 'Shopify 授权无效或权限不足'
            : `Shopify 返回 HTTP ${response.status}`,
          retryable,
          response.status,
        );
      }

      let envelope: ShopifyGraphqlEnvelope<T>;
      try {
        envelope = await response.json() as ShopifyGraphqlEnvelope<T>;
      } catch {
        throw new ShopifyConnectorError('SHOPIFY_INVALID_RESPONSE', 'Shopify 返回了无效响应');
      }

      if (envelope.errors?.length) {
        const codes = envelope.errors.map((error) => error.extensions?.code).filter(Boolean);
        if (codes.includes('THROTTLED') && attempt < 4) {
          await this.sleep(this.retryDelay(attempt));
          continue;
        }
        if (codes.includes('ACCESS_DENIED')) {
          throw new ShopifyConnectorError('SHOPIFY_ACCESS_DENIED', 'Shopify 当前授权缺少所需的只读权限');
        }
        throw new ShopifyConnectorError('SHOPIFY_GRAPHQL_ERROR', 'Shopify GraphQL 查询失败，详细信息已脱敏');
      }
      if (!envelope.data) {
        throw new ShopifyConnectorError('SHOPIFY_INVALID_RESPONSE', 'Shopify 响应缺少 data');
      }
      return envelope.data;
    }
    throw new ShopifyConnectorError('SHOPIFY_RATE_LIMITED', 'Shopify 限流重试次数已用完', true, 429);
  }

  private async accessToken() {
    if (!this.tokenPromise) this.tokenPromise = this.acquireAccessToken();
    return this.tokenPromise;
  }

  private async acquireAccessToken() {
    if (this.config.adminAccessToken) return this.config.adminAccessToken;
    if (!this.config.clientId || !this.config.clientSecret) {
      throw new ShopifyConnectorError(
        'SHOPIFY_CREDENTIALS_MISSING',
        `${this.config.displayName} 缺少 ERP 独立 Shopify 只读凭证`,
      );
    }

    const endpoint = `https://${this.config.domain}/admin/oauth/access_token`;
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
    });
    let response: Response;
    try {
      response = await this.fetchImpl(endpoint, {
        method: 'POST',
        redirect: 'error',
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
    } catch {
      throw new ShopifyConnectorError('SHOPIFY_AUTH_NETWORK_ERROR', 'Shopify 授权请求失败', true);
    }
    if (!response.ok) {
      throw new ShopifyConnectorError(
        'SHOPIFY_AUTH_FAILED',
        'Shopify 客户端凭证授权失败',
        response.status >= 500,
        response.status,
      );
    }
    const result = await response.json().catch(() => null) as { access_token?: unknown } | null;
    if (!result || typeof result.access_token !== 'string' || !result.access_token) {
      throw new ShopifyConnectorError('SHOPIFY_AUTH_INVALID_RESPONSE', 'Shopify 授权响应缺少访问令牌');
    }
    return result.access_token;
  }

  private retryDelay(attempt: number, retryAfter: string | null = null) {
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 30_000);
    }
    const ceiling = Math.min(30_000, 500 * (2 ** attempt));
    return Math.floor(this.random() * ceiling);
  }
}

function defaultSleep(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}
