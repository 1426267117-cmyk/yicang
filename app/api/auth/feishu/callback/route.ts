import { feishuIdentity, loginDisabled } from '../_shared';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  return (await feishuIdentity()?.finishLogin(request)) ?? loginDisabled();
}
