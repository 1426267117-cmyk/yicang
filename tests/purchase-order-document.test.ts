import { describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({ env: {} }));

import type { UserContext } from '../lib/db';
import { HttpError } from '../lib/db';
import { ROLE_PERMISSIONS } from '../lib/domain';
import {
  buildPurchaseOrderDocument,
  loadPurchaseOrderDocument,
  purchaseOrderDocumentFileName,
  renderPurchaseOrderCsv,
  renderPurchaseOrderHtml,
} from '../lib/purchase-order-document';
import type { getPurchaseOrder } from '../lib/purchase-order-service';

type SourceOrder = Awaited<ReturnType<typeof getPurchaseOrder>>;

const viewer: UserContext = {
  id: 'viewer-auth',
  email: 'viewer@example.invalid',
  displayName: '采购查看员',
  role: 'viewer',
  permissions: ROLE_PERMISSIONS.viewer,
  tenantId: 'tenant-a',
  tenantName: '采购工作区',
};

describe('采购单交付文档', () => {
  it('打印件和 CSV 使用单据保存的定制信息，并支持未选供应商的草稿', () => {
    const original = sourceOrder();
    const document = buildPurchaseOrderDocument(sourceOrder({
      status: 'draft', supplier: null, issuedAt: null,
      lines: [
        { ...original.lines[0], productDetails: {
          name: '定制桌 & 配件', specification: '=定制规格 <加固>', dimensions: '120 × 60 cm',
          description: '配件与装配说明 <防夹手>',
          imageUrl: 'https://example.invalid/product.png?size=100&kind=custom',
        } },
        { ...original.lines[1], productDetails: {
          name: null, specification: null, dimensions: null, imageUrl: 'javascript:alert(1)',
        } },
      ],
    }));

    const html = renderPurchaseOrderHtml(document);
    expect(html).toContain('供应商</span><strong>未填写');
    expect(html).toContain('定制桌 &amp; 配件');
    expect(html).toContain('规格：=定制规格 &lt;加固&gt;');
    expect(html).toContain('尺寸：120 × 60 cm');
    expect(html).toContain('介绍：配件与装配说明 &lt;防夹手&gt;');
    expect(html).toContain('src="https://example.invalid/product.png?size=100&amp;kind=custom"');
    expect(html).not.toContain('javascript:');

    const csv = renderPurchaseOrderCsv(document);
    expect(csv).toContain('规格,尺寸,图片链接,商品介绍');
    expect(csv).toContain("'=定制规格 <加固>,120 × 60 cm,https://example.invalid/product.png");
    expect(csv).not.toContain('javascript:');
  });

  it('只以当前用户租户读取采购单，并允许只读角色下载', async () => {
    const loader = vi.fn(async (_db: D1Database, tenantId: string, purchaseOrderId: string) => {
      expect(tenantId).toBe('tenant-a');
      expect(purchaseOrderId).toBe('po-1');
      return sourceOrder();
    });

    const result = await loadPurchaseOrderDocument(
      {} as D1Database,
      viewer,
      ' po-1 ',
      loader,
    );

    expect(loader).toHaveBeenCalledOnce();
    expect(result.totalAmountMinor).toBe(3218);
    expect(result.costComplete).toBe(true);
    expect(result.lines.map((line) => line.lineAmountMinor)).toEqual([2468, 750]);
  });

  it('无采购读取权限时在查询数据库前拒绝', async () => {
    const loader = vi.fn(async () => sourceOrder());
    const unauthorized: UserContext = { ...viewer, permissions: [] };

    await expect(loadPurchaseOrderDocument(
      {} as D1Database,
      unauthorized,
      'po-1',
      loader,
    )).rejects.toMatchObject({ status: 403, code: 'PERMISSION_DENIED' });
    expect(loader).not.toHaveBeenCalled();
  });

  it('不能用其他租户的采购单标识越权读取', async () => {
    const loader = vi.fn(async (_db: D1Database, tenantId: string) => {
      if (tenantId !== 'tenant-b') {
        throw new HttpError(404, '采购单不存在或不在当前数据范围内', 'PURCHASE_ORDER_NOT_FOUND');
      }
      return sourceOrder();
    });

    await expect(loadPurchaseOrderDocument(
      {} as D1Database,
      viewer,
      'po-from-tenant-b',
      loader,
    )).rejects.toMatchObject({ status: 404, code: 'PURCHASE_ORDER_NOT_FOUND' });
    expect(loader).toHaveBeenCalledWith(expect.anything(), 'tenant-a', 'po-from-tenant-b');
  });

  it('打印 HTML 转义供应商、SKU、商品和备注，不输出客户或凭证字段', () => {
    const order = sourceOrder({
      supplier: {
        id: 'supplier-1',
        code: 'SUP<&>',
        name: '<script>alert(1)</script>',
        contactName: '<img src=x onerror=alert(2)>',
        contactPhone: '010<&>',
        contactEmail: 'buyer<&>@example.invalid',
        address: '<svg onload=alert(3)>',
      },
      deliveryWarehouse: {
        id: 'warehouse-1',
        code: 'WH<&>',
        name: '华南<script>仓',
        contactName: '收货人<&>',
        contactPhone: '020<&>',
        address: '<iframe src=bad>',
      },
      paymentTerms: '月结 < 30 天',
      tradeTerms: 'FOB & 深圳',
      note: '交期 < 7 天 & 不得替换',
      lines: [{ ...sourceOrder().lines[0], skuCode: '<img src=x>', skuName: '桌子 & "椅子"' }],
      lineCount: 1,
      orderedQuantity: 2,
      receivedQuantity: 1,
    });
    const html = renderPurchaseOrderHtml(buildPurchaseOrderDocument(order));

    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;img src=x&gt;');
    expect(html).toContain('桌子 &amp; &quot;椅子&quot;');
    expect(html).toContain('交期 &lt; 7 天 &amp; 不得替换');
    expect(html).toContain('&lt;img src=x onerror=alert(2)&gt;');
    expect(html).toContain('&lt;iframe src=bad&gt;');
    expect(html).toContain('月结 &lt; 30 天');
    expect(html).toContain('FOB &amp; 深圳');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toMatch(/customer|token|credential/i);
  });

  it('CSV 防止公式注入并保留最小货币单位和准确合计', () => {
    const order = sourceOrder({
      supplier: {
        id: 'supplier-1',
        code: '=2+2',
        name: '  +SUM(A1:A2)',
        contactName: '@联系人',
        contactPhone: '+8613800000000',
        contactEmail: '=FORMULA@example.invalid',
        address: '-危险地址',
      },
      deliveryWarehouse: {
        id: 'warehouse-1',
        code: '=WH',
        name: '+仓库',
        contactName: '@收货人',
        contactPhone: '-020',
        address: '=危险收货地址',
      },
      paymentTerms: '=付款公式',
      tradeTerms: '+贸易公式',
      note: '\t@危险公式',
      lines: [
        { ...sourceOrder().lines[0], skuCode: '-SKU', skuName: '=HYPERLINK("bad")' },
        sourceOrder().lines[1],
      ],
    });
    const csv = renderPurchaseOrderCsv(buildPurchaseOrderDocument(order));

    expect(csv).toContain("'=2+2");
    expect(csv).toContain("'  +SUM(A1:A2)");
    expect(csv).toContain("'\t@危险公式");
    expect(csv).toContain("'-SKU");
    expect(csv).toContain("'=HYPERLINK(");
    expect(csv).toContain("'@联系人");
    expect(csv).toContain("'=危险收货地址");
    expect(csv).toContain("'=付款公式");
    expect(csv).toContain("'+贸易公式");
    expect(csv).toContain('1234,2468,CNY');
    expect(csv).toContain('250,750,CNY');
    expect(csv).toContain('合计,,,5,1,4,,3218,CNY');
  });

  it.each([
    { status: 'draft', title: '采购单草稿', notice: '待确认下单，仅供核对。' },
    { status: 'cancelled', title: '已取消采购单', notice: '采购单已取消，仅供历史查阅。' },
  ] as const)('在打印件和 CSV 标注 $status 的核对用途', ({ status, title, notice }) => {
    const document = buildPurchaseOrderDocument(sourceOrder({ status, issuedAt: null }));
    const html = renderPurchaseOrderHtml(document);

    expect(html).toContain(`<title>${document.orderNo} · ${title}</title>`);
    expect(html).toContain(`<p class="review-only">${notice}</p>`);
    expect(html).not.toContain('正式采购单');
    expect(renderPurchaseOrderCsv(document)).toContain(`单据用途,${notice}`);
  });

  it.each(['issued', 'received'] as const)('为 %s 采购单保留正式打印与 CSV', (status) => {
    const document = buildPurchaseOrderDocument(sourceOrder({ status }));
    const html = renderPurchaseOrderHtml(document);

    expect(html).toContain('易仓 ERP · 正式采购单');
    expect(html).not.toContain('class="review-only"');
    expect(renderPurchaseOrderCsv(document)).not.toContain('单据用途');
  });

  it('任一行缺少单价或币种不一致时保持总额未知，不按 0 合计', () => {
    const missingCost = sourceOrder({
      lines: [sourceOrder().lines[0], { ...sourceOrder().lines[1], unitCostMinor: null }],
    });
    const document = buildPurchaseOrderDocument(missingCost);

    expect(document.costComplete).toBe(false);
    expect(document.totalAmountMinor).toBeNull();
    expect(renderPurchaseOrderHtml(document)).toContain('待补齐全部单价后计算');
    expect(renderPurchaseOrderCsv(document)).toContain('合计,,,5,1,4,,,CNY');
  });

  it('未提供联系人、收货仓和条款时明确显示未填写，不伪装成 0', () => {
    const order = sourceOrder({
      supplier: {
        id: 'supplier-1', code: 'SUP-01', name: '测试供应商',
        contactName: null, contactPhone: null, contactEmail: null, address: null,
      },
      deliveryWarehouse: null,
      expectedDeliveryAt: null,
      paymentTerms: null,
      tradeTerms: null,
    });
    const document = buildPurchaseOrderDocument(order);
    const html = renderPurchaseOrderHtml(document);
    const csv = renderPurchaseOrderCsv(document);

    expect(html).toContain('<span>收货仓库</span><strong>未填写</strong>');
    expect(html).toContain('<span>付款条款</span><strong>未填写</strong>');
    expect(csv).toContain('预计交期,未填写');
    expect(csv).toContain('贸易条款,未填写');
    expect(csv).not.toContain('预计交期,0');
  });

  it('金额乘法超过安全整数范围时不输出不准确的行金额或合计', () => {
    const unsafeAmount = sourceOrder({
      lines: [{
        ...sourceOrder().lines[0],
        orderedQuantity: Number.MAX_SAFE_INTEGER,
        unitCostMinor: 2,
      }],
      lineCount: 1,
      orderedQuantity: Number.MAX_SAFE_INTEGER,
    });
    const document = buildPurchaseOrderDocument(unsafeAmount);

    expect(document.lines[0].lineAmountMinor).toBeNull();
    expect(document.costComplete).toBe(false);
    expect(document.totalAmountMinor).toBeNull();
  });

  it('下载文件名仅保留安全字符', () => {
    expect(purchaseOrderDocumentFileName('../采购单 <01>', 'csv')).toBe('01.csv');
    expect(purchaseOrderDocumentFileName('***', 'html')).toBe('purchase-order.html');
  });
});

