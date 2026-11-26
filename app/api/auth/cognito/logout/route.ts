import { cognitoIdentity } from '../_shared';

export const dynamic = 'force-dynamic';

export function POST(request: Request) {
  return cognitoIdentity()?.logout(request) ?? new Response(null, { status: 404 });
}
