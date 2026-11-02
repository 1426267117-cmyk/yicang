import { createSupplierSchema } from '../../../../lib/contracts';
import { HttpError, jsonError, requestContext } from '../../../../lib/db';
import { createSupplier } from '../../../../lib/purchase-order-service';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const { db, user } = await requestContext(request);
    const parsed = createSupplierSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      throw new HttpError(
        400,
        parsed.error.issues[0]?.message ?? '供应商参数不完整',
        'INVALID_PURCHASE_SUPPLIER',
      );
    }
    const result = await createSupplier(
      db,
      user,
      parsed.data,
      request.headers.get('Idempotency-Key') ?? '',
    );
    return Response.json({ ok: true, ...result }, {
      status: result.replayed ? 200 : 201,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    return jsonError(error);
  }
}
