import { HttpError, jsonError } from './db';
import { FEISHU_PROCUREMENT_PREVIEW_MAX_BYTES } from './feishu-procurement-preview-contract';

export const feishuPreviewHeaders = { 'Cache-Control': 'private, no-store' };

export function requireFeishuImportOrigin(request: Request, runtime: Record<string, unknown>) {
  const origin = request.headers.get('Origin');
  if (!origin) return;
  const incoming = new URL(request.url);
  let allowed = incoming.origin;
  if (runtime.ERP_HOST_RUNTIME === 'aws') {
    const publicOrigin = typeof runtime.ERP_PUBLIC_ORIGIN === 'string' ? URL.parse(runtime.ERP_PUBLIC_ORIGIN) : null;
    allowed = publicOrigin?.protocol === 'https:' && publicOrigin.host === incoming.host ? publicOrigin.origin : '';
  }
  if (origin !== allowed) throw new HttpError(403, '请从易仓工作区提交导入文件', 'FEISHU_IMPORT_ORIGIN_MISMATCH');
}

export async function readFeishuPreviewJson(request: Request, maxBytes = FEISHU_PROCUREMENT_PREVIEW_MAX_BYTES): Promise<unknown> {
  if (request.headers.get('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
    throw new HttpError(415, '导入文件必须使用 application/json', 'INVALID_FEISHU_PROCUREMENT_PREVIEW');
  }
  if (Number(request.headers.get('Content-Length')) > maxBytes) throw previewTooLarge();
  const reader = request.body?.getReader();
  if (!reader) return null;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw previewTooLarge();
      }
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, '请求体应为 UTF-8 JSON', 'INVALID_FEISHU_PROCUREMENT_PREVIEW');
  } finally {
    reader.releaseLock();
  }
}

export function feishuPreviewError(error: unknown) {
  const handled = error instanceof RangeError && error.message === 'FEISHU_PROCUREMENT_PREVIEW_TOO_LARGE'
    ? previewTooLarge()
    : error;
  const response = jsonError(handled);
  response.headers.set('Cache-Control', feishuPreviewHeaders['Cache-Control']);
  return response;
}

function previewTooLarge() {
  return new HttpError(413, '导入文件超过允许的大小', 'FEISHU_PROCUREMENT_PREVIEW_TOO_LARGE');
}