function sourceOrder(overrides: Partial<SourceOrder> = {}): SourceOrder {
  return {
    id: 'po-1',
    orderNo: 'CGD261102-TEST',
    purchaseRequestId: 'request-1',
    purchaseRequestNo: 'CG261102-TEST',
    purchaserMemberId: 'member-buyer',
    supplier: {
      id: 'supplier-1',
      code: 'SUP-01',
      name: '测试供应商',
      contactName: '王供应商',
      contactPhone: '13800000000',
      contactEmail: 'supplier@example.invalid',
      address: '佛山市供应商路 8 号',
    },
    deliveryWarehouse: {
      id: 'warehouse-1',
      code: 'MAIN',
      name: '主仓',
      contactName: '仓库收货员',
      contactPhone: '020-12345678',
      address: '深圳市测试路 1 号',
    },
    expectedDeliveryAt: '2026-11-12',
    paymentTerms: '月结 30 天',
    tradeTerms: 'FOB 深圳',
    status: 'issued',
    currency: 'CNY',
    note: '按确认样品采购',
    actionNote: '已发给供应商',
    version: 2,
    lineCount: 2,
    orderedQuantity: 5,
    receivedQuantity: 1,
    issuedAt: '2026-11-02T08:30:00.000Z',
    closedAt: null,
    cancelledAt: null,
    createdAt: '2026-11-02T08:00:00.000Z',
    updatedAt: '2026-11-02T09:00:00.000Z',
    lines: [
      {
        id: 'line-1',
        purchaseRequestLineId: 'request-line-1',
        skuId: 'sku-1',
        skuCode: 'SKU-001',
        skuName: '户外桌',
        orderedQuantity: 2,
        receivedQuantity: 1,
        remainingQuantity: 1,
        unitCostMinor: 1234,
        currency: 'CNY',
      },
      {
        id: 'line-2',
        purchaseRequestLineId: 'request-line-2',
        skuId: 'sku-2',
        skuCode: 'SKU-002',
        skuName: '户外椅',
        orderedQuantity: 3,
        receivedQuantity: 0,
        remainingQuantity: 3,
        unitCostMinor: 250,
        currency: 'CNY',
      },
    ],
    ...overrides,
  };
}
