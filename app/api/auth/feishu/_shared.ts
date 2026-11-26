import { env } from 'cloudflare:workers';
import type { createFeishuIdentity } from '../../../../lib/aws/feishu-identity';

export function feishuIdentity() {
  const runtime = env as unknown as {
    ERP_HOST_RUNTIME?: string;
    feishuIdentity?: ReturnType<typeof createFeishuIdentity>;
  };
  return runtime.ERP_HOST_RUNTIME === 'aws' ? runtime.feishuIdentity : undefined;
}

export function loginDisabled() {
  return new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store' } });
}
