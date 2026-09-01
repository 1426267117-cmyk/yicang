import { createOrderSchema } from '../../../lib/contracts';
import { HttpError, jsonError, requestContext } from '../../../lib/db';
import { createOrder } from '../../../lib/erp-service';

export async function POST(request: Request) {
  try {
    const { db, user } = await requestContext(request);
    const parsed = createOrderSchema.safeParse(await request.json());
    if (!parsed.success) {
      throw new HttpError(400, parsed.error.issues[0]?.message ?? '订单参数不完整', 'INVALID_ORDER');
    }
    const result = await createOrder(db, user, parsed.data, request.headers.get('Idempotency-Key') ?? '');
    return Response.json({ ok: true, ...result }, { status: result.replayed ? 200 : 201 });
  } catch (error) {
    return jsonError(error);
  }
}
