import { env } from 'cloudflare:workers';
import { handleSiteMcpRequest } from '../../lib/sites-procurement-mcp';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const runtimeEnv = env as unknown as Record<string, unknown> & { DB?: D1Database };
  if (runtimeEnv.ERP_HOST_RUNTIME === 'aws') {
    return new Response(null, { status: 404 });
  }
  return handleSiteMcpRequest(
    request,
    runtimeEnv,
  );
}
