import { env } from 'cloudflare:workers';
import { readProductionAccessPolicy } from '../../../lib/access-policy';
import { jsonError, requestContext } from '../../../lib/db';
import { listManagedMembers } from '../../../lib/member-management-service';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const { db, user } = await requestContext(request);
    const policy = readProductionAccessPolicy(env as unknown as Record<string, unknown>);
    const members = await listManagedMembers(db, user, policy.bootstrapOwnerEmail);
    return Response.json({ ok: true, members }, {
      headers: { 'Cache-Control': 'private, no-store' },
    });
  } catch (error) {
    return jsonError(error);
  }
}
