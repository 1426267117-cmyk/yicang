export const ORDER_STATUSES = ['pending_review', 'reserved', 'shipped', 'cancelled'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];
export type OrderAction = 'approve' | 'ship' | 'cancel';
export type Role = 'admin' | 'operator' | 'viewer';
export type Permission =
  | 'orders:read'
  | 'orders:create'
  | 'orders:approve'
  | 'orders:ship'
  | 'orders:cancel'
  | 'audit:read'
  | 'connectors:read'
  | 'connectors:sync';

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  admin: ['orders:read', 'orders:create', 'orders:approve', 'orders:ship', 'orders:cancel', 'audit:read', 'connectors:read', 'connectors:sync'],
  operator: ['orders:read', 'orders:create', 'orders:ship', 'orders:cancel', 'connectors:read'],
  viewer: ['orders:read', 'connectors:read'],
};

export const ACTION_TARGET: Record<OrderAction, { from: OrderStatus[]; to: OrderStatus; permission: Permission }> = {
  approve: { from: ['pending_review'], to: 'reserved', permission: 'orders:approve' },
  ship: { from: ['reserved'], to: 'shipped', permission: 'orders:ship' },
  cancel: { from: ['pending_review', 'reserved'], to: 'cancelled', permission: 'orders:cancel' },
};

export function canTransition(status: OrderStatus, action: OrderAction) {
  return ACTION_TARGET[action].from.includes(status);
}

export function availableQuantity(onHand: number, reserved: number) {
  return onHand - reserved;
}

export function formatMoney(amountMinor: number, currency: string) {
  return new Intl.NumberFormat('zh-CN', { style: 'currency', currency }).format(amountMinor / 100);
}
