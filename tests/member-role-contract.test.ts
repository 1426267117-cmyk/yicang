import { describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({ env: {} }));

import { updateMemberRoleSchema } from '../app/api/members/[id]/role/route';
import { ACCESS_PROFILES, resolveMemberAccess } from '../lib/domain';

describe('成员角色接口输入', () => {
  it.each(['admin', 'operator', 'viewer'] as const)('接受受支持角色 %s', (role) => {
    expect(updateMemberRoleSchema.safeParse({ role }).success).toBe(true);
  });

  it.each(ACCESS_PROFILES)('接受受支持岗位 %s', (accessProfile) => {
    expect(updateMemberRoleSchema.safeParse({ accessProfile }).success).toBe(true);
  });

  it.each([
    null,
    {},
    { role: '' },
    { role: 'owner' },
    { role: 'ADMIN' },
    { role: 1 },
    { role: 'admin', accessProfile: 'amazon' },
    { accessProfile: null },
  ])('拒绝无效角色 %#', (input) => {
    expect(updateMemberRoleSchema.safeParse(input).success).toBe(false);
  });

  it('财务权限独立于采购复审和渠道权限，未授权岗位没有业务权限', () => {
    expect(resolveMemberAccess('viewer', 'finance')).toEqual({
      permissions: ['finance:read', 'finance:review', 'finance:write'], channelScope: null,
    });
    expect(resolveMemberAccess('viewer', 'warehouse').permissions).toEqual([
      'warehouse:read', 'warehouse:manage', 'inventory:receive', 'warehouse:fulfill',
    ]);
    expect(resolveMemberAccess('viewer', 'pending').permissions).toEqual([]);
    expect(resolveMemberAccess('admin', 'unknown').permissions).toEqual([]);
  });
});
