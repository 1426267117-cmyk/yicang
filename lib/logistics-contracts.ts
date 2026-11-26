import { z } from 'zod';

export const logisticsStatuses = ['registered', 'in_transit', 'exception', 'delivered'] as const;
export type LogisticsStatus = (typeof logisticsStatuses)[number];

export const logisticsStatusLabels: Record<LogisticsStatus, string> = {
  registered: '已登记', in_transit: '运输中', exception: '运输异常', delivered: '已签收',
};

export const trackingEventSchema = z.strictObject({
  orderId: z.string().trim().min(1).max(160),
  packageId: z.uuid().optional(),
  expectedVersion: z.number().int().min(0).max(1_000_000),
  carrier: z.string().trim().min(1, '请输入承运商').max(100),
  trackingNumber: z.string().trim().min(3).max(120)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9 _.-]*$/u, '请核对运单号格式').transform((value) => value.toUpperCase()),
  status: z.enum(logisticsStatuses),
  note: z.string().trim().max(500).default(''),
  additionalPackage: z.literal(true).optional(),
}).superRefine((input, ctx) => {
  if (Boolean(input.packageId) !== (input.expectedVersion > 0)) {
    ctx.addIssue({ code: 'custom', path: ['expectedVersion'], message: '请刷新包裹记录后重试' });
  }
  if (input.status === 'exception' && !input.note) {
    ctx.addIssue({ code: 'custom', path: ['note'], message: '登记运输异常时请填写情况' });
  }
  if (input.additionalPackage && (input.packageId || !input.note)) {
    ctx.addIssue({ code: 'custom', path: ['note'], message: '额外包裹须在首次登记时填写原因' });
  }
});

export type TrackingEventInput = z.infer<typeof trackingEventSchema>;

export type ManualLogisticsRow = {
  orderId: string;
  orderNo: string;
  warehouseName: string;
  skuCode: string;
  quantity: number;
  shippedAt: string;
  packedPackageCount: number | null;
  registeredPackageCount: number;
  packageId: string | null;
  version: number | null;
  carrier: string | null;
  trackingNumber: string | null;
  status: LogisticsStatus | null;
  updatedAt: string | null;
};

export type PlatformLogisticsRow = {
  id: string;
  orderNo: string;
  storeName: string;
  carrier: string | null;
  trackingNumber: string | null;
  status: string | null;
  expectedAt: string | null;
  deliveredAt: string | null;
  updatedAt: string;
};

export type LogisticsHistoryRow = {
  id: string;
  version: number;
  carrier: string;
  trackingNumber: string;
  status: LogisticsStatus;
  note: string | null;
  actor: string;
  createdAt: string;
};

export type InboundLogisticsRow = {
  sku: string;
  region: string;
  arrivalDate: string;
  pcs: number;
  batch: string | null;
  container: string | null;
};

export const logisticsPageSize = 50;
export const logisticsMaxPage = 100_000;
