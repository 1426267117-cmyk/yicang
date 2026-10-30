export type ExactMoney = {
  amount: string;
  currency: string;
  minor: number | null;
};

export type CanonicalOrderLine = {
  sourceLineId: string;
  rawSku: string | null;
  normalizedSku: string | null;
  sourceProductId: string | null;
  sourceVariantId: string | null;
  title: string | null;
  name: string | null;
  orderedQuantity: number;
  currentQuantity: number | null;
  unfulfilledQuantity: number | null;
  unitPrice: ExactMoney | null;
  originalTotal: ExactMoney | null;
  discountedTotal: ExactMoney | null;
  discount: ExactMoney | null;
  raw: unknown;
};

export type CanonicalRefundLine = {
  sourceRefundLineId: string;
  sourceOrderLineId: string | null;
  quantity: number;
  restockType: string | null;
  sourceLocationId: string | null;
  subtotal: ExactMoney | null;
  tax: ExactMoney | null;
  raw: unknown;
};

export type CanonicalTransaction = {
  sourceTransactionId: string;
  sourceParentTransactionId: string | null;
  kind: string | null;
  status: string | null;
  gateway: string | null;
  test: boolean | null;
  amount: ExactMoney | null;
  sourceCreatedAt: string | null;
  sourceProcessedAt: string | null;
  raw: unknown;
};

export type CanonicalRefund = {
  sourceRefundId: string;
  sourceCreatedAt: string | null;
  sourceUpdatedAt: string | null;
  note: string | null;
  amount: ExactMoney | null;
  lines: CanonicalRefundLine[];
  transactions: CanonicalTransaction[];
  raw: unknown;
};

export type CanonicalFulfillmentLine = {
  sourceFulfillmentLineId: string;
  sourceOrderLineId: string | null;
  quantity: number;
  raw: unknown;
};

export type CanonicalTracking = {
  sequence: number;
  company: string | null;
  number: string | null;
  url: string | null;
  raw: unknown;
};

export type CanonicalFulfillment = {
  sourceFulfillmentId: string;
  status: string | null;
  shipmentStatus: string | null;
  sourceLocationId: string | null;
  sourceCreatedAt: string | null;
  sourceUpdatedAt: string | null;
  deliveredAt: string | null;
  estimatedDeliveryAt: string | null;
  lines: CanonicalFulfillmentLine[];
  tracking: CanonicalTracking[];
  raw: unknown;
};

export type CanonicalOrderGraph = {
  platform: 'shopify';
  sourceOrderId: string;
  sourceOrderName: string | null;
  sourceCreatedAt: string;
  sourceUpdatedAt: string;
  sourceProcessedAt: string | null;
  sourceCancelledAt: string | null;
  sourceClosedAt: string | null;
  sourceTimezone: string | null;
  businessDate: string | null;
  test: boolean | null;
  financialStatus: string | null;
  fulfillmentStatus: string | null;
  currency: string | null;
  subtotal: ExactMoney | null;
  discount: ExactMoney | null;
  shipping: ExactMoney | null;
  tax: ExactMoney | null;
  originalTotal: ExactMoney | null;
  currentTotal: ExactMoney | null;
  received: ExactMoney | null;
  refunded: ExactMoney | null;
  businessOwnership: string | null;
  lines: CanonicalOrderLine[];
  refunds: CanonicalRefund[];
  fulfillments: CanonicalFulfillment[];
  raw: unknown;
};

export type ConnectorPage<T> = {
  nodes: T[];
  hasNextPage: boolean;
  endCursor: string | null;
};
