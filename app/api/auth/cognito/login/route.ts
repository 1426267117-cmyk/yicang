import { cognitoIdentity } from '../_shared';

export const dynamic = 'force-dynamic';

export function GET() {
  return cognitoIdentity()?.beginLogin() ?? new Response(null, { status: 404 });
}
