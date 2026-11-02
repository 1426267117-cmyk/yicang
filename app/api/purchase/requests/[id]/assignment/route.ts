import { env } from 'cloudflare:workers';
import { developmentOpenAccessEnabled } from '../../../../../../lib/access-policy';
import { reassignPurchaseRequestSchema } from '../../../../../../lib/purchase-assignment-contracts';
import { reassignPurchaseRequest } from '../../../../../../lib/purchase-assignment-service';
import { HttpError, jsonError, requestContext } from '../../../../../../lib/db';

export const dynamic = 'force-dynamic';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { db, user } = await requestContext(request);
    const parsed = reassignPurchaseRequestSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      throw new HttpError(
        400,
        parsed.error.issues[0]?.message ?? '重新指派参数不完整',
        'INVALID_PURCHASE_ASSIGNMENT',
      );
    }
    const { id } = await context.params;
    const result = await reassignPurchaseRequest(
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
      headers: { 'Cache-Control': 'private, no-store' },
    });
  } catch (error) {
    return jsonError(error);
  }
}
