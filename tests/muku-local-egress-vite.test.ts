import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ViteDevServer } from 'vite';
import {
  MUKU_DASHBOARD_DEFAULT_BASE_URL,
  MUKU_LOCAL_EGRESS_PATH,
} from '../lib/connectors/muku/config';
import { MUKU_EXPORT_PATH } from '../lib/connectors/muku/local-egress';
import { mukuLocalEgressPlugin } from '../lib/connectors/muku/local-egress-vite';

const testAuthorization = 'Bearer test-muku-read-only-key-with-more-than-32-characters';

type Middleware = (
  request: IncomingMessage,
  response: ServerResponse,
  next: () => void,
) => void;

describe('MUKU Vite 本地开发出口', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('仅在 serve 模式注册并将白名单 GET 转发到固定 MUKU 出口', async () => {
    const upstreamFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.origin).toBe(new URL(MUKU_DASHBOARD_DEFAULT_BASE_URL).origin);
      expect(url.pathname).toBe(MUKU_EXPORT_PATH);
      expect(url.search).toBe('?dataset=inventory&page=1&pageSize=500');
      expect(init?.method).toBe('GET');
      expect(init?.redirect).toBe('manual');
      const headers = new Headers(init?.headers);
      expect([...headers.keys()].sort()).toEqual([
        'accept',
        'authorization',
        'cache-control',
      ]);
      expect(headers.get('authorization')).toBe(testAuthorization);
      return new Response(JSON.stringify({ ok: true, marker: 'proxied' }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'X-Request-Id': 'safe-request-id',
        },
      });
    }) as typeof fetch;
    vi.stubGlobal('fetch', upstreamFetch);

    await withDevServer(async (port, plugin) => {
      expect(plugin.apply).toBe('serve');
      const result = await localRequest(port, {
        path: `${MUKU_LOCAL_EGRESS_PATH}?dataset=inventory&page=1&pageSize=500`,
        headers: { Authorization: testAuthorization },
      });

      expect(result.status).toBe(200);
      expect(result.headers['cache-control']).toBe('no-store');
      expect(result.headers['x-content-type-options']).toBe('nosniff');
      expect(result.headers['x-request-id']).toBe('safe-request-id');
      expect(JSON.parse(result.body)).toEqual({ ok: true, marker: 'proxied' });
    });
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
  });

  it('拒绝非本机 Host、写方法和非白名单参数', async () => {
    const upstreamFetch = vi.fn() as unknown as typeof fetch;
    vi.stubGlobal('fetch', upstreamFetch);

    await withDevServer(async (port) => {
      const wrongHost = await localRequest(port, {
        path: `${MUKU_LOCAL_EGRESS_PATH}?dataset=inventory`,
        headers: { Authorization: testAuthorization, Host: 'example.invalid' },
      });
      const writeRequest = await localRequest(port, {
        method: 'POST',
        path: `${MUKU_LOCAL_EGRESS_PATH}?dataset=inventory`,
        headers: { Authorization: testAuthorization },
      });
      const unsafeQuery = await localRequest(port, {
        path: `${MUKU_LOCAL_EGRESS_PATH}?dataset=inventory&target=unsafe`,
        headers: { Authorization: testAuthorization },
      });

      expect(wrongHost.status).toBe(403);
      expect(writeRequest.status).toBe(405);
      expect(writeRequest.headers.allow).toBe('GET');
      expect(unsafeQuery.status).toBe(400);
      for (const result of [wrongHost, writeRequest, unsafeQuery]) {
        expect(result.headers['cache-control']).toBe('no-store');
      }
    });
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  it('拒绝上游重定向且不向本地调用方透传 Location', async () => {
    const upstreamFetch = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { Location: 'https://example.invalid/collect' },
    })) as typeof fetch;
    vi.stubGlobal('fetch', upstreamFetch);

    await withDevServer(async (port) => {
      const result = await localRequest(port, {
        path: `${MUKU_LOCAL_EGRESS_PATH}?dataset=manifest`,
        headers: { Authorization: testAuthorization },
      });

      expect(result.status).toBe(302);
      expect(result.headers.location).toBeUndefined();
      expect(result.headers['cache-control']).toBe('no-store');
      expect(JSON.parse(result.body)).toEqual({
        ok: false,
        code: 'MUKU_LOCAL_EGRESS_REDIRECT_REJECTED',
      });
    });
  });

  it('拒绝非 JSON 和超过 8 MiB 的响应', async () => {
    const upstreamFetch = vi.fn()
      .mockResolvedValueOnce(new Response('<html>blocked</html>', {
        status: 403,
        headers: { 'Content-Type': 'text/html' },
      }))
      .mockResolvedValueOnce(new Response('{}', {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String((8 * 1024 * 1024) + 1),
        },
      })) as typeof fetch;
    vi.stubGlobal('fetch', upstreamFetch);

    await withDevServer(async (port) => {
      const nonJson = await localRequest(port, {
        path: `${MUKU_LOCAL_EGRESS_PATH}?dataset=manifest`,
        headers: { Authorization: testAuthorization },
      });
      const tooLarge = await localRequest(port, {
        path: `${MUKU_LOCAL_EGRESS_PATH}?dataset=manifest`,
        headers: { Authorization: testAuthorization },
      });

      expect(nonJson.status).toBe(502);
      expect(JSON.parse(nonJson.body).code).toBe('MUKU_LOCAL_EGRESS_NON_JSON_RESPONSE');
      expect(tooLarge.status).toBe(413);
      expect(JSON.parse(tooLarge.body).code).toBe('MUKU_LOCAL_EGRESS_RESPONSE_TOO_LARGE');
    });
    expect(upstreamFetch).toHaveBeenCalledTimes(2);
  });
});

async function withDevServer(
  assertion: (port: number, plugin: ReturnType<typeof mukuLocalEgressPlugin>) => Promise<void>,
) {
  const plugin = mukuLocalEgressPlugin();
  let middleware: Middleware | null = null;
  const configureServer = plugin.configureServer as (server: ViteDevServer) => void;
  configureServer({
    middlewares: {
      use(handler: Middleware) {
        middleware = handler;
      },
    },
  } as unknown as ViteDevServer);
  if (!middleware) throw new Error('MUKU local egress middleware was not registered');

  const handler: Middleware = middleware;
  const server = createServer((request, response) => {
    handler(request, response, () => {
      response.statusCode = 404;
      response.end();
    });
  });
  await listen(server);
  try {
    const address = server.address() as AddressInfo;
    await assertion(address.port, plugin);
  } finally {
    await close(server);
  }
}

function listen(server: Server) {
  return new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function close(server: Server) {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function localRequest(
  port: number,
  options: {
    method?: string;
    path: string;
    headers?: Record<string, string>;
  },
) {
  return new Promise<{
    status: number;
    headers: IncomingHttpHeaders;
    body: string;
  }>((resolve, reject) => {
    const request = httpRequest({
      hostname: '127.0.0.1',
      port,
      method: options.method ?? 'GET',
      path: options.path,
      headers: options.headers,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    request.once('error', reject);
    request.end();
  });
}
