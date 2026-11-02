import { env } from 'cloudflare:workers';
import { z } from 'zod';
import { readProductionAccessPolicy } from '../../../../../lib/access-policy';
import { HttpError, jsonError, requestContext } from '../../../../../lib/db';
import { updateManagedMemberRole } from '../../../../../lib/member-management-service';

export const dynamic = 'force-dynamic';

export const updateMemberRoleSchema = z.object({
  role: z.enum(['admin', 'operator', 'viewer']),
});

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { db, user } = await requestContext(request);
    const parsed = updateMemberRoleSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      throw new HttpError(
        400,
        parsed.error.issues[0]?.message ?? '成员角色参数无效',
        'INVALID_MEMBER_ROLE',
      );
    }
    const { id } = await context.params;
    const policy = readProductionAccessPolicy(env as unknown as Record<string, unknown>);
    const result = await updateManagedMemberRole(db, user, {
      memberId: id,
      role: parsed.data.role,
      bootstrapOwnerEmail: policy.bootstrapOwnerEmail,
    });
    return Response.json({ ok: true, ...result }, {
      headers: { 'Cache-Control': 'private, no-store' },
    });
  } catch (error) {
    return jsonError(error);
  }
}
