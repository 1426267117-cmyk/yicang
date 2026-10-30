import { describe, expect, it } from 'vitest';
import { decimalToMinor, exactMoney, normalizeSku, sourceBusinessDate } from '../lib/connectors/canonical';
import { shopifyOrderFixture } from './fixtures/shopify-order';

describe('Shopify 精确字段映射', () => {
  it('保留零金额、未知值、原始 SKU 和店铺业务日', () => {
    const order = shopifyOrderFixture();
    expect(order.businessDate).toBe('2026-10-20');
    expect(order.lines[0].rawSku).toBe(' ABC-01 ');
    expect(order.lines[0].normalizedSku).toBe('ABC-01');
    expect(order.lines[1].unitPrice).toEqual({ amount: '0', currency: 'USD', minor: 0 });
    expect(order.lines[1].rawSku).toBeNull();
    expect(order.received).toBeNull();
  });

  it('退款对象、成功与失败交易、多包裹分别保留', () => {
    const order = shopifyOrderFixture();
    expect(order.refunds).toHaveLength(1);
    expect(order.refunds[0].lines).toHaveLength(1);
    expect(order.refunds[0].transactions.map((item) => item.status)).toEqual(['SUCCESS', 'FAILURE']);
    expect(order.fulfillments).toHaveLength(2);
    expect(order.fulfillments.flatMap((item) => item.tracking).map((item) => item.number)).toEqual(['1Z111', 'FX222']);
  });

  it('金额不用浮点累计，并在币种精度不确定时保持 minor 为 null', () => {
    expect(decimalToMinor('19.99', 'USD')).toBe(1999);
    expect(decimalToMinor('19.999', 'USD')).toBeNull();
    expect(decimalToMinor('19.99', 'ZZZ')).toBeNull();
    expect(exactMoney({ shopMoney: { amount: '-5.20', currencyCode: 'USD' } })).toEqual({
      amount: '-5.2', currency: 'USD', minor: -520,
    });
    expect(normalizeSku('  ab-c  ')).toBe('AB-C');
    expect(sourceBusinessDate('invalid', 'America/Los_Angeles')).toBeNull();
  });
});
