import { HttpError, jsonError, requestContext, requirePermission } from '../../../../../lib/db';
import { runSkuImport } from '../../../../../lib/purchase-sku-import';
import { SKU_IMPORT_MAX_FILE_BYTES } from '../../../../../lib/purchase-sku-import-workbook';

export const dynamic = 'force-dynamic';

const maxFormBytes = SKU_IMPORT_MAX_FILE_BYTES + 8 * 1024;

export async function POST(request: Request) {
  try {
    const { db, user } = await requestContext(request);
    requirePermission(user, 'purchase:mapping');
    const form = await readImportForm(request);
    const file = form.get('file');
    const intent = form.get('intent');
    const key = form.get('previewKey');
    if (!(file instanceof File) || !/\.xlsx$/iu.test(file.name) || file.size === 0 || form.getAll('file').length !== 1) {
      throw new HttpError(400, '请选择一个有效的 .xlsx 文件', 'SKU_IMPORT_FILE_REQUIRED');
    }
    if (file.size > SKU_IMPORT_MAX_FILE_BYTES) throw uploadTooLarge();
    if ((intent !== 'preview' && intent !== 'apply') || form.getAll('intent').length !== 1
      || form.getAll('previewKey').length > 1 || (key !== null && typeof key !== 'string')) {
      throw new HttpError(400, '无法读取导入操作，请刷新后重试', 'SKU_IMPORT_INVALID_INTENT');
    }

    const result = await runSkuImport(db, user, new Uint8Array(await file.arrayBuffer()), intent, key ?? undefined);
    return Response.json({ ok: true, ...result }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    const response = jsonError(error);
    response.headers.set('Cache-Control', 'private, no-store');
    return response;
  }
}

async function readImportForm(request: Request) {
  const contentType = request.headers.get('Content-Type');
  if (!contentType || !/^multipart\/form-data\s*;/iu.test(contentType)) {
    throw new HttpError(400, '请使用 SKU 导入窗口上传 Excel', 'SKU_IMPORT_FORM_REQUIRED');
  }
  if (Number(request.headers.get('Content-Length')) > maxFormBytes) throw uploadTooLarge();

  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, '请选择需要导入的 Excel 文件', 'SKU_IMPORT_FILE_REQUIRED');
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > maxFormBytes) {
        await reader.cancel().catch(() => {});
        throw uploadTooLarge();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const content = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    content.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return await new Response(content, { headers: { 'Content-Type': contentType } }).formData();
  } catch {
    throw new HttpError(400, 'Excel 上传数据不完整，请重新选择文件', 'SKU_IMPORT_MALFORMED_FORM');
  }
}

function uploadTooLarge() {
  return new HttpError(413, 'Excel 文件不能超过 2 MB', 'SKU_IMPORT_FILE_TOO_LARGE');
}
