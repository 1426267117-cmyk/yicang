import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from '../app/api/connectors/shopify/product-archive/route';
import { ShopifyAdminClient } from '../lib/connectors/shopify/client';
import { resolveShopifyStoreConfig } from '../lib/connectors/shopify/config';
import { lookupShopifyProductArchive, type ShopifyProductArchive } from '../lib/connectors/shopify/product-archive-read';
import type { UserContext } from '../lib/db';
import { ROLE_PERMISSIONS } from '../lib/domain';

const runtime = vi.hoisted(() => ({
  env: {} as Record<string, string>,
  auth: vi.fn(),
  loadCredential: vi.fn(),
}));
vi.mock('cloudflare:workers', () => ({ env: runtime.env }));
vi.mock('../lib/db', async (original) => ({ ...await original<typeof import('../lib/db')>(), requestContext: runtime.auth }));
vi.mock('../lib/connectors/shopify/credential-store', async (original) => ({
  ...await original<typeof import('../lib/connectors/shopify/credential-store')>(), loadShopifyOAuthCredential: runtime.loadCredential,
}));

const sku = 'SKU-A';
const expectedShop = 'gid://shopify/Shop/42';
const variantId = 'gid://shopify/ProductVariant/11';
const context = { scopes: new Set(['read_products']), domain: 'fixture-zimasya.myshopify.com' };
const shopifyFixtureEnv = {
  SHOPIFY_ZIMASYA_SHOP_DOMAIN: context.domain,
  SHOPIFY_ZIMASYA_ADMIN_ACCESS_TOKEN: 'fixture-read-token',
};
const config = resolveShopifyStoreConfig(shopifyFixtureEnv, 'zimasya');
const sourceImage = 'https://cdn.shopify.com/s/files/1/0000/fixture.jpg?v=1';
const administrator: UserContext = { id: 'product-test-admin', email: 'fixture-admin@example.invalid', displayName: '测试管理员',
  role: 'admin', permissions: ROLE_PERMISSIONS.admin, tenantId: 'tenant-guangzhou-fixture', tenantName: '隔离测试工作区' };

function variantPage(nodes: { id: string; sku: string | null }[], endCursor: string | null = null) {
  return { productVariants: { nodes, pageInfo: { hasNextPage: endCursor !== null, endCursor } } };
}

function media(url: string, status = 'READY') {
  return { __typename: 'MediaImage', status, image: { url } };
}

function details(variantMedia = [media(sourceImage)], productMedia = [media('https://cdn.shopify.com/s/files/1/product.jpg')]) {
  return { productVariant: { id: variantId, sku, title: 'Blue / Large', selectedOptions: [{ name: 'Color', value: 'Blue' }, { name: 'Size', value: 'Large' }],
    media: { nodes: variantMedia }, product: { id: 'gid://shopify/Product/8', title: 'Fixture Chair', status: 'ARCHIVED',
      description: 'Plain product description', media: { nodes: productMedia } } } };
}

function shopData(scopes = ['read_products'], domain = context.domain, id = expectedShop) {
  return { shop: { id, name: 'Fixture Shopify', myshopifyDomain: domain }, currentAppInstallation: { accessScopes: scopes.map((handle) => ({ handle })) } };
}

function fetchWith(...bodies: unknown[]) {
  const fetch = vi.fn<typeof globalThis.fetch>();
  for (const body of bodies) fetch.mockResolvedValueOnce(Response.json({ data: body }));
  return fetch;
}

function archiveClient(...bodies: unknown[]) {
  const fetch = fetchWith(...bodies);
  return { client: new ShopifyAdminClient(config, fetch, async () => {}, () => 0.5), fetch };
}

function request(body: object = { storeKey: 'zimasya', sku }) {
  return POST(new Request('https://erp.example.invalid/api/connectors/shopify/product-archive', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }));
}

function signIn({ user = administrator, bindings = [expectedShop] }: { user?: UserContext; bindings?: string[] } = {}) {
  const write = vi.fn(() => { throw new Error('read-only product archive must not write'); });
  const bind = vi.fn(() => ({
    all: async () => ({ results: bindings.map((official_store_id) => ({ official_store_id })) }), run: write,
  }));
  const db = { prepare: vi.fn(() => ({ bind })), batch: write, exec: write };
  runtime.auth.mockResolvedValue({ db, user });
  return { db, bind, write };
}

