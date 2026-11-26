export const ORDER_STATUSES = ['pending_review', 'reserved', 'shipped', 'cancelled'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];
export type OrderAction = 'approve' | 'ship' | 'cancel';
export type Role = 'admin' | 'operator' | 'viewer';
export const ACCESS_PROFILES = ['purchase', 'finance', 'amazon', 'wayfair', 'shopify', 'warehouse', 'pending'] as const;
export type AccessProfile = (typeof ACCESS_PROFILES)[number];
export type ChannelScope = Extract<AccessProfile, 'amazon' | 'wayfair' | 'shopify'>;
export type Permission =
  | 'orders:read'
  | 'orders:create'
  | 'orders:approve'
  | 'orders:ship'
  | 'orders:cancel'
  | 'audit:read'
  | 'connectors:read'
  | 'connectors:sync'
  | 'channels:read'
  | 'finance:read'
  | 'finance:review'
  | 'finance:write'
  | 'purchase:read'
  | 'purchase:create'
  | 'purchase:submit'
  | 'purchase:review'
  | 'purchase:mapping'
  | 'purchase:supplier:create'
  | 'purchase:order:create'
  | 'purchase:order:issue'
  | 'inventory:receive'
  | 'warehouse:read'
  | 'warehouse:manage'
  | 'warehouse:fulfill'
  | 'members:manage';

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  admin: [
    'orders:read', 'orders:create', 'orders:approve', 'orders:ship', 'orders:cancel',
    'audit:read', 'connectors:read', 'connectors:sync',
    'channels:read', 'finance:read', 'finance:review', 'finance:write',
    'purchase:read', 'purchase:create', 'purchase:submit', 'purchase:review', 'purchase:mapping',
    'purchase:supplier:create', 'purchase:order:create', 'purchase:order:issue', 'inventory:receive',
    'warehouse:read', 'warehouse:manage', 'members:manage',
  ],
  operator: [
    'orders:read', 'orders:create', 'orders:ship', 'orders:cancel', 'connectors:read',
    'purchase:read', 'purchase:create', 'purchase:submit', 'purchase:mapping',
    'purchase:supplier:create', 'purchase:order:create', 'purchase:order:issue', 'inventory:receive',
    'warehouse:manage',
  ],
  viewer: ['orders:read', 'connectors:read', 'purchase:read'],
};

const PROFILE_PERMISSIONS: Record<AccessProfile, Permission[]> = {
  purchase: [
    'purchase:read', 'purchase:create', 'purchase:submit', 'purchase:mapping',
    'purchase:supplier:create', 'purchase:order:create', 'purchase:order:issue',
  ],
  finance: ['finance:read', 'finance:review', 'finance:write'],
  amazon: ['channels:read'],
  wayfair: ['channels:read'],
  shopify: ['channels:read'],
  warehouse: ['warehouse:read', 'warehouse:manage', 'inventory:receive', 'warehouse:fulfill'],
  pending: [],
};

export function isAccessProfile(value: unknown): value is AccessProfile {
  return typeof value === 'string' && ACCESS_PROFILES.some((profile) => profile === value);
}

export function resolveMemberAccess(role: Role, accessProfile: string | null | undefined): {
  permissions: Permission[];
  channelScope: ChannelScope | null;
} {
  if (accessProfile == null) return { permissions: [...(ROLE_PERMISSIONS[role] ?? [])], channelScope: null };
  if (!isAccessProfile(accessProfile)) return { permissions: [], channelScope: null };
  const isChannel = accessProfile === 'amazon' || accessProfile === 'wayfair' || accessProfile === 'shopify';
  return { permissions: [...PROFILE_PERMISSIONS[accessProfile]], channelScope: isChannel ? accessProfile : null };
}

export function canReadInventoryMovements(permissions: readonly Permission[], channelScope?: ChannelScope | null) {
  return !channelScope && (permissions.includes('warehouse:read')
    || (permissions.includes('orders:read') && permissions.includes('purchase:read')));
}

export function canReadWarehouseFulfillment(permissions: readonly Permission[], channelScope?: ChannelScope | null) {
  return !channelScope && (permissions.includes('warehouse:read') || permissions.includes('orders:read'));
}

export function canManageWarehouseFulfillment(permissions: readonly Permission[], channelScope?: ChannelScope | null) {
  return !channelScope && (permissions.includes('warehouse:fulfill') || permissions.includes('orders:ship'));
}

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
