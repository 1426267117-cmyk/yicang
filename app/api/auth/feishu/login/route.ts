import { feishuIdentity, loginDisabled } from '../_shared';

export const dynamic = 'force-dynamic';

export function GET() {
  return feishuIdentity()?.beginLogin() ?? loginDisabled();
}
