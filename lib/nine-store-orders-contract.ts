import { z } from 'zod';

export const nineStoreSnapshotMaxBytes = 2_500_000;
export const nineStorePageSize = 40;
export const channelPlatforms = ['amazon', 'shopify', 'wayfair'] as const;
export const nineStoreRoster = [
  ['amazon-senyu', 'amazon'], ['amazon-kaguyasu', 'amazon'], ['amazon-zhongcheng', 'amazon'], ['amazon-genji', 'amazon'],
  ['shopify-kaguyasu', 'shopify'], ['shopify-zimasya', 'shopify'], ['shopify-anzhap', 'shopify'], ['shopify-bizfurniz', 'shopify'],
  ['wayfair-linhe', 'wayfair'],
] as const;
export const orderFeedTableKinds = ['amazon-orders', 'shopify-orders', 'wayfair-orders', 'refunds'] as const;
export const feedFulfillmentStatuses = ['pending', 'shipped', 'delivered', 'cancelled', 'exception'] as const;
const merchantKey = z.string().regex(/^[a-z0-9][a-z0-9-]{1,47}$/u);
const store = z.strictObject({ key: merchantKey, platform: z.enum(channelPlatforms), name: z.string().trim().min(1).max(60) });
const table = z.strictObject({
  kind: z.enum(orderFeedTableKinds), revision: z.string().regex(/^(?:0|[1-9]\d{0,18})$/u),
  read: z.int().nonnegative(), accepted: z.int().nonnegative(), outsideScope: z.int().nonnegative(), invalid: z.int().nonnegative(),
});
const baseRow = {
  recordId: z.string().regex(/^rec[a-zA-Z0-9]{3,80}$/u), storeKey: merchantKey,
  orderNo: z.string().trim().regex(/^[A-Za-z0-9#_.-][A-Za-z0-9#_. -]{2,89}$/u),
  sku: z.string().trim().min(1).max(120).regex(/^[^\r\n@]+$/u).nullable(),
};
const orderRow = z.strictObject({ ...baseRow, orderDate: z.iso.date().nullable(), quantity: z.int().min(0).max(1_000_000).nullable(),
  fulfillment: z.enum(feedFulfillmentStatuses).nullable() });
const refundRow = z.strictObject({ ...baseRow, refundDate: z.iso.date().nullable() });

export const nineStoreOrderSnapshotSchema = z.strictObject({
  version: z.literal(1), source: z.literal('feishu-order-base'), observedAt: z.iso.datetime(),
  stores: z.array(store).length(9), tables: z.array(table).length(4), orders: z.array(orderRow).max(25_000), refunds: z.array(refundRow).max(10_000),
}).superRefine((snapshot, context) => {
  const storesByKey = new Map(snapshot.stores.map((entry) => [entry.key, entry]));
  const byKind = new Map(snapshot.tables.map((entry) => [entry.kind, entry]));
  const valid = () => {
    if (storesByKey.size !== 9 || byKind.size !== 4) return false;
    if (nineStoreRoster.some(([key, platform]) => storesByKey.get(key)?.platform !== platform)) return false;
    const counts = new Map<string, number>();
    const records = new Set<string>();
    for (const [kind, entries] of [['orders', snapshot.orders], ['refunds', snapshot.refunds]] as const) {
      for (const row of entries) {
        const merchant = storesByKey.get(row.storeKey);
        if (!merchant) return false;
        const source = kind === 'orders' ? `${merchant.platform}-orders` : 'refunds';
        const identity = `${source}:${row.recordId}`;
        if (records.has(identity)) return false;
        records.add(identity);
        counts.set(source, (counts.get(source) ?? 0) + 1);
      }
    }
    return snapshot.tables.every((entry) => entry.read === entry.accepted + entry.outsideScope + entry.invalid
      && (counts.get(entry.kind) ?? 0) === entry.accepted);
  };
  if (!valid()) context.addIssue({ code: 'custom', message: '店铺范围、行数或来源行标识不一致' });
});

export const nineStoreOrderQuerySchema = z.strictObject({
  section: z.enum(['orders', 'refunds']).default('orders'), store: merchantKey.optional(),
  scope: z.enum(['current', 'history']).default('current'), search: z.string().trim().max(100).default(''),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  from: z.iso.date().optional(), through: z.iso.date().optional(),
  fulfillment: z.enum([...feedFulfillmentStatuses, 'unknown']).optional(),
}).superRefine((query, context) => {
  if ((query.from && query.through && query.from > query.through) || (query.section === 'refunds' && query.fulfillment)) {
    context.addIssue({ code: 'custom', message: '请核对日期范围和履约筛选' });
  }
  if (query.scope === 'current' && query.page > 625) {
    context.addIssue({ code: 'custom', message: '当前订单页码超出范围' });
  }
});

export type NineStoreOrderSnapshot = z.infer<typeof nineStoreOrderSnapshotSchema>;
export type NineStoreOrderQuery = z.infer<typeof nineStoreOrderQuerySchema>;
export type NineStoreHistoryMetadata = { observedAt: string; archivedAt: string; change: 'updated' | 'removed' };
export type NineStoreFeedRows = {
  orders: Array<Omit<z.infer<typeof orderRow>, 'recordId'> & { history?: NineStoreHistoryMetadata }>;
  refunds: Array<Omit<z.infer<typeof refundRow>, 'recordId'> & { history?: NineStoreHistoryMetadata }>;
};
export type NineStoreCoverage = z.infer<typeof store> & {
  orderLines: number; uniqueOrders: number; fulfillmentKnown: number; refundLines: number;
};
export type NineStoreOrderResponse = {
  ok: true; snapshot: null | { observedAt: string; importedAt: string; tables: NineStoreOrderSnapshot['tables']; stores: NineStoreCoverage[] };
  total: number; section: 'orders' | 'refunds'; rows: Array<NineStoreFeedRows['orders'][number] | NineStoreFeedRows['refunds'][number]>;
};
