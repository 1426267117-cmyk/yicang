export type ManagedMemberRole = 'admin' | 'operator' | 'viewer';

export type ManagedMemberView = {
  id: string;
  email: string;
  displayName: string;
  role: ManagedMemberRole;
  createdAt: string;
  protectedOwner: boolean;
};

export const MEMBER_ROLE_OPTIONS: Array<{
  value: ManagedMemberRole;
  label: string;
  description: string;
}> = [
  { value: 'admin', label: '管理员', description: '管理团队角色、复审采购，并可执行全部采购操作' },
  { value: 'operator', label: '操作员', description: '创建和提交申请、维护供应商、下单及登记到货' },
  { value: 'viewer', label: '只读成员', description: '查看订单、库存和采购记录，不执行写入操作' },
];

export function parseManagedMembersResponse(value: unknown): ManagedMemberView[] {
  const root = asRecord(value);
  if (root.ok !== true || !Array.isArray(root.members)) {
    throw new Error('团队成员数据格式无效');
  }
  return root.members.map((item) => {
    const member = asRecord(item);
    const role = member.role;
    if (
      typeof member.id !== 'string' || !member.id.trim()
      || typeof member.email !== 'string' || !member.email.trim()
      || typeof member.displayName !== 'string' || !member.displayName.trim()
      || !isManagedMemberRole(role)
      || typeof member.createdAt !== 'string'
      || typeof member.protectedOwner !== 'boolean'
    ) {
      throw new Error('团队成员数据格式无效');
    }
    return {
      id: member.id,
      email: member.email,
      displayName: member.displayName,
      role,
      createdAt: member.createdAt,
      protectedOwner: member.protectedOwner,
    };
  });
}

export function memberRoleChangeBlock(
  member: ManagedMemberView,
  nextRole: ManagedMemberRole,
  members: ManagedMemberView[],
) {
  if (member.role === nextRole) return null;
  if (member.protectedOwner && nextRole !== 'admin') {
    return '工作区负责人必须保留管理员角色';
  }
  if (member.role === 'admin' && nextRole !== 'admin') {
    const adminCount = members.filter((item) => item.role === 'admin').length;
    if (adminCount <= 1) return '请先指定另一名管理员，再调整当前唯一管理员';
  }
  return null;
}

export function purchaseAssigneeCandidates<T extends { role: ManagedMemberRole }>(members: T[]) {
  return {
    purchasers: members.filter((member) => member.role === 'admin' || member.role === 'operator'),
    reviewers: members.filter((member) => member.role === 'admin'),
  };
}

export function managedMemberErrorMessage(value: unknown, fallback: string) {
  const root = asRecord(value);
  const code = typeof root.code === 'string' ? root.code : '';
  const messages: Record<string, string> = {
    BOOTSTRAP_OWNER_ROLE_PROTECTED: '工作区负责人必须保留管理员角色',
    LAST_ADMIN_ROLE_PROTECTED: '请先指定另一名管理员，再调整当前唯一管理员',
    MEMBER_ROLE_CONFLICT: '该成员的角色刚刚发生变化，请刷新后重试',
    MEMBER_NOT_FOUND: '该成员不存在或不在当前工作区',
    PERMISSION_DENIED: '当前账号已没有团队角色管理权限，请刷新页面',
    MEMBER_ROLE_ACTIVE_PURCHASER_ASSIGNMENTS: '该成员仍有未完成的采购负责人任务，请先完成或撤回对应申请',
    MEMBER_ROLE_ACTIVE_REVIEWER_ASSIGNMENTS: '该成员仍有待复审任务，请先完成或取消对应申请',
  };
  if (messages[code]) return messages[code];
  return typeof root.message === 'string' && root.message.trim() ? root.message.trim() : fallback;
}

function isManagedMemberRole(value: unknown): value is ManagedMemberRole {
  return value === 'admin' || value === 'operator' || value === 'viewer';
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
