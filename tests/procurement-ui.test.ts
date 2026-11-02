import { describe, expect, it } from 'vitest';
import { activePurchaseRequestIds } from '../lib/procurement-ui';

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

  it('草稿、已下单、部分到货和已收货都视为有效采购单', () => {
    const ids = activePurchaseRequestIds([
      { purchaseRequestId: 'draft', status: 'draft' },
      { purchaseRequestId: 'issued', status: 'issued' },
      { purchaseRequestId: 'partial', status: 'partially_received' },
      { purchaseRequestId: 'received', status: 'received' },
      { purchaseRequestId: 'cancelled', status: 'cancelled' },
    ]);

    expect([...ids]).toEqual(['draft', 'issued', 'partial', 'received']);
  });
});
