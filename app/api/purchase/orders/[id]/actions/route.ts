import { env } from 'cloudflare:workers';
import { developmentOpenAccessEnabled } from '../../../../../../lib/access-policy';
import { purchaseOrderActionSchema } from '../../../../../../lib/contracts';
import { HttpError, jsonError, requestContext } from '../../../../../../lib/db';
import { executePurchaseOrderAction } from '../../../../../../lib/purchase-order-service';

export const dynamic = 'force-dynamic';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { db, user } = await requestContext(request);
    const parsed = purchaseOrderActionSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      throw new HttpError(
        400,
        parsed.error.issues[0]?.message ?? '不支持的采购单操作',
        'INVALID_PURCHASE_ORDER_ACTION',
      );
    }
    const { id } = await context.params;
    const result = await executePurchaseOrderAction(
      db,
      user,
      id,
      parsed.data,
      request.headers.get('Idempotency-Key') ?? '',
      {
        developmentOpenAccess: developmentOpenAccessEnabled(
          env as unknown as Record<string, unknown>,
        ),
      },
    );
    return Response.json({ ok: true, ...result }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    return jsonError(error);
  }
}
