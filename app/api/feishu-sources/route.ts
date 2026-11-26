import { env } from 'cloudflare:workers';
import { z } from 'zod';
import { HttpError, jsonError, requestContext, requirePermission } from '../../../lib/db';
import { isContinuousFeishuMode } from '../../../lib/feishu-procurement-sync';

export const dynamic = 'force-dynamic';

const headers = { 'Cache-Control': 'private, no-store' };
const sourceIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$/u;
const tableIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$/u;
const tokenPattern = /^[a-zA-Z0-9_-]{32,128}$/u;
const responseLimit = 1024 * 1024;
const timestamp = z.iso.datetime({ offset: true });

const table = z.object({
  id: z.string().regex(tableIdPattern),
  title: z.string().min(1).max(160),
  hidden: z.boolean(),
  preview: z.boolean(),
});
const sourcesResponse = z.object({
  ok: z.literal(true),
  sources: z.array(z.object({
    id: z.string().regex(sourceIdPattern),
    title: z.string().min(1).max(160),
    type: z.enum(['sheet', 'bitable']),
    usage: z.enum(['采购', '库存', '物流', '订单']),
    status: z.enum(['ready', 'failed']),
    checkedAt: timestamp.nullable(),
    tables: z.array(table).max(500),
    message: z.string().max(250).optional(),
  })).max(50),
});
const previewResponse = z.object({
  ok: z.literal(true),
  preview: z.object({
    sourceId: z.string().regex(sourceIdPattern),
    tableId: z.string().regex(tableIdPattern),
    title: z.string().min(1).max(160),
    readAt: timestamp,
    columns: z.array(z.string().max(200)).max(12),
    rows: z.array(z.array(z.union([z.string().max(200), z.number(), z.null()])).max(12)).max(25),
    hasMore: z.boolean(),
  }),
});
const errorResponse = z.object({
  ok: z.literal(false),
  code: z.string().regex(/^[A-Z0-9_]{1,80}$/u),
  message: z.string().min(1).max(250),
});

export async function GET(request: Request) {
  try {
    const { user } = await requestContext(request);
    requirePermission(user, 'purchase:read');
    const incoming = new URL(request.url);
    const token = localBridgeToken(incoming, env as unknown as Record<string, unknown>);
    if (!token) throw new HttpError(503, '本地飞书来源尚未启用', 'FEISHU_SOURCES_DISABLED');

    const selection = readSelection(incoming.searchParams);
    const bridge = new URL('/__local/feishu-sources', incoming.origin);
    if (selection) {
      bridge.searchParams.set('source', selection.source);
      bridge.searchParams.set('table', selection.tableId);
    }
    const timeout = AbortSignal.timeout(60_000);
    try {
      const upstream = await fetch(bridge, {
        method: 'GET',
        redirect: 'manual',
        signal: timeout,
        headers: { Accept: 'application/json', Authorization: `Bearer ${token}`, 'Cache-Control': 'no-store' },
      });
      const body = await readBridgeResponse(upstream);
      if (!upstream.ok && upstream.status >= 400 && upstream.status <= 599) {
        const error = errorResponse.safeParse(body);
        if (error.success) return Response.json(error.data, { status: upstream.status, headers });
      } else if (upstream.ok && selection) {
        const parsed = previewResponse.safeParse(body);
        if (parsed.success && parsed.data.preview.sourceId === selection.source
          && parsed.data.preview.tableId === selection.tableId) {
          return Response.json(parsed.data, { headers });
        }
      } else if (upstream.ok) {
        const parsed = sourcesResponse.safeParse(body);
        if (parsed.success) return Response.json(parsed.data, { headers });
      }
    } catch {
      if (timeout.aborted) {
        throw new HttpError(504, '读取飞书来源超时，请稍后重试', 'FEISHU_SOURCES_TIMEOUT');
      }
    }
    throw new HttpError(502, '暂时无法读取飞书来源，请稍后重试', 'FEISHU_SOURCES_UNAVAILABLE');
  } catch (error) {
    const response = jsonError(error);
    response.headers.set('Cache-Control', headers['Cache-Control']);
    return response;
  }
}

function localBridgeToken(url: URL, runtime: Record<string, unknown>) {
  if (!isContinuousFeishuMode(runtime) || runtime.ERP_HOST_RUNTIME === 'aws'
    || runtime.ERP_FEISHU_SOURCES_LOCAL_ENABLED !== 'true') return null;
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return null;
  if (url.origin !== runtime.ERP_FEISHU_SOURCES_LOCAL_ORIGIN) return null;
  const token = runtime.ERP_FEISHU_SYNC_WORKER_TOKEN;
  return typeof token === 'string' && tokenPattern.test(token) ? token : null;
}

function readSelection(query: URLSearchParams) {
  const keys = [...query.keys()];
  if (!keys.length) return null;
  const source = query.get('source');
  const tableId = query.get('table');
  if (keys.length !== 2 || !source || !tableId || !sourceIdPattern.test(source) || !tableIdPattern.test(tableId)) {
    throw new HttpError(400, '请同时选择有效的飞书来源和子表', 'INVALID_FEISHU_SOURCE_SELECTION');
  }
  return { source, tableId };
}

async function readBridgeResponse(response: Response): Promise<unknown> {
  if (Number(response.headers.get('Content-Length')) > responseLimit) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  const reader = response.body?.getReader();
  if (!reader) return null;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let length = 0;
  let content = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > responseLimit) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      content += decoder.decode(value, { stream: true });
    }
    return JSON.parse(content + decoder.decode());
  } finally {
    reader.releaseLock();
  }
}
