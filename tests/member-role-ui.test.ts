import { describe, expect, it } from 'vitest';
import {
  MEMBER_ROLE_OPTIONS,
  managedMemberErrorMessage,
  memberRoleChangeBlock,
  parseManagedMembersResponse,
  purchaseAssigneeCandidates,
  type ManagedMemberView,
} from '../lib/member-role-ui';

const owner: ManagedMemberView = {
  id: 'owner',
  email: 'owner@example.com',
  displayName: '负责人',
  role: 'admin',
  createdAt: '2026-11-02T00:00:00.000Z',
  protectedOwner: true,
};
const operator: ManagedMemberView = {
  id: 'operator',
  email: 'operator@example.com',
  displayName: '采购员',
  role: 'operator',
  createdAt: '2026-11-02T00:00:00.000Z',
  protectedOwner: false,
};

describe('团队角色前端合同', () => {
  it('只保留界面需要的安全字段，不向组件传递 auth_user_id', () => {
    const [member] = parseManagedMembersResponse({
      ok: true,
      members: [{
        ...operator,
        authUserId: 'internal-auth-id',
        token: 'must-not-pass-through',
      }],
    });

    expect(member).toEqual(operator);
    expect(member).not.toHaveProperty('authUserId');
    expect(member).not.toHaveProperty('token');
  });

  it('拒绝缺字段、未知角色或非成功响应', () => {
    expect(() => parseManagedMembersResponse({ ok: false, members: [] })).toThrow('格式无效');
    expect(() => parseManagedMembersResponse({ ok: true, members: [{ ...operator, role: 'owner' }] })).toThrow('格式无效');
    expect(() => parseManagedMembersResponse({ ok: true, members: [{ ...operator, email: '' }] })).toThrow('格式无效');
  });

  it('清楚说明三个角色并保持顺序稳定', () => {
    expect(MEMBER_ROLE_OPTIONS.map((role) => role.value)).toEqual(['admin', 'operator', 'viewer']);
    expect(MEMBER_ROLE_OPTIONS.every((role) => role.label && role.description)).toBe(true);
  });

  it('在界面预先阻止负责人和唯一管理员降级', () => {
    expect(memberRoleChangeBlock(owner, 'operator', [owner, operator])).toContain('负责人');
    const soleAdmin = { ...owner, protectedOwner: false };
    expect(memberRoleChangeBlock(soleAdmin, 'viewer', [soleAdmin, operator])).toContain('另一名管理员');
  });

  it('存在另一管理员时允许调整非负责人的管理员', () => {
    const secondAdmin = { ...operator, role: 'admin' as const };
    expect(memberRoleChangeBlock(secondAdmin, 'operator', [owner, secondAdmin])).toBeNull();
    expect(memberRoleChangeBlock(operator, 'operator', [owner, operator])).toBeNull();
  });

  it('将服务端保护错误转成采购部门可理解的提示', () => {
    expect(managedMemberErrorMessage({ code: 'LAST_ADMIN_ROLE_PROTECTED' }, '失败')).toContain('另一名管理员');
    expect(managedMemberErrorMessage({ code: 'PERMISSION_DENIED' }, '失败')).toContain('没有团队角色管理权限');
    expect(managedMemberErrorMessage({ message: '自定义错误' }, '失败')).toBe('自定义错误');
  });

  it('采购负责人排除只读成员，复审人只允许管理员', () => {
    const viewer = { ...operator, id: 'viewer', role: 'viewer' as const };
    const candidates = purchaseAssigneeCandidates([owner, operator, viewer]);

    expect(candidates.purchasers.map((member) => member.id)).toEqual(['owner', 'operator']);
    expect(candidates.reviewers.map((member) => member.id)).toEqual(['owner']);
  });

  it('友好说明未完成采购指派造成的角色变更阻断', () => {
    expect(managedMemberErrorMessage(
      { code: 'MEMBER_ROLE_ACTIVE_PURCHASER_ASSIGNMENTS' },
      '失败',
    )).toContain('采购负责人任务');
    expect(managedMemberErrorMessage(
      { code: 'MEMBER_ROLE_ACTIVE_REVIEWER_ASSIGNMENTS' },
      '失败',
    )).toContain('待复审');
  });
});
