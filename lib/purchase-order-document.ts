import { HttpError, requirePermission, type UserContext } from './db';
import { getPurchaseOrder } from './purchase-order-service';
import { safePurchaseProductImageUrl } from './purchase-product-details';

type PurchaseOrder = Awaited<ReturnType<typeof getPurchaseOrder>>;

const reviewOnlyDocuments: Partial<Record<PurchaseOrder['status'], { title: string; notice: string }>> = {
  draft: { title: '采购单草稿', notice: '待确认下单，仅供核对。' },
  cancelled: { title: '已取消采购单', notice: '采购单已取消，仅供历史查阅。' },
};

export type PurchaseOrderDocument = Omit<PurchaseOrder, 'lines'> & {
  costComplete: boolean;
  totalAmountMinor: number | null;
  lines: Array<PurchaseOrder['lines'][number] & {
    lineAmountMinor: number | null;
  }>;
};

type PurchaseOrderLoader = (
  db: D1Database,
  tenantId: string,
  purchaseOrderId: string,
) => Promise<PurchaseOrder>;

export async function loadPurchaseOrderDocument(
  db: D1Database,
  user: UserContext,
  purchaseOrderId: string,
  loadOrder: PurchaseOrderLoader = getPurchaseOrder,
): Promise<PurchaseOrderDocument> {
  requirePermission(user, 'purchase:read');
  const normalizedId = purchaseOrderId.trim();
  if (!normalizedId) {
    throw new HttpError(400, '采购单标识不能为空', 'INVALID_PURCHASE_ORDER_ID');
  }
  const order = await loadOrder(db, user.tenantId, normalizedId);
  return buildPurchaseOrderDocument(order);
}

export function buildPurchaseOrderDocument(order: PurchaseOrder): PurchaseOrderDocument {
  let costComplete = Boolean(order.currency) && order.lines.length > 0;
  let totalAmountMinor = 0;
  const lines: PurchaseOrderDocument['lines'] = order.lines.map((line) => {
    const sameCurrency = Boolean(order.currency && line.currency === order.currency);
    const lineAmountMinor: number | null = sameCurrency && line.unitCostMinor !== null
      ? safeMultiply(line.unitCostMinor, line.orderedQuantity)
      : null;
    if (lineAmountMinor === null) {
      costComplete = false;
    } else {
      const nextTotal = safeAdd(totalAmountMinor, lineAmountMinor);
      if (nextTotal === null) {
        costComplete = false;
      } else {
        totalAmountMinor = nextTotal;
      }
    }
    return { ...line, lineAmountMinor };
  });
  return {
    ...order,
    lines,
    costComplete,
    totalAmountMinor: costComplete ? totalAmountMinor : null,
  };
}

