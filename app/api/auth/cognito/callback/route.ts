import { cognitoIdentity } from '../_shared';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  return await cognitoIdentity()?.finishLogin(request) ?? new Response(null, { status: 404 });
}
