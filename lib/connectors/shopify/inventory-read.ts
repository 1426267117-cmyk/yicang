import { z } from 'zod';
import type { ShopifyAdminClient } from './client';
import { SHOPIFY_STORE_CANDIDATES } from './config';
import type { ShopifyShopContext } from './connector';
import { ShopifyConnectorError } from './errors';
import findItems from './graphql/inventory-items-by-sku.graphql?raw';
import readLevels from './graphql/inventory-item-location-levels.graphql?raw';

const pageSize = 25;
const maxPages = 5;
const maxSkuMatches = 12;
const quantityNames = ['available', 'on_hand', 'committed', 'incoming'] as const;

export const shopifyInventoryLookupSchema = z.strictObject({
  storeKey: z.enum(SHOPIFY_STORE_CANDIDATES.map(({ key }) => key)),
  sku: z.string().trim().min(1).max(160).regex(/^[^\x00-\x1f\x7f]+$/u),
});

const itemSchema = z.object({
  id: z.string().regex(/^gid:\/\/shopify\/InventoryItem\/\d+$/u),
  sku: z.string().nullable(),
  tracked: z.boolean(),
});
const levelSchema = z.object({
  isActive: z.boolean(),
  updatedAt: z.iso.datetime({ offset: true }),
  location: z.object({
    id: z.string().regex(/^gid:\/\/shopify\/Location\/\d+$/u),
    name: z.string().min(1),
    isActive: z.boolean(),
  }),
  quantities: z.array(z.object({ name: z.enum(quantityNames), quantity: z.int() })).max(quantityNames.length),
});
const itemPage = z.object({ inventoryItems: pageOf(itemSchema) });
const levelPage = z.object({ inventoryItem: itemSchema.extend({ inventoryLevels: pageOf(levelSchema) }) });

export type ShopifyInventoryLocationValue = {
  location: z.infer<typeof levelSchema>['location'];
  active: boolean;
  updatedAt: string;
  available: number | null;
  onHand: number | null;
  committed: number | null;
  incoming: number | null;
};
export type ShopifyInventoryItemValue = {
  itemId: string;
  sku: string;
  tracked: boolean;
  levels: ShopifyInventoryLocationValue[];
};

export async function lookupShopifyInventory(input: {
  client: Pick<ShopifyAdminClient, 'graphql'>;
  context: Pick<ShopifyShopContext, 'scopes'>;
  sku: string;
}): Promise<ShopifyInventoryItemValue[]> {
  const { client, context, sku } = input;
  if (!context.scopes.has('read_inventory') && !context.scopes.has('write_inventory')) {
    throw new ShopifyConnectorError('SHOPIFY_READ_INVENTORY_SCOPE_MISSING', '该店铺尚未授权读取 Shopify 库存');
  }
  const search = `sku:"${sku.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
  const matched = new Map<string, z.infer<typeof itemSchema>>();
  const candidates = await readPages(async (after) => {
    const data = itemPage.safeParse(await client.graphql<unknown>(findItems, { first: pageSize, after, query: search }));
    if (!data.success) throw invalidInventoryResponse();
    return data.data.inventoryItems;
  });
  for (const item of candidates) {
    if (item.sku !== sku) continue;
    if (matched.has(item.id)) throw invalidInventoryResponse();
    matched.set(item.id, item);
  }
  if (matched.size > maxSkuMatches) {
    throw new ShopifyConnectorError('SHOPIFY_INVENTORY_TOO_MANY_SKU_MATCHES', '此 SKU 对应过多库存项目，请先核对店铺 SKU');
  }

  const items: ShopifyInventoryItemValue[] = [];
  for (const item of matched.values()) {
    const levels = item.tracked ? await readPages(async (after) => {
      const result = levelPage.safeParse(await client.graphql<unknown>(readLevels, {
        id: item.id, first: pageSize, after, names: quantityNames,
      }));
      if (!result.success) throw invalidInventoryResponse();
      const { inventoryItem } = result.data;
      if (inventoryItem.id !== item.id || inventoryItem.sku !== sku || !inventoryItem.tracked) throw invalidInventoryResponse();
      return inventoryItem.inventoryLevels;
    }) : [];
    const locations = new Set<string>();
    items.push({ itemId: item.id, sku, tracked: item.tracked, levels: levels.map((level) => {
      if (locations.has(level.location.id)) throw invalidInventoryResponse();
      locations.add(level.location.id);
      const quantities = new Map(level.quantities.map(({ name, quantity }) => [name, quantity]));
      if (quantities.size !== level.quantities.length) throw invalidInventoryResponse();
      return { location: level.location, active: level.isActive, updatedAt: level.updatedAt,
        available: quantities.get('available') ?? null, onHand: quantities.get('on_hand') ?? null,
        committed: quantities.get('committed') ?? null, incoming: quantities.get('incoming') ?? null };
    }) });
  }
  return items;
}

function pageOf<T extends z.ZodType>(node: T) {
  return z.object({ nodes: z.array(node).max(pageSize), pageInfo: z.object({
    hasNextPage: z.boolean(), endCursor: z.string().min(1).nullable(),
  }) });
}

async function readPages<T>(read: (after: string | null) => Promise<{
  nodes: T[]; pageInfo: { hasNextPage: boolean; endCursor: string | null };
}>) {
  const items: T[] = [];
  const cursors = new Set<string>();
  let after: string | null = null;
  for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
    const page = await read(after);
    items.push(...page.nodes);
    if (!page.pageInfo.hasNextPage) return items;
    const next = page.pageInfo.endCursor;
    if (!page.nodes.length || !next || cursors.has(next)) throw invalidInventoryResponse();
    cursors.add(next);
    after = next;
  }
  throw new ShopifyConnectorError('SHOPIFY_INVENTORY_LOOKUP_LIMIT', '此 SKU 的库存查询超过分页上限，请先核对该店铺的 SKU 或库存地点');
}

function invalidInventoryResponse() {
  return new ShopifyConnectorError('SHOPIFY_INVENTORY_INVALID_RESPONSE', 'Shopify 库存查询不完整或身份发生变化，无法确认结果');
}
