import { env } from 'cloudflare:workers';
import { developmentOpenAccessEnabled } from '../../../../../lib/access-policy';
import { updatePurchaseOrderDraftSchema } from '../../../../../lib/contracts';
import { HttpError, jsonError, requestContext } from '../../../../../lib/db';
import { updatePurchaseOrderDraft } from '../../../../../lib/purchase-order-service';

export const dynamic = 'force-dynamic';

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { db, user } = await requestContext(request);
    const parsed = updatePurchaseOrderDraftSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      throw new HttpError(
        400,
        parsed.error.issues[0]?.message ?? '采购单草稿参数不完整',
        'INVALID_PURCHASE_ORDER_DRAFT',
      );
    }
    const { id } = await context.params;
    const result = await updatePurchaseOrderDraft(
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
