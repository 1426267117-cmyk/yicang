import { orderActionSchema } from '../../../../../lib/contracts';
import { HttpError, jsonError, requestContext } from '../../../../../lib/db';
import { executeOrderAction } from '../../../../../lib/erp-service';

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { db, user } = await requestContext(request);
    const parsed = orderActionSchema.safeParse(await request.json());
    if (!parsed.success) throw new HttpError(400, '不支持的订单动作', 'INVALID_ACTION');
    const { id } = await context.params;
    const result = await executeOrderAction(
      db,
      user,
      id,
      parsed.data.action,
      request.headers.get('Idempotency-Key') ?? '',
    );
    return Response.json({ ok: true, ...result });
  } catch (error) {
    return jsonError(error);
  }
}
