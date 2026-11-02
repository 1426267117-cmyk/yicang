import { HttpError, jsonError, requestContext } from '../../../../../../lib/db';
import {
  loadPurchaseOrderDocument,
  purchaseOrderDocumentFileName,
  renderPurchaseOrderCsv,
  renderPurchaseOrderHtml,
} from '../../../../../../lib/purchase-order-document';

export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { db, user } = await requestContext(request);
    const { id } = await context.params;
    const order = await loadPurchaseOrderDocument(db, user, id);
    const format = new URL(request.url).searchParams.get('format')?.trim().toLowerCase() || 'html';

    if (format === 'csv') {
      return new Response(`\uFEFF${renderPurchaseOrderCsv(order)}`, {
        headers: documentHeaders(
          'text/csv; charset=utf-8',
          purchaseOrderDocumentFileName(order.orderNo, 'csv'),
          true,
        ),
      });
    }
    if (format !== 'html') {
      throw new HttpError(400, '采购单文档只支持 html 或 csv 格式', 'INVALID_PURCHASE_ORDER_DOCUMENT_FORMAT');
    }
    return new Response(renderPurchaseOrderHtml(order), {
      headers: documentHeaders(
        'text/html; charset=utf-8',
        purchaseOrderDocumentFileName(order.orderNo, 'html'),
        false,
      ),
    });
  } catch (error) {
    return jsonError(error);
  }
}

function documentHeaders(contentType: string, fileName: string, attachment: boolean) {
  const disposition = `${attachment ? 'attachment' : 'inline'}; filename="${fileName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
  return {
    'Cache-Control': 'private, no-store',
    'Content-Disposition': disposition,
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'self'; form-action 'none'",
    'Content-Type': contentType,
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  };
}
