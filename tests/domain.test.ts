import { describe, expect, it } from 'vitest';
import { ACTION_TARGET, availableQuantity, canTransition, ROLE_PERMISSIONS } from '../lib/domain';

describe('订单状态机', () => {
  it('只允许已审核订单发货', () => {
    expect(canTransition('reserved', 'ship')).toBe(true);
    expect(canTransition('pending_review', 'ship')).toBe(false);
    expect(canTransition('shipped', 'cancel')).toBe(false);
  });

  it('取消会进入不可继续处理的终态', () => {
    expect(ACTION_TARGET.cancel.to).toBe('cancelled');
    expect(canTransition('cancelled', 'approve')).toBe(false);
  });
});

describe('库存与权限规则', () => {
  it('可售库存等于现存减预占', () => {
    expect(availableQuantity(18, 5)).toBe(13);
  });

  it('操作员不能审核订单，查看者不能写订单', () => {
    expect(ROLE_PERMISSIONS.operator).not.toContain('orders:approve');
    expect(ROLE_PERMISSIONS.viewer).toEqual(['orders:read']);
  });
});
