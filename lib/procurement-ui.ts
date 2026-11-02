export function activePurchaseRequestIds(
  purchaseOrders: Array<{ purchaseRequestId: string; status: string }>,
) {
  return new Set(
    purchaseOrders
      .filter((order) => order.status !== 'cancelled')
      .map((order) => order.purchaseRequestId),
  );
}
