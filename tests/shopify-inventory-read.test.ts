import { describe, expect, it, vi } from 'vitest';
import { ShopifyAdminClient } from '../lib/connectors/shopify/client';
import { resolveShopifyStoreConfig } from '../lib/connectors/shopify/config';
import { lookupShopifyInventory, shopifyInventoryLookupSchema } from '../lib/connectors/shopify/inventory-read';

const store = resolveShopifyStoreConfig({
  SHOPIFY_ZIMASYA_SHOP_DOMAIN: 'fixture-zimasya.myshopify.com',
  SHOPIFY_ZIMASYA_ADMIN_ACCESS_TOKEN: 'inventory-test-access-token',
}, 'zimasya');
const context = { scopes: new Set(['read_orders', 'read_inventory']) };
const sku = 'SKU-A';
const firstItem = { id: 'gid://shopify/InventoryItem/1', sku, tracked: true };
const secondItem = { id: 'gid://shopify/InventoryItem/2', sku, tracked: false };
const differentSku = { id: 'gid://shopify/InventoryItem/3', sku: 'sku-a', tracked: true };
const firstLocation = { id: 'gid://shopify/Location/1', name: '测试仓一', isActive: true };
const secondLocation = { id: 'gid://shopify/Location/2', name: '测试仓二', isActive: false };
const updatedAt = '2026-11-25T06:20:00Z';

function page<T>(nodes: T[], endCursor: string | null = null) {
  return { nodes, pageInfo: { hasNextPage: endCursor !== null, endCursor } };
}

function withResponses(...responses: unknown[]) {
  const requestBodies: Array<{ query: string; variables: Record<string, unknown> }> = [];
  const fetchMock = vi.fn(async (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    requestBodies.push(JSON.parse(String(init?.body)));
    if (!responses.length) throw new Error('unexpected inventory query');
    return Response.json({ data: responses.shift() });
  });
  const client = new ShopifyAdminClient(store, fetchMock, async () => {}, () => 0.5);
  return { client, fetchMock, requestBodies };
}

describe('Shopify 店铺库存只读查询', () => {
  it('以完整大小写 SKU 过滤并分页读取库存项目和分地点数量，不合并同 SKU 的多个项目', async () => {
    const firstLevel = { isActive: true, location: firstLocation, updatedAt,
      quantities: [{ name: 'available', quantity: -1 }, { name: 'on_hand', quantity: 0 }, { name: 'committed', quantity: 2 }] };
    const secondLevel = { isActive: false, location: secondLocation, updatedAt,
      quantities: [{ name: 'available', quantity: 0 }, { name: 'incoming', quantity: 5 }] };
    const { client, requestBodies } = withResponses(
      { inventoryItems: page([firstItem, differentSku], 'sku-page-2') },
      { inventoryItems: page([secondItem]) },
      { inventoryItem: { ...firstItem, inventoryLevels: page([firstLevel], 'warehouse-page-2') } },
      { inventoryItem: { ...firstItem, inventoryLevels: page([secondLevel]) } },
    );
    const result = await lookupShopifyInventory({ client, context, sku });
    expect(requestBodies.map(({ variables }) => variables.after)).toEqual([null, 'sku-page-2', null, 'warehouse-page-2']);
    expect(requestBodies[0].variables).toMatchObject({ query: 'sku:"SKU-A"' });
    expect(requestBodies.every(({ query }) => query.startsWith('query '))).toBe(true);
    expect(result).toEqual([
      { itemId: firstItem.id, sku, tracked: true, levels: [
        { location: firstLocation, active: true, updatedAt, available: -1, onHand: 0, committed: 2, incoming: null },
        { location: secondLocation, active: false, updatedAt, available: 0, onHand: null, committed: null, incoming: 5 },
      ] },
      { itemId: secondItem.id, sku, tracked: false, levels: [] },
    ]);
  });

  it('缺库存 scope 时不访问平台，读取规格异常时拒绝不完整快照', async () => {
    const { client, fetchMock } = withResponses(
      { inventoryItems: page([firstItem]) },
      { inventoryItem: { ...firstItem, sku: 'SKU-CHANGED', inventoryLevels: page([]) } },
    );
    await expect(lookupShopifyInventory({ client, context: { scopes: new Set(['read_orders']) }, sku }))
      .rejects.toMatchObject({ code: 'SHOPIFY_READ_INVENTORY_SCOPE_MISSING' });
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(lookupShopifyInventory({ client, context, sku }))
      .rejects.toMatchObject({ code: 'SHOPIFY_INVENTORY_INVALID_RESPONSE' });
  });

  it('拦截重复游标并将带双引号的确切 SKU 当作查询值', async () => {
    const { client, requestBodies } = withResponses(
      { inventoryItems: page([firstItem], 'repeated') },
      { inventoryItems: page([secondItem], 'repeated') },
    );
    await expect(lookupShopifyInventory({ client, context, sku: 'S"KU\\A' }))
      .rejects.toMatchObject({ code: 'SHOPIFY_INVENTORY_INVALID_RESPONSE' });
    expect(requestBodies[0].variables).toMatchObject({ query: 'sku:"S\\"KU\\\\A"' });
    expect(shopifyInventoryLookupSchema.safeParse({ storeKey: 'not-a-store', sku }).success).toBe(false);
    expect(shopifyInventoryLookupSchema.safeParse({ storeKey: 'zimasya', sku: 'S\tKU' }).success).toBe(false);
  });
});
