export const DIRECT_PURCHASE_REQUEST_DISABLED_CODE = 'DIRECT_PURCHASE_REQUEST_DISABLED';
export const DIRECT_PURCHASE_REQUEST_DISABLED_MESSAGE =
  '订单需求明细仅供查看；请从“今日采购建议”按最新库存、在途和数据时效生成采购申请';

export function assignmentActionAllowed(assigned: boolean, developmentOpenAccess: boolean) {
  return developmentOpenAccess || assigned;
}

export function purchaseOrderCompletion(order: {
  deliveryWarehouse: { id: string } | null;
  expectedDeliveryAt: string | null;
  currency: string | null;
  lines: Array<{ unitCostMinor: number | null; currency: string | null }>;
}) {
  const missing: string[] = [];
  if (!order.deliveryWarehouse?.id) missing.push('收货仓库');
  if (!order.expectedDeliveryAt?.trim()) missing.push('预计交期');
  if (!order.currency || !/^[A-Z]{3}$/u.test(order.currency)) missing.push('币种');
  if (!order.lines.length || order.lines.some((line) => (
    !Number.isSafeInteger(line.unitCostMinor)
    || Number(line.unitCostMinor) < 0
    || line.currency !== order.currency
  ))) missing.push('全部明细单价');
  return { ready: missing.length === 0, missing };
}

export function activePurchaseRequestIds(
  purchaseOrders: Array<{ purchaseRequestId: string; status: string }>,
) {
  return new Set(
    purchaseOrders
      .filter((order) => order.status !== 'cancelled')
      .map((order) => order.purchaseRequestId),
  );
}

export type ReceiptCorrectionSourceLine = {
  id: string;
  quantity: number;
};

export type ReceiptCorrectionHistory = {
  lines: Array<{
    purchaseReceiptLineId: string;
    quantity: number;
  }>;
};

export type ReceiptCorrectionAvailability = ReceiptCorrectionSourceLine & {
  correctedQuantity: number;
  remainingQuantity: number;
};

export function receiptCorrectionAvailability<T extends ReceiptCorrectionSourceLine>(
  receiptLines: T[],
  corrections: ReceiptCorrectionHistory[],
): Array<T & ReceiptCorrectionAvailability> {
  const correctedByLine = new Map<string, number>();
  for (const correction of corrections) {
    for (const line of correction.lines) {
      if (!Number.isInteger(line.quantity) || line.quantity <= 0) continue;
      correctedByLine.set(
        line.purchaseReceiptLineId,
        (correctedByLine.get(line.purchaseReceiptLineId) ?? 0) + line.quantity,
      );
    }
  }
  return receiptLines.map((line) => {
    const originalQuantity = Number.isInteger(line.quantity) && line.quantity > 0 ? line.quantity : 0;
    const correctedQuantity = correctedByLine.get(line.id) ?? 0;
    return {
      ...line,
      quantity: originalQuantity,
      correctedQuantity,
      remainingQuantity: Math.max(0, originalQuantity - correctedQuantity),
    };
  });
}

export function normalizedReceiptQuantities(receipt: {
  totalQuantity: number;
  originalQuantity?: number;
  correctedQuantity?: number;
  netQuantity?: number;
  correctionCount?: number;
}) {
  const originalQuantity = nonNegativeInteger(receipt.originalQuantity) ?? nonNegativeInteger(receipt.totalQuantity) ?? 0;
  const reportedNetQuantity = nonNegativeInteger(receipt.netQuantity);
  const correctedQuantity = Math.min(
    originalQuantity,
    nonNegativeInteger(receipt.correctedQuantity)
      ?? Math.max(0, originalQuantity - Math.min(originalQuantity, reportedNetQuantity ?? originalQuantity)),
  );
  return {
    originalQuantity,
    correctedQuantity,
    netQuantity: originalQuantity - correctedQuantity,
    correctionCount: nonNegativeInteger(receipt.correctionCount) ?? 0,
  };
}

export type ReceiptCorrectionDraftResult = {
  ok: true;
  reason: string;
  lines: Array<{ purchaseReceiptLineId: string; quantity: number }>;
} | {
  ok: false;
  message: string;
};

export function validateReceiptCorrectionDraft(input: {
  reason: string;
  availableLines: ReceiptCorrectionAvailability[];
  selectedLineIds: Iterable<string>;
  quantities: Record<string, unknown>;
}): ReceiptCorrectionDraftResult {
  const reason = input.reason.trim();
  if (reason.length < 2) {
    return { ok: false, message: '请填写至少 2 个字的冲正原因' };
  }
  const selected = new Set(input.selectedLineIds);
  if (selected.size === 0) {
    return { ok: false, message: '请至少勾选一条需要冲正的到货明细' };
  }
  const availabilityById = new Map(input.availableLines.map((line) => [line.id, line]));
  const lines: Array<{ purchaseReceiptLineId: string; quantity: number }> = [];
  for (const lineId of selected) {
    const available = availabilityById.get(lineId);
    if (!available || available.remainingQuantity <= 0) {
      return { ok: false, message: '所选到货明细已经没有可冲正数量，请刷新后重试' };
    }
    const quantity = numericInteger(input.quantities[lineId]);
    if (quantity === null || quantity <= 0) {
      return { ok: false, message: '冲正数量必须填写正整数' };
    }
    if (quantity > available.remainingQuantity) {
      return { ok: false, message: `冲正数量不能超过该行剩余可冲正的 ${available.remainingQuantity} 件` };
    }
    lines.push({ purchaseReceiptLineId: lineId, quantity });
  }
  return { ok: true, reason, lines };
}

function nonNegativeInteger(value: unknown) {
  return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function numericInteger(value: unknown) {
  if (typeof value === 'number') return Number.isInteger(value) ? value : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}
