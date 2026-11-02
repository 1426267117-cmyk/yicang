import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import {
  MUKU_DASHBOARD_DEFAULT_BASE_URL,
  MUKU_LOCAL_EGRESS_PATH,
} from './config';
import {
  MUKU_EXPORT_PATH,
  MUKU_LOCAL_EGRESS_UPSTREAM_TIMEOUT_MILLISECONDS,
  isSafeMukuBearerValue,
  validateMukuExportUrl,
} from './local-egress';

const RESPONSE_LIMIT_BYTES = 8 * 1024 * 1024;

export function mukuLocalEgressPlugin(): Plugin {
  return {
    name: 'muku-local-egress',
    apply: 'serve',
    enforce: 'pre',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const requestUrl = safeRequestUrl(request.url);
        if (!requestUrl || requestUrl.pathname !== MUKU_LOCAL_EGRESS_PATH) {
          next();
          return;
        }
        void handleMukuLocalEgress(request, response, requestUrl);
      });
    },
  };
}

async function handleMukuLocalEgress(
  request: IncomingMessage,
  response: ServerResponse,
  localUrl: URL,
) {
  setNoStoreHeaders(response);
  if (
    !isLoopbackAddress(request.socket.remoteAddress)
    || !isLoopbackHost(request.headers.host)
  ) {
    writeJsonError(response, 403, 'MUKU_LOCAL_EGRESS_LOOPBACK_REQUIRED');
    return;
  }
  if (request.method !== 'GET') {
    response.setHeader('Allow', 'GET');
    writeJsonError(response, 405, 'MUKU_LOCAL_EGRESS_METHOD_NOT_ALLOWED');
    return;
  }

  const authorization = request.headers.authorization;
  if (!isSafeMukuBearerValue(authorization)) {
    writeJsonError(response, 401, 'MUKU_LOCAL_EGRESS_AUTH_REQUIRED');
    return;
  }

  const upstreamUrl = new URL(MUKU_EXPORT_PATH, MUKU_DASHBOARD_DEFAULT_BASE_URL);
  upstreamUrl.search = localUrl.search;
  try {
    validateMukuExportUrl(upstreamUrl);
  } catch {
    writeJsonError(response, 400, 'MUKU_LOCAL_EGRESS_QUERY_REJECTED');
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    MUKU_LOCAL_EGRESS_UPSTREAM_TIMEOUT_MILLISECONDS,
  );
  const abort = () => controller.abort();
  request.once('aborted', abort);
  response.once('close', abort);
  try {
    const upstream = await fetch(upstreamUrl, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        Authorization: authorization,
        'Cache-Control': 'no-store',
      },
    });

    if (upstream.status >= 300 && upstream.status < 400) {
      writeJsonError(response, upstream.status, 'MUKU_LOCAL_EGRESS_REDIRECT_REJECTED');
      return;
    }
    const contentType = upstream.headers.get('content-type')?.toLowerCase() ?? '';
    const mediaType = contentType.split(';', 1)[0].trim();
    if (mediaType !== 'application/json') {
      await upstream.body?.cancel().catch(() => undefined);
      writeJsonError(response, 502, 'MUKU_LOCAL_EGRESS_NON_JSON_RESPONSE');
      return;
    }

    const body = await readLimitedBody(upstream, RESPONSE_LIMIT_BYTES);
    if (response.destroyed) return;
    response.statusCode = upstream.status;
    response.setHeader('Content-Type', contentType);
    copySafeResponseHeader(upstream, response, 'retry-after');
    copySafeResponseHeader(upstream, response, 'x-request-id');
    copySafeResponseHeader(upstream, response, 'cf-ray');
    response.end(body);
  } catch (error) {
    if (response.destroyed) return;
    writeJsonError(
      response,
      error instanceof ResponseLimitError ? 413 : 503,
      error instanceof ResponseLimitError
        ? 'MUKU_LOCAL_EGRESS_RESPONSE_TOO_LARGE'
        : controller.signal.aborted
          ? 'MUKU_LOCAL_EGRESS_TIMEOUT'
          : 'MUKU_LOCAL_EGRESS_UPSTREAM_FAILED',
    );
  } finally {
    clearTimeout(timeout);
    request.off('aborted', abort);
    response.off('close', abort);
  }
}

async function readLimitedBody(response: Response, limit: number) {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    await response.body?.cancel().catch(() => undefined);
    throw new ResponseLimitError();
  }
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel();
        throw new ResponseLimitError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function safeRequestUrl(value: string | undefined) {
  if (!value) return null;
  try {
    return new URL(value, 'http://127.0.0.1');
  } catch {
    return null;
  }
}

function isLoopbackAddress(value: string | undefined) {
  return value === '127.0.0.1'
    || value === '::1'
    || value === '::ffff:127.0.0.1';
}

function isLoopbackHost(value: string | undefined) {
  if (!value) return false;
  try {
    const hostname = new URL(`http://${value}`).hostname.toLowerCase();
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
  } catch {
    return false;
  }
}

function setNoStoreHeaders(response: ServerResponse) {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Pragma', 'no-cache');
  response.setHeader('X-Content-Type-Options', 'nosniff');
}

function writeJsonError(response: ServerResponse, status: number, code: string) {
  if (response.destroyed || response.headersSent) return;
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(JSON.stringify({ ok: false, code }));
}

function copySafeResponseHeader(upstream: Response, response: ServerResponse, name: string) {
  const value = upstream.headers.get(name);
  if (value && value.length <= 256 && !/[\r\n]/.test(value)) response.setHeader(name, value);
}

class ResponseLimitError extends Error {}
