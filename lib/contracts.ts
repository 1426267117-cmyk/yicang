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

export type CreateOrderInput = z.infer<typeof createOrderSchema>;
