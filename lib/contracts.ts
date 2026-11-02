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

export type CreateOrderInput = z.infer<typeof createOrderSchema>;
export type ShopifyOrderSyncInput = z.infer<typeof shopifyOrderSyncSchema>;
export type ShopifyWebhookProcessInput = z.infer<typeof shopifyWebhookProcessSchema>;
