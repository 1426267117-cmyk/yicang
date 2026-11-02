import { describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({ env: {} }));

import { updateMemberRoleSchema } from '../app/api/members/[id]/role/route';

describe('成员角色接口输入', () => {
  it.each(['admin', 'operator', 'viewer'] as const)('接受受支持角色 %s', (role) => {
    expect(updateMemberRoleSchema.safeParse({ role }).success).toBe(true);
  });

  it.each([
    null,
    {},
    { role: '' },
    { role: 'owner' },
    { role: 'ADMIN' },
    { role: 1 },
  ])('拒绝无效角色 %#', (input) => {
    expect(updateMemberRoleSchema.safeParse(input).success).toBe(false);
  });
});
