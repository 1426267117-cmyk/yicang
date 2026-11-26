import { HttpError, jsonError, requestContext, requirePermission } from '../../../../../lib/db';

export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { db, user } = await requestContext(request);
    requirePermission(user, 'purchase:read');
    const { id } = await context.params;
    const image = /^[a-f0-9]{64}$/u.test(id) ? await db.prepare(`
      SELECT content_type, content
      FROM purchase_product_images
      WHERE tenant_id = ? AND id = ?
    `).bind(user.tenantId, id).first<{ content_type: string; content: ArrayBuffer | ArrayLike<number> }>() : null;
    if (!image) throw new HttpError(404, '找不到产品图片', 'PURCHASE_IMAGE_NOT_FOUND');

    const content = image.content instanceof ArrayBuffer ? image.content : Uint8Array.from(image.content).buffer;
    return new Response(content, {
      headers: {
        'Cache-Control': 'private, no-store',
        'Content-Length': String(content.byteLength),
        'Content-Type': image.content_type,
        'Cross-Origin-Resource-Policy': 'same-origin',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    return jsonError(error);
  }
}
