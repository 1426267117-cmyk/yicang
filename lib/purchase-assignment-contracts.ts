import { z } from 'zod';

export const reassignPurchaseRequestSchema = z.object({
  purchaserMemberId: z.string().trim().min(1),
  reviewerMemberId: z.string().trim().min(1),
  reason: z.string().trim().min(2).max(500),
  expectedVersion: z.number().int().positive(),
});

export type ReassignPurchaseRequestInput = z.infer<typeof reassignPurchaseRequestSchema>;
