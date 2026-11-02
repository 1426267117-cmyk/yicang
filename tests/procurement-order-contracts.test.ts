import { describe, expect, it } from 'vitest';

import {
  createPurchaseOrderSchema,
  createSupplierSchema,
  createWarehouseSchema,
} from '../lib/contracts';

describe('采购对外下单字段契约', () => {
  it('接受日期或带时区的预计交期，并保留可选条款', () => {
    expect(createPurchaseOrderSchema.safeParse({
      purchaseRequestId: 'request-1',
      supplierId: 'supplier-1',
      deliveryWarehouseId: 'warehouse-1',
      expectedDeliveryAt: '2026-11-15',
      paymentTerms: '月结 30 天',
      tradeTerms: 'FOB 深圳',
    }).success).toBe(true);
    expect(createPurchaseOrderSchema.safeParse({
      purchaseRequestId: 'request-1',
      supplierId: 'supplier-1',
      expectedDeliveryAt: '2026-11-15T16:30:00+08:00',
    }).success).toBe(true);
  });

  it('拒绝没有时区的时间和格式错误的供应商邮箱', () => {
    expect(createPurchaseOrderSchema.safeParse({
      purchaseRequestId: 'request-1',
      supplierId: 'supplier-1',
      expectedDeliveryAt: '2026-11-15T16:30:00',
    }).success).toBe(false);
    expect(createSupplierSchema.safeParse({
      code: 'SUP-01',
      name: '测试供应商',
      contactEmail: 'not-an-email',
    }).success).toBe(false);
  });

  it('联系人和地址都保持可选，兼容既有创建请求', () => {
    expect(createSupplierSchema.safeParse({ code: 'SUP-01', name: '测试供应商' }).success).toBe(true);
    expect(createWarehouseSchema.safeParse({ code: 'MAIN', name: '主仓' }).success).toBe(true);
  });
});
