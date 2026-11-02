import { describe, expect, it } from 'vitest';
import {
  activePurchaseRequestIds,
  assignmentActionAllowed,
  normalizedReceiptQuantities,
  purchaseOrderCompletion,
  receiptCorrectionAvailability,
  validateReceiptCorrectionDraft,
} from '../lib/procurement-ui';

describe('采购工作台展示规则', () => {
  it('用全量采购单判断申请是否已转单，不受当前搜索结果影响', () => {
    const fullOrders = [
      { purchaseRequestId: 'request-existing', status: 'issued' },
      { purchaseRequestId: 'request-cancelled', status: 'cancelled' },
    ];
    const searchFilteredOrders: typeof fullOrders = [];

    expect(activePurchaseRequestIds(fullOrders)).toEqual(new Set(['request-existing']));
    expect(activePurchaseRequestIds(searchFilteredOrders)).toEqual(new Set());
  });

  it('草稿、已下单、部分到货、已收货和短到关闭都视为已有采购单', () => {
    const ids = activePurchaseRequestIds([
      { purchaseRequestId: 'draft', status: 'draft' },
      { purchaseRequestId: 'issued', status: 'issued' },
      { purchaseRequestId: 'partial', status: 'partially_received' },
      { purchaseRequestId: 'received', status: 'received' },
      { purchaseRequestId: 'closed-short', status: 'closed_short' },
      { purchaseRequestId: 'cancelled', status: 'cancelled' },
    ]);

    expect([...ids]).toEqual(['draft', 'issued', 'partial', 'received', 'closed-short']);
  });

  it('开发开放模式允许换账号继续已分配流程，正式模式仍限指定成员', () => {
    expect(assignmentActionAllowed(false, true)).toBe(true);
    expect(assignmentActionAllowed(true, false)).toBe(true);
    expect(assignmentActionAllowed(false, false)).toBe(false);
  });

  it('正式下单只在收货仓、交期、币种和全部单价完整时就绪', () => {
    const complete = purchaseOrderCompletion({
      deliveryWarehouse: { id: 'warehouse-main' },
      expectedDeliveryAt: '2026-11-30',
      currency: 'CNY',
      lines: [{ unitCostMinor: 1299, currency: 'CNY' }],
    });
    expect(complete).toEqual({ ready: true, missing: [] });

    const incomplete = purchaseOrderCompletion({
      deliveryWarehouse: null,
      expectedDeliveryAt: null,
      currency: null,
      lines: [{ unitCostMinor: null, currency: null }],
    });
    expect(incomplete).toEqual({
      ready: false,
      missing: ['收货仓库', '预计交期', '币种', '全部明细单价'],
    });
  });

  it('按历史冲正逐行计算剩余可冲正数量，不修改原收货数量', () => {
    const sourceLines = [
      { id: 'receipt-line-a', quantity: 5 },
      { id: 'receipt-line-b', quantity: 3 },
    ];
    const availability = receiptCorrectionAvailability(sourceLines, [
      { lines: [{ purchaseReceiptLineId: 'receipt-line-a', quantity: 2 }] },
      { lines: [
        { purchaseReceiptLineId: 'receipt-line-a', quantity: 1 },
        { purchaseReceiptLineId: 'receipt-line-b', quantity: 3 },
      ] },
    ]);

    expect(sourceLines).toEqual([
      { id: 'receipt-line-a', quantity: 5 },
      { id: 'receipt-line-b', quantity: 3 },
    ]);
    expect(availability).toEqual([
      expect.objectContaining({ id: 'receipt-line-a', quantity: 5, correctedQuantity: 3, remainingQuantity: 2 }),
      expect.objectContaining({ id: 'receipt-line-b', quantity: 3, correctedQuantity: 3, remainingQuantity: 0 }),
    ]);
  });

  it('兼容旧收货响应，并明确区分原收、冲正和净收', () => {
    expect(normalizedReceiptQuantities({ totalQuantity: 5 })).toEqual({
      originalQuantity: 5,
      correctedQuantity: 0,
      netQuantity: 5,
      correctionCount: 0,
    });
    expect(normalizedReceiptQuantities({
      totalQuantity: 5,
      originalQuantity: 5,
      correctedQuantity: 2,
      netQuantity: 3,
      correctionCount: 1,
    })).toEqual({
      originalQuantity: 5,
      correctedQuantity: 2,
      netQuantity: 3,
      correctionCount: 1,
    });
    expect(normalizedReceiptQuantities({
      totalQuantity: 5,
      originalQuantity: 5,
      correctedQuantity: 2,
      netQuantity: 5,
    }).netQuantity).toBe(3);
  });

  it('只提交已勾选、未超剩余量的正整数，并清理原因空白', () => {
    const result = validateReceiptCorrectionDraft({
      reason: '  仓库复核发现多录  ',
      availableLines: receiptCorrectionAvailability([
        { id: 'line-a', quantity: 5 },
        { id: 'line-b', quantity: 2 },
      ], [{ lines: [{ purchaseReceiptLineId: 'line-a', quantity: 2 }] }]),
      selectedLineIds: ['line-a'],
      quantities: { 'line-a': '3', 'line-b': '2' },
    });

    expect(result).toEqual({
      ok: true,
      reason: '仓库复核发现多录',
      lines: [{ purchaseReceiptLineId: 'line-a', quantity: 3 }],
    });
  });

  it.each([
    {
      title: '原因过短',
      input: { reason: ' ', selectedLineIds: ['line-a'], quantities: { 'line-a': '1' } },
      message: '请填写至少 2 个字的冲正原因',
    },
    {
      title: '未勾选明细',
      input: { reason: '数量多录', selectedLineIds: [], quantities: {} },
      message: '请至少勾选一条需要冲正的到货明细',
    },
    {
      title: '不是正整数',
      input: { reason: '数量多录', selectedLineIds: ['line-a'], quantities: { 'line-a': '1.5' } },
      message: '冲正数量必须填写正整数',
    },
    {
      title: '超过剩余量',
      input: { reason: '数量多录', selectedLineIds: ['line-a'], quantities: { 'line-a': '4' } },
      message: '冲正数量不能超过该行剩余可冲正的 3 件',
    },
  ])('$title 时阻止提交', ({ input, message }) => {
    const result = validateReceiptCorrectionDraft({
      ...input,
      availableLines: receiptCorrectionAvailability(
        [{ id: 'line-a', quantity: 5 }],
        [{ lines: [{ purchaseReceiptLineId: 'line-a', quantity: 2 }] }],
      ),
    });
    expect(result).toEqual({ ok: false, message });
  });
});