describe('Shopify 商品资料匹配', () => {
  it('用分页确认唯一且大小写完全相同的 SKU，只读取该变体资料，并优先采用变体图片', async () => {
    const { client, fetch } = archiveClient(variantPage([{ id: 'gid://shopify/ProductVariant/1', sku: 'sku-a' }], 'next-page'),
      variantPage([{ id: variantId, sku }]), details());
    expect(await lookupShopifyProductArchive({ client, context, sku })).toEqual({
      sku, productId: 'gid://shopify/Product/8', productTitle: 'Fixture Chair', productStatus: 'ARCHIVED', variantId,
      variantTitle: 'Blue / Large', options: [{ name: 'Color', value: 'Blue' }, { name: 'Size', value: 'Large' }],
      description: 'Plain product description', image: { source: 'variant', url: sourceImage },
    });
    const bodies = fetch.mock.calls.map(([, init]) => JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> });
    expect(bodies.map(({ variables }) => variables)).toEqual([
      { first: 25, after: null, query: 'sku:"SKU-A" status:active,archived,draft,unlisted' },
      { first: 25, after: 'next-page', query: 'sku:"SKU-A" status:active,archived,draft,unlisted' }, { id: variantId },
    ]);
    expect(bodies.every(({ query }) => query.startsWith('query ') && !query.includes('descriptionHtml') && !query.includes('weight'))).toBe(true);
  });

  it('重复 SKU、无法完整分页与变体标识变化时不交付不确定资料', async () => {
    const same = { id: variantId, sku };
    const duplicate = archiveClient(variantPage([same], 'next-page'), variantPage([{ id: 'gid://shopify/ProductVariant/12', sku }]));
    await expect(lookupShopifyProductArchive({ client: duplicate.client, context, sku })).rejects.toMatchObject({ code: 'SHOPIFY_PRODUCT_SKU_AMBIGUOUS' });
    expect(duplicate.fetch).toHaveBeenCalledTimes(2);
    const unfinished = archiveClient(...Array.from({ length: 5 }, (_, index) => variantPage([
      { id: `gid://shopify/ProductVariant/${index + 1}`, sku: index === 0 ? sku : null },
    ], `cursor-${index}`)));
    await expect(lookupShopifyProductArchive({ client: unfinished.client, context, sku })).rejects.toMatchObject({ code: 'SHOPIFY_PRODUCT_LOOKUP_LIMIT' });
    const detailDrift = archiveClient(variantPage([same]), { productVariant: { ...details().productVariant, sku: 'CHANGED' } });
    await expect(lookupShopifyProductArchive({ client: detailDrift.client, context, sku })).rejects.toMatchObject({ code: 'SHOPIFY_PRODUCT_INVALID_RESPONSE' });
  });

  it('不把未就绪或其他域名图片交给用户，保留可核验商品图片及未知值', async () => {
    const matched = variantPage([{ id: variantId, sku }]);
    const productImage = `https://${context.domain}/cdn/shop/files/fixture.jpg`;
    const unsafe = [media('https://outside.example/image.png'), media('https://other.myshopify.com/cdn/shop/files/photo.jpg'),
      media('https://cdn.shopify.com/s/files/1/not-ready.png', 'PROCESSING'), media('javascript:alert(1)')];
    const result = archiveClient(matched, details(unsafe, [media(productImage)]));
    await expect(lookupShopifyProductArchive({ client: result.client, context, sku })).resolves.toMatchObject({ image: { url: productImage, source: 'product' } });
    const unavailable = archiveClient(matched, details(unsafe, []));
    await expect(lookupShopifyProductArchive({ client: unavailable.client, context, sku })).resolves.toMatchObject({ image: null });
  });

  it('缺少商品读取 scope 时不查询，转义输入中的搜索语法字符', async () => {
    const { client, fetch } = archiveClient(variantPage([]));
    await expect(lookupShopifyProductArchive({ client, context: { ...context, scopes: new Set(['read_orders']) }, sku }))
      .rejects.toMatchObject({ code: 'SHOPIFY_READ_PRODUCTS_SCOPE_MISSING' });
    expect(fetch).not.toHaveBeenCalled();
    expect(await lookupShopifyProductArchive({ client, context, sku: 'S"KU\\A' })).toBeNull();
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body)).variables.query).toBe('sku:"S\\"KU\\\\A" status:active,archived,draft,unlisted');
  });
});

