import { z } from 'zod';
import type { ShopifyAdminClient } from './client';
import { SHOPIFY_STORE_CANDIDATES } from './config';
import { ShopifyConnectorError } from './errors';
import findVariants from './graphql/product-variant-ids-by-sku.graphql?raw';
import readVariant from './graphql/product-variant-archive.graphql?raw';

const pageSize = 25;
const maxPages = 5;
const variantId = z.string().regex(/^gid:\/\/shopify\/ProductVariant\/\d+$/u);
const productId = z.string().regex(/^gid:\/\/shopify\/Product\/\d+$/u);

export const shopifyProductArchiveLookupSchema = z.strictObject({
  storeKey: z.enum(SHOPIFY_STORE_CANDIDATES.map(({ key }) => key)),
  sku: z.string().trim().min(1).max(160).regex(/^[^\x00-\x1f\x7f]+$/u),
});

const candidatesPage = z.object({ productVariants: z.object({
  nodes: z.array(z.object({ id: variantId, sku: z.string().nullable() })).max(pageSize),
  pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().min(1).nullable() }),
}) });
const productMedia = z.object({ nodes: z.array(z.object({
  __typename: z.string(), status: z.string().optional(), image: z.object({ url: z.string() }).nullable().optional(),
})).max(6) });
const archiveDetails = z.object({ productVariant: z.object({
  id: variantId, sku: z.string().nullable(), title: z.string(),
  selectedOptions: z.array(z.object({ name: z.string(), value: z.string() })),
  media: productMedia, product: z.object({ id: productId, title: z.string(), description: z.string(), status: z.string(), media: productMedia }),
}).nullable() });

export type ShopifyProductArchive = {
  sku: string;
  productId: string;
  productTitle: string;
  productStatus: string;
  variantId: string;
  variantTitle: string;
  options: { name: string; value: string }[];
  description: string;
  image: { url: string; source: 'variant' | 'product' } | null;
};

function findImageUrl(media: z.infer<typeof productMedia>, verifiedDomain: string) {
  for (const node of media.nodes) {
    if (node.__typename !== 'MediaImage' || node.status !== 'READY' || !node.image) continue;
    const url = URL.parse(node.image.url);
    if (!url || url.protocol !== 'https:' || url.port || url.username || url.password || url.hash) continue;
    const onShopifyCdn = url.hostname === 'cdn.shopify.com' && url.pathname.startsWith('/s/files/');
    const onSelectedStore = url.hostname === verifiedDomain && url.pathname.startsWith('/cdn/shop/');
    if (onShopifyCdn || onSelectedStore) return url.href;
  }
  return null;
}

export async function lookupShopifyProductArchive(input: {
  client: Pick<ShopifyAdminClient, 'graphql'>;
  context: { scopes: ReadonlySet<string>; domain: string };
  sku: string;
}): Promise<ShopifyProductArchive | null> {
  const { client, context, sku } = input;
  if (!context.scopes.has('read_products') && !context.scopes.has('write_products')) {
    throw new ShopifyConnectorError('SHOPIFY_READ_PRODUCTS_SCOPE_MISSING', '该店铺尚未授权读取 Shopify 商品资料（read_products）');
  }
  const skuFilter = sku.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  const query = `sku:"${skuFilter}" status:active,archived,draft,unlisted`;
  const cursors = new Set<string>();
  const variantIds = new Set<string>();
  let after: string | null = null;
  let exactId: string | null = null;
  let complete = false;
  for (let index = 0; index < maxPages; index += 1) {
    const parsed = candidatesPage.safeParse(await client.graphql<unknown>(findVariants, { first: pageSize, query, after }));
    if (!parsed.success) throw invalidArchiveResponse();
    const { nodes, pageInfo } = parsed.data.productVariants;
    for (const node of nodes) {
      if (variantIds.has(node.id)) throw invalidArchiveResponse();
      variantIds.add(node.id);
      if (node.sku !== sku) continue;
      if (exactId) throw new ShopifyConnectorError('SHOPIFY_PRODUCT_SKU_AMBIGUOUS', '该店铺有多个完全相同的 SKU，请先在 Shopify 核对商品变体');
      exactId = node.id;
    }
    if (!pageInfo.hasNextPage) {
      complete = true;
      break;
    }
    const next = pageInfo.endCursor;
    if (!nodes.length || !next || cursors.has(next)) throw invalidArchiveResponse();
    cursors.add(next);
    after = next;
  }
  if (!complete) throw new ShopifyConnectorError('SHOPIFY_PRODUCT_LOOKUP_LIMIT', 'SKU 搜索结果超出核验上限，请在 Shopify 核对完整 SKU');
  if (!exactId) return null;

  const detail = archiveDetails.safeParse(await client.graphql<unknown>(readVariant, { id: exactId }));
  const variant = detail.success ? detail.data.productVariant : null;
  if (!variant || variant.id !== exactId || variant.sku !== sku) throw invalidArchiveResponse();
  const variantImage = findImageUrl(variant.media, context.domain);
  const productImage = variantImage ? null : findImageUrl(variant.product.media, context.domain);
  return {
    sku, productId: variant.product.id, productTitle: variant.product.title, productStatus: variant.product.status,
    variantId: variant.id, variantTitle: variant.title, options: variant.selectedOptions, description: variant.product.description,
    image: variantImage ? { url: variantImage, source: 'variant' } : productImage ? { url: productImage, source: 'product' } : null,
  };
}

function invalidArchiveResponse() {
  return new ShopifyConnectorError('SHOPIFY_PRODUCT_INVALID_RESPONSE', 'Shopify 商品资料未能完整核验，请重新查询');
}