export function renderPurchaseOrderHtml(order: PurchaseOrderDocument) {
  const status = statusLabel(order.status);
  const reviewOnly = reviewOnlyDocuments[order.status];
  const total = order.totalAmountMinor === null
    ? '待补齐全部单价后计算'
    : formatMinor(order.totalAmountMinor, order.currency);
  const rows = order.lines.map((line, index) => `
        <tr>
          <td>${index + 1}</td>
          <td><strong>${escapeHtml(line.skuCode)}</strong></td>
          <td>${renderProductDetails(line)}</td>
          <td class="number">${line.orderedQuantity}</td>
          <td class="number">${line.receivedQuantity}</td>
          <td class="number">${line.unitCostMinor === null ? '待补齐' : escapeHtml(formatMinor(line.unitCostMinor, line.currency ?? order.currency))}</td>
          <td class="number">${line.lineAmountMinor === null ? '待补齐' : escapeHtml(formatMinor(line.lineAmountMinor, line.currency ?? order.currency))}</td>
        </tr>`).join('');
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(order.orderNo)} · ${reviewOnly?.title ?? '采购单'}</title>
  <style>
    :root{color-scheme:light;font-family:"Microsoft YaHei","PingFang SC",Arial,sans-serif;color:#17231f;background:#f4f7f5}
    *{box-sizing:border-box}body{margin:0;padding:28px}.sheet{max-width:1080px;margin:auto;padding:42px;background:#fff;border:1px solid #dfe8e3;border-radius:14px;box-shadow:0 12px 36px rgba(24,55,44,.08)}
    header{display:flex;justify-content:space-between;gap:24px;border-bottom:2px solid #176d53;padding-bottom:22px}h1{margin:4px 0 0;font-size:28px}header p{margin:0;color:#65746e}.badge{align-self:flex-start;padding:7px 12px;border-radius:999px;background:#e8f5ef;color:#176d53;font-weight:700}
    .review-only{margin:18px 0 0;padding:11px 14px;border:1px solid #d8b573;border-left-width:4px;border-radius:6px;color:#5d3c0a;font-weight:700}
    .product-main{display:flex;align-items:flex-start;gap:10px;overflow-wrap:anywhere}.product-main img{width:64px;height:64px;object-fit:contain;border-radius:4px}.product-detail{display:block;margin-top:5px;color:#465852;white-space:pre-wrap}
    .meta{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px 26px;margin:24px 0}.meta div{border-bottom:1px solid #e7edea;padding:8px 0}.meta span{display:block;color:#75827d;font-size:12px}.meta strong{display:block;margin-top:4px;overflow-wrap:anywhere}
    table{width:100%;border-collapse:collapse;margin-top:18px;font-size:13px}th,td{border:1px solid #dce5e1;padding:10px;vertical-align:top}th{background:#edf6f2;text-align:left}.number{text-align:right;white-space:nowrap}.total{display:flex;justify-content:flex-end;gap:24px;margin-top:18px;font-size:18px}.total strong{min-width:190px;text-align:right}.note{margin-top:24px;padding:14px 16px;background:#f6f8f7;border-radius:8px;white-space:pre-wrap;overflow-wrap:anywhere}.foot{margin-top:28px;color:#74817b;font-size:11px}.actions{max-width:1080px;margin:0 auto 14px;text-align:right}.actions button{border:0;border-radius:8px;background:#176d53;color:#fff;padding:10px 18px;font-weight:700;cursor:pointer}
    @media(max-width:720px){body{padding:10px}.sheet{padding:20px}.meta{grid-template-columns:1fr}header{display:block}.badge{display:inline-block;margin-top:12px}.table-wrap{overflow:auto}}
    @media print{body{padding:0;background:#fff}.actions{display:none}.sheet{max-width:none;border:0;border-radius:0;box-shadow:none;padding:0}@page{size:A4 landscape;margin:12mm}}
  </style>
</head>
<body>
  <div class="actions"><button type="button" onclick="window.print()">打印 / 保存 PDF</button></div>
  <main class="sheet">
    <header><div><p>易仓 ERP · ${reviewOnly?.title ?? '正式采购单'}</p><h1>${escapeHtml(order.orderNo)}</h1></div><span class="badge">${escapeHtml(status)}</span></header>
    ${reviewOnly ? `<p class="review-only">${reviewOnly.notice}</p>` : ''}
    <section class="meta">
      <div><span>供应商</span><strong>${escapeHtml(order.supplier ? `${order.supplier.name}（${order.supplier.code}）` : '未填写')}</strong></div>
      <div><span>供应商联系人</span><strong>${escapeHtml(displayValue(order.supplier?.contactName))}</strong></div>
      <div><span>供应商电话</span><strong>${escapeHtml(displayValue(order.supplier?.contactPhone))}</strong></div>
      <div><span>供应商邮箱</span><strong>${escapeHtml(displayValue(order.supplier?.contactEmail))}</strong></div>
      <div><span>供应商地址</span><strong>${escapeHtml(displayValue(order.supplier?.address))}</strong></div>
      <div><span>收货仓库</span><strong>${escapeHtml(order.deliveryWarehouse
        ? `${displayValue(order.deliveryWarehouse.name)}（${displayValue(order.deliveryWarehouse.code)}）`
        : '未填写')}</strong></div>
      <div><span>收货联系人</span><strong>${escapeHtml(displayValue(order.deliveryWarehouse?.contactName))}</strong></div>
      <div><span>收货电话</span><strong>${escapeHtml(displayValue(order.deliveryWarehouse?.contactPhone))}</strong></div>
      <div><span>完整收货地址</span><strong>${escapeHtml(displayValue(order.deliveryWarehouse?.address))}</strong></div>
      <div><span>预计交期</span><strong>${escapeHtml(formatExpectedDelivery(order.expectedDeliveryAt))}</strong></div>
      <div><span>付款条款</span><strong>${escapeHtml(displayValue(order.paymentTerms))}</strong></div>
      <div><span>贸易条款</span><strong>${escapeHtml(displayValue(order.tradeTerms))}</strong></div>
      <div><span>来源申请单</span><strong>${escapeHtml(order.purchaseRequestNo)}</strong></div>
      <div><span>币种</span><strong>${escapeHtml(order.currency ?? '未指定')}</strong></div>
      <div><span>创建时间（UTC）</span><strong>${escapeHtml(formatTimestamp(order.createdAt))}</strong></div>
      <div><span>确认下单时间（UTC）</span><strong>${escapeHtml(formatTimestamp(order.issuedAt))}</strong></div>
      <div><span>最后更新（UTC）</span><strong>${escapeHtml(formatTimestamp(order.updatedAt))}</strong></div>
    </section>
    <div class="table-wrap"><table>
      <thead><tr><th>#</th><th>SKU</th><th>商品</th><th class="number">采购数量</th><th class="number">已到数量</th><th class="number">采购单价</th><th class="number">行金额</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <div class="total"><span>采购单总额</span><strong>${escapeHtml(total)}</strong></div>
    <section class="note"><strong>采购备注</strong>\n${escapeHtml(order.note ?? '无')}</section>
    <p class="foot">采购单历史与状态以 ERP 数据库为准。金额缺失时显示“待补齐”。</p>
  </main>
</body>
</html>`;
}

export function renderPurchaseOrderCsv(order: PurchaseOrderDocument) {
  const reviewOnly = reviewOnlyDocuments[order.status];
  const hasProductDetails = order.lines.some(({ productDetails }) => Boolean(
    productDetails?.specification || productDetails?.dimensions || safePurchaseProductImageUrl(productDetails?.imageUrl),
  ));
  const hasDescription = order.lines.some(({ productDetails }) => Boolean(productDetails?.description));
  const rows: Array<Array<string | number>> = [
    ['采购单号', spreadsheetText(order.orderNo)],
    ['状态', statusLabel(order.status)],
    ...(reviewOnly ? [['单据用途', reviewOnly.notice]] : []),
    ['供应商编码', spreadsheetText(displayValue(order.supplier?.code))],
    ['供应商名称', spreadsheetText(displayValue(order.supplier?.name))],
    ['供应商联系人', spreadsheetText(displayValue(order.supplier?.contactName))],
    ['供应商电话', spreadsheetText(displayValue(order.supplier?.contactPhone))],
    ['供应商邮箱', spreadsheetText(displayValue(order.supplier?.contactEmail))],
    ['供应商地址', spreadsheetText(displayValue(order.supplier?.address))],
    ['收货仓库编码', spreadsheetText(displayValue(order.deliveryWarehouse?.code))],
    ['收货仓库名称', spreadsheetText(displayValue(order.deliveryWarehouse?.name))],
    ['收货联系人', spreadsheetText(displayValue(order.deliveryWarehouse?.contactName))],
    ['收货电话', spreadsheetText(displayValue(order.deliveryWarehouse?.contactPhone))],
    ['完整收货地址', spreadsheetText(displayValue(order.deliveryWarehouse?.address))],
    ['预计交期', spreadsheetText(formatExpectedDelivery(order.expectedDeliveryAt))],
    ['付款条款', spreadsheetText(displayValue(order.paymentTerms))],
    ['贸易条款', spreadsheetText(displayValue(order.tradeTerms))],
    ['来源申请单', spreadsheetText(order.purchaseRequestNo)],
    ['币种', spreadsheetText(order.currency ?? '')],
    ['创建时间（UTC）', formatTimestamp(order.createdAt)],
    ['确认下单时间（UTC）', formatTimestamp(order.issuedAt)],
    ['采购备注', spreadsheetText(order.note ?? '')],
    [],
    ['序号', 'SKU', '商品名称', '采购数量', '已到数量', '未到数量', '单价（最小货币单位）', '行金额（最小货币单位）', '币种',
      ...(hasProductDetails ? ['规格', '尺寸', '图片链接'] : []), ...(hasDescription ? ['商品介绍'] : [])],
    ...order.lines.map((line, index) => [
      index + 1,
      spreadsheetText(line.skuCode),
      spreadsheetText(line.productDetails?.name || line.skuName),
      line.orderedQuantity,
      line.receivedQuantity,
      line.remainingQuantity,
      line.unitCostMinor ?? '',
      line.lineAmountMinor ?? '',
      spreadsheetText(line.currency ?? order.currency ?? ''),
      ...(hasProductDetails ? [
        line.productDetails?.specification ?? '',
        line.productDetails?.dimensions ?? '',
        safePurchaseProductImageUrl(line.productDetails?.imageUrl) ?? '',
      ] : []),
      ...(hasDescription ? [line.productDetails?.description ?? ''] : []),
    ]),
    [],
    ['合计', '', '', order.orderedQuantity, order.receivedQuantity, Math.max(0, order.orderedQuantity - order.receivedQuantity), '', order.totalAmountMinor ?? '', spreadsheetText(order.currency ?? '')],
  ];
  return rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
}

function renderProductDetails(line: PurchaseOrderDocument['lines'][number]) {
  const details = line.productDetails;
  const name = escapeHtml(details?.name || line.skuName);
  const image = safePurchaseProductImageUrl(details?.imageUrl);
  const specification = details?.specification
    ? `<span class="product-detail">规格：${escapeHtml(details.specification)}</span>` : '';
  const dimensions = details?.dimensions
    ? `<span class="product-detail">尺寸：${escapeHtml(details.dimensions)}</span>` : '';
  const description = details?.description
    ? `<span class="product-detail">介绍：${escapeHtml(details.description)}</span>` : '';
  if (!image && !specification && !dimensions && !description) return name;
  return `<div class="product-main">${image ? `<img src="${escapeHtml(image)}" alt="${name}" width="64" height="64" referrerpolicy="no-referrer">` : ''}
    <div>${name}${specification}${dimensions}${description}</div></div>`;
}

export function purchaseOrderDocumentFileName(orderNo: string, extension: 'html' | 'csv') {
  const safeOrderNo = orderNo
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '') || 'purchase-order';
  return `${safeOrderNo}.${extension}`;
}

function safeMultiply(left: number, right: number): number | null {
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right)) return null;
  const value = left * right;
  return Number.isSafeInteger(value) ? value : null;
}

function safeAdd(left: number, right: number): number | null {
  const value = left + right;
  return Number.isSafeInteger(value) ? value : null;
}

function formatMinor(amountMinor: number, currency: string | null) {
  const sign = amountMinor < 0 ? '-' : '';
  const absolute = Math.abs(amountMinor);
  const major = Math.floor(absolute / 100);
  const minor = String(absolute % 100).padStart(2, '0');
  return `${currency ?? '币种未指定'} ${sign}${major}.${minor}`;
}

function formatTimestamp(value: string | null) {
  if (!value) return '—';
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : value;
}

function formatExpectedDelivery(value: string | null) {
  if (!value) return '未填写';
  return /^\d{4}-\d{2}-\d{2}$/u.test(value) ? value : formatTimestamp(value);
}

function displayValue(value: string | null | undefined) {
  return value || '未填写';
}

function statusLabel(status: PurchaseOrder['status']) {
  return ({
    draft: '草稿',
    issued: '已确认下单',
    partially_received: '部分到货',
    received: '已全部到货',
    closed_short: '短到关闭',
    cancelled: '已取消',
  } as const)[status];
}

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function spreadsheetText(value: string) {
  const formulaAfterLeadingWhitespace = /^\s*[=+\-@]/u.test(value);
  const leadingControlCharacter = /^[\t\r\n]/u.test(value);
  return formulaAfterLeadingWhitespace || leadingControlCharacter ? `'${value}` : value;
}

function csvCell(value: string | number) {
  const text = typeof value === 'string' ? spreadsheetText(value) : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
