import { feishuIdentity, loginDisabled } from '../_shared';

export const dynamic = 'force-dynamic';

export function POST(request: Request) {
  return feishuIdentity()?.logout(request) ?? loginDisabled();
}
