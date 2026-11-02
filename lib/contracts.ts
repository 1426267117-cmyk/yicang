import { z } from 'zod';

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

export const purchaseRequestActionSchema = z.object({
  action: z.enum(['submit', 'approve', 'reject', 'cancel']),
  note: z.string().trim().max(500).optional(),
}).superRefine((value, context) => {
  if (value.action === 'reject' && !value.note) {
    context.addIssue({ code: 'custom', message: '驳回采购申请时必须填写原因', path: ['note'] });
  }
});

export const createSupplierSchema = z.object({
  code: z.string().trim().min(1).max(40).transform((value) => value.toUpperCase()),
  name: z.string().trim().min(1).max(120),
  note: z.string().trim().max(500).optional(),
});

const purchaseOrderLineCostSchema = z.object({
  purchaseRequestLineId: z.string().trim().min(1),
  unitCostMinor: z.number().int().min(0).max(10_000_000_000),
});

export const createPurchaseOrderSchema = z.object({
  purchaseRequestId: z.string().trim().min(1),
  supplierId: z.string().trim().min(1),
  currency: z.string().trim().length(3).transform((value) => value.toUpperCase()).optional(),
  note: z.string().trim().max(500).optional(),
  lineCosts: z.array(purchaseOrderLineCostSchema).max(500).optional(),
}).superRefine((value, context) => {
  if (value.lineCosts?.length && !value.currency) {
    context.addIssue({ code: 'custom', message: '填写采购单价时必须指定币种', path: ['currency'] });
  }
  const lineIds = value.lineCosts?.map((line) => line.purchaseRequestLineId) ?? [];
  if (new Set(lineIds).size !== lineIds.length) {
    context.addIssue({ code: 'custom', message: '采购申请明细价格不能重复填写', path: ['lineCosts'] });
  }
});

export const purchaseOrderActionSchema = z.object({
  action: z.enum(['issue', 'cancel']),
  note: z.string().trim().max(500).optional(),
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
export type PurchaseRequestActionInput = z.infer<typeof purchaseRequestActionSchema>;
export type CreateSupplierInput = z.infer<typeof createSupplierSchema>;
export type CreatePurchaseOrderInput = z.infer<typeof createPurchaseOrderSchema>;
export type PurchaseOrderActionInput = z.infer<typeof purchaseOrderActionSchema>;
export type CreatePurchaseReceiptInput = z.infer<typeof createPurchaseReceiptSchema>;
