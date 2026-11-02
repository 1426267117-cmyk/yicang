import { env } from 'cloudflare:workers';
import { handleSiteMcpRequest } from '../../lib/sites-procurement-mcp';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  return handleSiteMcpRequest(
    request,
    env as unknown as Record<string, unknown> & { DB?: D1Database },
  );
}
