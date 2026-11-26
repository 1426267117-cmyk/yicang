export const pendingFulfillmentStatuses = [
  'UNFULFILLED', 'PARTIALLY_FULFILLED', 'OPEN', 'PENDING_FULFILLMENT',
  'PENDING_AVAILABILITY', 'PENDING', 'UNSHIPPED', 'PARTIALLY_SHIPPED', 'INVOICE_UNCONFIRMED',
] as const;
export const completedFulfillmentStatuses = ['FULFILLED', 'SHIPPED'] as const;
export const cancelledFulfillmentStatuses = ['CANCELLED', 'CANCELED'] as const;
