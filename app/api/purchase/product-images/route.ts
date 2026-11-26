import { HttpError, jsonError, requestContext, requirePermission } from '../../../../lib/db';
import { maxPurchaseProductImageBytes, purchaseProductImagePath } from '../../../../lib/purchase-product-details';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const { db, user } = await requestContext(request);
    requirePermission(user, 'purchase:create');
    const contentType = request.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase();
    if (contentType !== 'image/png' && contentType !== 'image/jpeg' && contentType !== 'image/webp') {
      throw new HttpError(415, '请选择 PNG、JPEG 或 WebP 图片', 'PURCHASE_IMAGE_TYPE_INVALID');
    }

    const content = await readImageBody(request);
    if (!matchesImageType(content, contentType)) {
      throw new HttpError(415, '图片文件与所选格式不符', 'PURCHASE_IMAGE_TYPE_INVALID');
    }
    const digest = await crypto.subtle.digest('SHA-256', content);
    const id = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
    const saved = await db.prepare(`
      INSERT INTO purchase_product_images (tenant_id, id, content_type, content, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (tenant_id, id) DO NOTHING
    `).bind(user.tenantId, id, contentType, content, new Date().toISOString()).run();
    return Response.json({ ok: true, imageUrl: `${purchaseProductImagePath}${id}` }, {
      status: saved.meta.changes ? 201 : 200,
      headers: { 'Cache-Control': 'private, no-store' },
    });
  } catch (error) {
    return jsonError(error);
  }
}

async function readImageBody(request: Request) {
  const tooLarge = () => new HttpError(413, '图片大小不能超过 1 MB', 'PURCHASE_IMAGE_TOO_LARGE');
  if (Number(request.headers.get('Content-Length')) > maxPurchaseProductImageBytes) throw tooLarge();
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, '请选择一张图片', 'PURCHASE_IMAGE_MISSING');
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxPurchaseProductImageBytes) {
        await reader.cancel().catch(() => {});
        throw tooLarge();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (total === 0) throw new HttpError(400, '请选择一张图片', 'PURCHASE_IMAGE_MISSING');

  const content = new ArrayBuffer(total);
  const bytes = new Uint8Array(content);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return content;
}

function matchesImageType(content: ArrayBuffer, contentType: 'image/png' | 'image/jpeg' | 'image/webp') {
  const bytes = new Uint8Array(content);
  switch (contentType) {
    case 'image/png':
      return bytes.length >= 33 && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte);
    case 'image/jpeg':
      return bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    case 'image/webp':
      return bytes.length >= 16 && [82, 73, 70, 70, 87, 69, 66, 80].every((byte, index) => bytes[index + (index < 4 ? 0 : 4)] === byte);
  }
}
