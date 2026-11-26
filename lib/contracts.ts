import { z } from 'zod';
import { safePurchaseProductImageUrl } from './purchase-product-details';

export const createOrderSchema = z.object({
  channel: z.enum(['Amazon US', 'Shopify', 'eBay DE', 'TikTok Shop']),
  destination: z.string().trim().min(1).max(40),
  customerName: z.string().trim().min(2).max(80),
  currency: z.enum(['CNY', 'USD', 'EUR', 'GBP']),
  amountMinor: z.number().int().positive().max(100_000_000),
  skuId: z.string().min(1),
  warehouseId: z.string().min(1),
  quantity: z.number().int().positive().max(999),
});

export const orderActionSchema = z.object({
  action: z.enum(['approve', 'ship', 'cancel']),
});

export const shopifyOrderSyncSchema = z.object({
  storeKey: z.enum(['zimasya', 'kaguyasu', 'anzhap', 'bizfurniz']),
  mode: z.enum(['backfill', 'incremental']).default('incremental'),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  maxPages: z.number().int().min(1).max(500).default(100),
}).superRefine((value, context) => {
  if (value.mode === 'backfill' && (!value.from || !value.to)) {
    context.addIssue({
      code: 'custom',
      message: '首次历史回补必须明确提供 from 和 to',
      path: ['from'],
    });
  }
  if (value.from && value.to && new Date(value.from) > new Date(value.to)) {
    context.addIssue({
      code: 'custom',
      message: 'from 不能晚于 to',
      path: ['from'],
    });
  }
});

export const shopifyWebhookProcessSchema = z.object({
  maxEvents: z.number().int().min(1).max(10).default(5),
});

export const createPurchaseRequestSchema = z.object({
  demandIds: z.array(z.string().trim().min(1)).min(1).max(100),
  purchaserMemberId: z.string().trim().min(1),
  reviewerMemberId: z.string().trim().min(1),
  note: z.string().trim().max(500).optional(),
}).superRefine((value, context) => {
  if (new Set(value.demandIds).size !== value.demandIds.length) {
    context.addIssue({ code: 'custom', message: '采购需求不能重复选择', path: ['demandIds'] });
  }
});

export const purchaseProductDetailsSchema = z.strictObject({
  name: z.string().trim().min(1).max(240).nullable().optional(),
  specification: z.string().trim().max(1000).nullable().optional(),
  dimensions: z.string().trim().max(240).nullable().optional(),
  description: z.string().trim().max(2000, '商品介绍不能超过 2000 个字符').nullable().optional(),
  imageUrl: z.string().trim().max(2048).refine(
    (value) => safePurchaseProductImageUrl(value) !== null,
    '请上传产品图片或填写有效的 HTTP 或 HTTPS 图片链接',
  ).nullable().optional(),
});

export const createManualPurchaseRequestSchema = z.strictObject({
  lines: z.array(z.strictObject({
    skuId: z.string().trim().min(1).max(160),
    quantity: z.number().int().positive().max(100_000_000),
    productDetails: purchaseProductDetailsSchema.optional(),
  })).min(1, '请至少添加一个 SKU').max(100),
  purchaserMemberId: z.string().trim().min(1).max(160),
  reviewerMemberId: z.string().trim().min(1).max(160),
  note: z.string().trim().min(1, '请填写采购原因或依据').max(500),
}).superRefine((input, context) => {
  if (new Set(input.lines.map((line) => line.skuId)).size !== input.lines.length) {
    context.addIssue({ code: 'custom', message: '采购申请中的 SKU 不能重复', path: ['lines'] });
  }
});

export const upsertMukuSkuMappingSchema = z.object({
  mukuSku: z.string().trim().min(1).max(240),
  skuId: z.string().trim().min(1),
});

export const upsertSkuProcurementPolicySchema = z.object({
  skuId: z.string().trim().min(1),
  safetyDays: z.number().int().min(0).max(365).optional(),
  safetyStockQty: z.number().int().min(0).max(100_000_000).nullable().optional(),
  moq: z.number().int().positive().max(100_000_000).nullable().optional(),
  packSize: z.number().int().positive().max(100_000_000).nullable().optional(),
  leadTimeDays: z.number().int().min(0).max(3650).nullable().optional(),
  preferredSupplierId: z.string().trim().min(1).nullable().optional(),
});

