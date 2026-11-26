import { env } from 'cloudflare:workers';
import { developmentOpenAccessEnabled } from '../../../../../../lib/access-policy';
import { purchaseRequestActionSchema } from '../../../../../../lib/contracts';
import { HttpError, jsonError, requestContext } from '../../../../../../lib/db';
import { executePurchaseRequestAction } from '../../../../../../lib/purchase-workflow-service';

export const dynamic = 'force-dynamic';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { db, user } = await requestContext(request);
    const parsed = purchaseRequestActionSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      throw new HttpError(
        400,
        parsed.error.issues[0]?.message ?? '不支持的采购申请动作',
        'INVALID_PURCHASE_REQUEST_ACTION',
      );
    }
    const { id } = await context.params;
    const result = await executePurchaseRequestAction(
      db,
      user,
      id,
      parsed.data,
      request.headers.get('Idempotency-Key') ?? '',
      {
        createOrderDraftOnApproval: true,
        developmentOpenAccess: developmentOpenAccessEnabled(
          env as unknown as Record<string, unknown>,
        ),
        runtimeEnv: env as unknown as Record<string, unknown>,
      },
    );
    return Response.json({ ok: true, ...result }, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    return jsonError(error);
  }
}
