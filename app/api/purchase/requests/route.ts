import {
  DIRECT_PURCHASE_REQUEST_DISABLED_CODE,
  DIRECT_PURCHASE_REQUEST_DISABLED_MESSAGE,
} from '../../../../lib/procurement-ui';

export const dynamic = 'force-dynamic';

export async function POST() {
  return Response.json({
    ok: false,
    code: DIRECT_PURCHASE_REQUEST_DISABLED_CODE,
    message: DIRECT_PURCHASE_REQUEST_DISABLED_MESSAGE,
    replacementEndpoint: '/api/purchase/planning/requests',
  }, {
    status: 410,
    headers: { 'Cache-Control': 'no-store' },
  });
}