describe('Shopify 商品资料查询路由', () => {
  beforeEach(() => {
    Object.assign(runtime.env, shopifyFixtureEnv, { ERP_ALLOWED_EMAILS: administrator.email });
    runtime.loadCredential.mockReset().mockResolvedValue(null);
    signIn();
  });
  afterEach(() => {
    for (const name of Object.keys(runtime.env)) delete runtime.env[name];
    vi.unstubAllGlobals();
  });

  it('工作区已绑定且官方域名和 ID 核对后，查询商品 scope 并返回私有只读结果', async () => {
    const { db, bind, write } = signIn();
    const fetch = fetchWith(shopData(), variantPage([{ id: variantId, sku }]), details());
    vi.stubGlobal('fetch', fetch);
    const response = await request();
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    const body = await response.json() as { product: ShopifyProductArchive };
    expect(body).toMatchObject({ ok: true, readOnly: true, store: { key: 'zimasya', domain: context.domain }, sku });
    expect(body.product.image).toEqual({ url: sourceImage, source: 'variant' });
    expect(JSON.stringify(body)).not.toContain('fixture-read-token');
    expect(db.prepare).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('tenant_id = ?'));
    expect(bind).toHaveBeenCalledExactlyOnceWith(administrator.tenantId, 'zimasya', administrator.tenantId, 'zimasya');
    expect(write).not.toHaveBeenCalled();
    expect(fetch.mock.calls.every(([url]) => String(url) === `https://${context.domain}/admin/api/2026-07/graphql.json`)).toBe(true);
  });

  it('拒绝未知店铺、任意域名、未连接或跨工作区凭证，以及过期的店铺授权', async () => {
    const fetch = fetchWith();
    vi.stubGlobal('fetch', fetch);
    expect((await request({ storeKey: 'other-merchant', sku })).status).toBe(400);
    expect((await request({ storeKey: 'zimasya', domain: 'other.myshopify.com', sku })).status).toBe(400);
    signIn({ user: { ...administrator, tenantId: 'tenant-shenzhen-fixture' }, bindings: [] });
    expect(await (await request()).json()).toMatchObject({ code: 'SHOPIFY_PRODUCT_STORE_UNVERIFIED' });
    signIn();
    delete runtime.env.SHOPIFY_ZIMASYA_ADMIN_ACCESS_TOKEN;
    expect(await (await request()).json()).toMatchObject({ code: 'SHOPIFY_AUTHORIZATION_REQUIRED' });
    runtime.loadCredential.mockResolvedValueOnce({ accessToken: 'expired-fixture-token', accessTokenExpiresAt: '2020-01-01T00:00:00Z' });
    expect(await (await request()).json()).toMatchObject({ code: 'SHOPIFY_PRODUCT_AUTHORIZATION_EXPIRED' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('权限不足、域名或身份变化时，不发出任何商品查询', async () => {
    const fetch = fetchWith(shopData(['read_orders']), shopData(['read_products'], 'other.myshopify.com'), shopData(['read_products'], context.domain, 'gid://shopify/Shop/9999'));
    vi.stubGlobal('fetch', fetch);
    signIn({ user: { ...administrator, role: 'viewer', permissions: ['connectors:read'] } });
    expect((await request()).status).toBe(403);
    signIn({ user: { ...administrator, email: 'unlisted@example.invalid' } });
    expect((await request()).status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
    signIn();
    expect(await (await request()).json()).toMatchObject({ code: 'SHOPIFY_READ_PRODUCTS_SCOPE_MISSING' });
    expect(await (await request()).json()).toMatchObject({ code: 'SHOPIFY_IDENTITY_MISMATCH' });
    expect(await (await request()).json()).toMatchObject({ code: 'SHOPIFY_IDENTITY_MISMATCH' });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls.every(([, init]) => JSON.parse(String(init?.body)).query.startsWith('query ErpShopContext'))).toBe(true);
  });
});