export const upsertSkuInventoryConfirmationSchema = z.object({
  skuId: z.string().trim().min(1),
  confirmedAvailableQty: z.number().int().min(0).max(100_000_000),
  note: z.string().trim().min(3).max(500),
});

const purchasePlanningSelectionSchema = z.object({
  planRowId: z.string().trim().min(1),
  recommendationVersion: z.string().trim().min(16).max(128),
});

export const createPlanningPurchaseRequestSchema = z.object({
  selections: z.array(purchasePlanningSelectionSchema).min(1).max(100),
  purchaserMemberId: z.string().trim().min(1),
  reviewerMemberId: z.string().trim().min(1),
  note: z.string().trim().max(500).optional(),
}).superRefine((value, context) => {
  const rowIds = value.selections.map((selection) => selection.planRowId);
  if (new Set(rowIds).size !== rowIds.length) {
    context.addIssue({ code: 'custom', message: '采购建议不能重复选择', path: ['selections'] });
  }
});

export const purchaseRequestActionSchema = z.object({
  action: z.enum(['submit', 'approve', 'reject', 'cancel', 'withdraw']),
  note: z.string().trim().max(500).optional(),
}).superRefine((value, context) => {
  if ((value.action === 'reject' || value.action === 'withdraw') && !value.note) {
    context.addIssue({
      code: 'custom',
      message: value.action === 'reject' ? '驳回采购申请时必须填写原因' : '撤回已批准申请时必须填写原因',
      path: ['note'],
    });
  }
});

export const createSupplierSchema = z.object({
  code: z.string().trim().min(1).max(40).transform((value) => value.toUpperCase()),
  name: z.string().trim().min(1).max(120),
  contactName: z.string().trim().max(120).optional(),
  contactPhone: z.string().trim().max(60).optional(),
  contactEmail: z.string().trim().max(254).refine(
    (value) => value === '' || z.email().safeParse(value).success,
    '邮箱格式不正确',
  ).optional(),
  address: z.string().trim().max(1000).optional(),
  note: z.string().trim().max(500).optional(),
});

export const createWarehouseSchema = z.object({
  code: z.string().trim().min(1).max(40).transform((value) => value.toUpperCase()),
  name: z.string().trim().min(1).max(120),
  contactName: z.string().trim().max(120).optional(),
  contactPhone: z.string().trim().max(60).optional(),
  address: z.string().trim().max(1000).optional(),
});

const purchaseOrderLineCostSchema = z.object({
  purchaseRequestLineId: z.string().trim().min(1),
  unitCostMinor: z.number().int().min(0).max(10_000_000_000).nullable().optional(),
  productDetails: purchaseProductDetailsSchema.optional(),
});

const purchaseOrderDeliveryDateSchema = z.union([z.iso.date(), z.iso.datetime({ offset: true })]);
const purchaseOrderCurrencySchema = z.string().trim().length(3).transform((value) => value.toUpperCase());
const purchaseOrderTermsFields = {
  paymentTerms: z.string().trim().max(500).optional(),
  tradeTerms: z.string().trim().max(500).optional(),
  note: z.string().trim().max(500).optional(),
};

export const createPurchaseOrderSchema = z.object({
  purchaseRequestId: z.string().trim().min(1),
  supplierId: z.string().trim().min(1).nullable().optional(),
  issue: z.boolean().optional(),
  deliveryWarehouseId: z.string().trim().min(1).nullable().optional(),
  expectedDeliveryAt: purchaseOrderDeliveryDateSchema.nullable().optional(),
  currency: purchaseOrderCurrencySchema.nullable().optional(),
  ...purchaseOrderTermsFields,
  lineCosts: z.array(purchaseOrderLineCostSchema).max(500).optional(),
}).superRefine((value, context) => {
  if (value.lineCosts?.some((line) => line.unitCostMinor != null) && !value.currency) {
    context.addIssue({ code: 'custom', message: '填写采购单价时必须指定币种', path: ['currency'] });
  }
  const lineIds = value.lineCosts?.map((line) => line.purchaseRequestLineId) ?? [];
  if (new Set(lineIds).size !== lineIds.length) {
    context.addIssue({ code: 'custom', message: '采购申请明细价格不能重复填写', path: ['lineCosts'] });
  }
});

