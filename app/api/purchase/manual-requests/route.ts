import { env } from 'cloudflare:workers';
import { z } from 'zod';
import { developmentOpenAccessEnabled } from '../../../../lib/access-policy';
import { createManualPurchaseRequestSchema } from '../../../../lib/contracts';
import { HttpError, jsonError, requestContext } from '../../../../lib/db';
import { createManualPurchaseRequest } from '../../../../lib/purchase-workflow-service';

export const dynamic = 'force-dynamic';
const manualPurchaseRequestSchema = createManualPurchaseRequestSchema.safeExtend({
  intent: z.enum(['draft', 'submit']).optional(),
});

export async function POST(request: Request) {
  try {
    const { db, user } = await requestContext(request);
    const parsed = manualPurchaseRequestSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      throw new HttpError(
        400,
        parsed.error.issues[0]?.message ?? '手工采购申请参数不完整',
        'INVALID_MANUAL_PURCHASE_REQUEST',
      );
    }
    const result = await createManualPurchaseRequest(
      db,
      user,
      parsed.data,
      request.headers.get('Idempotency-Key') ?? '',
      { developmentOpenAccess: developmentOpenAccessEnabled(env as unknown as Record<string, unknown>) },
    );
    return Response.json({ ok: true, ...result }, {
      status: result.replayed ? 200 : 201,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    return jsonError(error);
  }
}
