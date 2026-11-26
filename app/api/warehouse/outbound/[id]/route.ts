import { HttpError, jsonError, requestContext } from '../../../../../lib/db';
import { confirmWarehouseOutboundShipment, getWarehouseOutbound, recordWarehouseOutboundStep,
  warehouseOutboundActionSchema } from '../../../../../lib/warehouse-outbound-service';

export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store' };
type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: RouteContext) {
  try {
    const { db, user } = await requestContext(request);
    const { id } = await params;
    return Response.json({ ok: true, state: await getWarehouseOutbound(db, user, id) }, { headers });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request, { params }: RouteContext) {
  try {
    const { db, user } = await requestContext(request);
    const { id } = await params;
    const input = warehouseOutboundActionSchema.safeParse(await request.json().catch(() => null));
    if (!input.success) throw new HttpError(400, '请填写当前出库步骤需要的核对信息', 'WAREHOUSE_OUTBOUND_INVALID_STEP');
    const key = request.headers.get('Idempotency-Key') ?? '';
    const result = input.data.step === 'ship' ? await confirmWarehouseOutboundShipment(db, user, id, key)
      : await recordWarehouseOutboundStep(db, user, id, input.data, key);
    return Response.json({ ok: true, ...result }, { headers, status: result.replayed ? 200 : 201 });
  } catch (error) {
    return errorResponse(error);
  }
}

function errorResponse(error: unknown) {
  const response = jsonError(error);
  response.headers.set('Cache-Control', headers['Cache-Control']);
  return response;
}