export const updatePurchaseOrderDraftSchema = z.strictObject({
  expectedVersion: z.number().int().positive(),
  issue: z.boolean().optional(),
  supplierId: z.string().trim().min(1).nullable().optional(),
  deliveryWarehouseId: z.string().trim().min(1).nullable().optional(),
  expectedDeliveryAt: purchaseOrderDeliveryDateSchema.nullable().optional(),
  currency: purchaseOrderCurrencySchema.refine((value) => /^[A-Z]{3}$/u.test(value), '币种必须是三位字母').nullable().optional(),
  ...purchaseOrderTermsFields,
  lineCosts: z.array(purchaseOrderLineCostSchema.strict()).max(500).optional(),
}).superRefine((value, context) => {
  const lineIds = value.lineCosts?.map((line) => line.purchaseRequestLineId) ?? [];
  if (new Set(lineIds).size !== lineIds.length) {
    context.addIssue({ code: 'custom', message: '采购申请明细价格不能重复填写', path: ['lineCosts'] });
  }
});

export const purchaseOrderActionSchema = z.object({
  action: z.enum(['issue', 'cancel', 'close']),
  note: z.string().trim().max(500).optional(),
  expectedVersion: z.number().int().positive().optional(),
}).superRefine((value, context) => {
  if (value.action === 'close' && !value.note) {
    context.addIssue({
      code: 'custom',
      message: '关闭采购单剩余量时必须填写原因',
      path: ['note'],
    });
  }
});

const purchaseReceiptLineSchema = z.object({
  purchaseOrderLineId: z.string().trim().min(1),
  quantity: z.number().int().positive().max(1_000_000),
});

export const createPurchaseReceiptSchema = z.object({
  warehouseId: z.string().trim().min(1),
  receivedAt: z.iso.datetime({ offset: true }).optional(),
  note: z.string().trim().max(500).optional(),
  lines: z.array(purchaseReceiptLineSchema).min(1).max(500),
}).superRefine((value, context) => {
  const lineIds = value.lines.map((line) => line.purchaseOrderLineId);
  if (new Set(lineIds).size !== lineIds.length) {
    context.addIssue({ code: 'custom', message: '同一次收货不能重复填写采购单明细', path: ['lines'] });
  }
});

export type CreateOrderInput = z.infer<typeof createOrderSchema>;
export type ShopifyOrderSyncInput = z.infer<typeof shopifyOrderSyncSchema>;
export type ShopifyWebhookProcessInput = z.infer<typeof shopifyWebhookProcessSchema>;
export type CreatePurchaseRequestInput = z.infer<typeof createPurchaseRequestSchema>;
export type CreateManualPurchaseRequestInput = z.infer<typeof createManualPurchaseRequestSchema>;
export type { PurchaseProductDetailsInput } from './purchase-product-details';
export type UpsertMukuSkuMappingInput = z.infer<typeof upsertMukuSkuMappingSchema>;
export type UpsertSkuProcurementPolicyInput = z.infer<typeof upsertSkuProcurementPolicySchema>;
export type UpsertSkuInventoryConfirmationInput = z.infer<typeof upsertSkuInventoryConfirmationSchema>;
export type CreatePlanningPurchaseRequestInput = z.infer<typeof createPlanningPurchaseRequestSchema>;
export type PurchaseRequestActionInput = z.infer<typeof purchaseRequestActionSchema>;
export type CreateSupplierInput = z.infer<typeof createSupplierSchema>;
export type CreateWarehouseInput = z.infer<typeof createWarehouseSchema>;
export type CreatePurchaseOrderInput = z.infer<typeof createPurchaseOrderSchema>;
export type UpdatePurchaseOrderDraftInput = z.infer<typeof updatePurchaseOrderDraftSchema>;
export type PurchaseOrderActionInput = z.infer<typeof purchaseOrderActionSchema>;
export type CreatePurchaseReceiptInput = z.infer<typeof createPurchaseReceiptSchema>;
