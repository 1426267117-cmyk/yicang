import type { CanonicalOrderGraph, ConnectorPage } from '../types';
import { asRecord, requireString, stringOrNull } from '../canonical';
import { ShopifyAdminClient } from './client';
import type { ShopifyCredentialConfig } from './config';
import { normalizeShopifyDomain } from './config';
import { ShopifyConnectorError } from './errors';
import { mapShopifyOrder } from './mapper';
import shopContextQuery from './graphql/shop-context.graphql?raw';
import ordersPageQuery from './graphql/orders-page.graphql?raw';
import orderDetailsQuery from './graphql/order-details.graphql?raw';
import orderLineItemsPageQuery from './graphql/order-line-items-page.graphql?raw';
import refundDetailsPageQuery from './graphql/refund-details-page.graphql?raw';
import fulfillmentLinesPageQuery from './graphql/fulfillment-lines-page.graphql?raw';

const NESTED_PAGE_SIZE = 100;
const MAX_NESTED_PAGES = 1_000;
const TOP_LEVEL_ARRAY_LIMIT = 250;
const TRACKING_INFO_LIMIT = 100;

export type ShopifyShopContext = {
  id: string;
  name: string;
  domain: string;
  timezone: string;
  timezoneOffset: string;
  currency: string;
  scopes: Set<string>;
};

export type ShopifyOrderReference = {
  id: string;
  updatedAt: string;
};

export class ShopifyOrderConnector {
  constructor(
    private readonly config: ShopifyCredentialConfig,
    private readonly client: ShopifyAdminClient,
  ) {}

  async getShopContext(): Promise<ShopifyShopContext> {
    const data = await this.client.graphql<Record<string, unknown>>(shopContextQuery);
    const shop = asRecord(data.shop);
    const installation = asRecord(data.currentAppInstallation);
    const accessScopes = Array.isArray(installation?.accessScopes) ? installation.accessScopes : [];
    const scopes = new Set(
      accessScopes
        .map((item) => stringOrNull(asRecord(item)?.handle))
        .filter((value): value is string => Boolean(value)),
    );
    const domain = normalizeShopifyDomain(requireString(shop?.myshopifyDomain, 'shop.myshopifyDomain'));
    if (domain !== this.config.domain) {
      throw new ShopifyConnectorError(
        'SHOPIFY_IDENTITY_MISMATCH',
        `${this.config.displayName} 返回的官方店铺域名与 ERP 配置不一致，已停止写入`,
      );
    }
    if (!scopes.has('read_orders')) {
      throw new ShopifyConnectorError(
        'SHOPIFY_READ_ORDERS_SCOPE_MISSING',
        `${this.config.displayName} 缺少 read_orders 权限`,
      );
    }
    return {
      id: requireString(shop?.id, 'shop.id'),
      name: requireString(shop?.name, 'shop.name'),
      domain,
      timezone: requireString(shop?.ianaTimezone, 'shop.ianaTimezone'),
      timezoneOffset: requireString(shop?.timezoneOffset, 'shop.timezoneOffset'),
      currency: requireString(shop?.currencyCode, 'shop.currencyCode'),
      scopes,
    };
  }

  async fetchOrdersPage(input: {
    updatedFrom: string;
    updatedTo: string;
    after: string | null;
    first?: number;
  }): Promise<ConnectorPage<ShopifyOrderReference>> {
    const search = `updated_at:>='${isoSeconds(input.updatedFrom)}' updated_at:<='${isoSeconds(input.updatedTo)}'`;
    const data = await this.client.graphql<Record<string, unknown>>(ordersPageQuery, {
      first: input.first ?? 50,
      after: input.after,
      query: search,
    });
    const connection = parseConnection(data.orders, 'orders');
    return {
      nodes: connection.nodes.map((node) => ({
        id: requireString(node.id, 'orders.nodes.id'),
        updatedAt: requireString(node.updatedAt, 'orders.nodes.updatedAt'),
      })),
      hasNextPage: connection.pageInfo.hasNextPage,
      endCursor: connection.pageInfo.endCursor,
    };
  }

  async fetchOrder(orderId: string, context: ShopifyShopContext): Promise<CanonicalOrderGraph> {
    const data = await this.client.graphql<Record<string, unknown>>(orderDetailsQuery, {
      id: orderId,
      lineItemsFirst: NESTED_PAGE_SIZE,
    });
    const order = asRecord(data.order);
    if (!order) throw new ShopifyConnectorError('SHOPIFY_ORDER_MISSING', 'Shopify 订单详情不存在');

    const rawRefunds = readObjectArray(order.refunds, 'order.refunds');
    const rawFulfillments = readObjectArray(order.fulfillments, 'order.fulfillments');
    assertArrayNotTruncated(rawRefunds, TOP_LEVEL_ARRAY_LIMIT, 'order.refunds');
    assertArrayNotTruncated(rawFulfillments, TOP_LEVEL_ARRAY_LIMIT, 'order.fulfillments');
    rawFulfillments.forEach((fulfillment) => {
      const tracking = readObjectArray(fulfillment.trackingInfo, 'fulfillment.trackingInfo');
      assertArrayNotTruncated(tracking, TRACKING_INFO_LIMIT, 'fulfillment.trackingInfo');
    });

    const lineItems = await this.completeOrderLineItems(orderId, order.lineItems);
    const refunds = await Promise.all(rawRefunds.map((refund) => this.completeRefund(refund)));
    const fulfillments = await Promise.all(
      rawFulfillments.map((fulfillment) => this.completeFulfillment(fulfillment)),
    );
    const completeOrder = {
      ...order,
      lineItems: { nodes: lineItems, pageInfo: { hasNextPage: false, endCursor: null } },
      refunds,
      fulfillments,
    };
    return mapShopifyOrder(completeOrder, context.timezone);
  }

  private async completeOrderLineItems(orderId: string, value: unknown) {
    const first = parseConnection(value, 'order.lineItems');
    const nodes = new Map(first.nodes.map((node) => [requireString(node.id, 'lineItem.id'), node]));
    let pageInfo = first.pageInfo;
    let pages = 1;
    const seen = new Set<string>();
    while (pageInfo.hasNextPage) {
      const cursor = nextCursor(pageInfo, seen, 'order.lineItems');
      if (pages >= MAX_NESTED_PAGES) throw new ShopifyConnectorError('SHOPIFY_PAGINATION_LIMIT', '订单行分页超过安全上限');
      const data = await this.client.graphql<Record<string, unknown>>(orderLineItemsPageQuery, {
        id: orderId,
        first: NESTED_PAGE_SIZE,
        after: cursor,
      });
      const order = asRecord(data.order);
      const page = parseConnection(order?.lineItems, 'order.lineItems');
      page.nodes.forEach((node) => nodes.set(requireString(node.id, 'lineItem.id'), node));
      pageInfo = page.pageInfo;
      pages += 1;
    }
    return [...nodes.values()];
  }

  private async completeRefund(refund: Record<string, unknown>) {
    const refundId = requireString(refund.id, 'refund.id');
    const firstLines = parseConnection(refund.refundLineItems, 'refund.refundLineItems');
    const firstTransactions = parseConnection(refund.transactions, 'refund.transactions');
    const lines = new Map(firstLines.nodes.map((node) => [requireString(node.id, 'refundLineItem.id'), node]));
    const transactions = new Map(
      firstTransactions.nodes.map((node) => [requireString(node.id, 'refund.transaction.id'), node]),
    );
    let linePage = firstLines.pageInfo;
    let transactionPage = firstTransactions.pageInfo;
    let lineAfter = linePage.endCursor;
    let transactionAfter = transactionPage.endCursor;
    const seenLineCursors = new Set<string>();
    const seenTransactionCursors = new Set<string>();
    let pages = 1;

    while (linePage.hasNextPage || transactionPage.hasNextPage) {
      if (pages >= MAX_NESTED_PAGES) throw new ShopifyConnectorError('SHOPIFY_PAGINATION_LIMIT', '退款分页超过安全上限');
      if (linePage.hasNextPage) lineAfter = nextCursor(linePage, seenLineCursors, 'refund.refundLineItems');
      if (transactionPage.hasNextPage) {
        transactionAfter = nextCursor(transactionPage, seenTransactionCursors, 'refund.transactions');
      }
      const data = await this.client.graphql<Record<string, unknown>>(refundDetailsPageQuery, {
        id: refundId,
        lineItemsFirst: NESTED_PAGE_SIZE,
        lineItemsAfter: lineAfter,
        transactionsFirst: NESTED_PAGE_SIZE,
        transactionsAfter: transactionAfter,
      });
      const pageRefund = asRecord(data.refund);
      if (!pageRefund) throw new ShopifyConnectorError('SHOPIFY_REFUND_MISSING', 'Shopify 退款详情不存在');
      const lineResult = parseConnection(pageRefund.refundLineItems, 'refund.refundLineItems');
      const transactionResult = parseConnection(pageRefund.transactions, 'refund.transactions');
      lineResult.nodes.forEach((node) => lines.set(requireString(node.id, 'refundLineItem.id'), node));
      transactionResult.nodes.forEach((node) => transactions.set(requireString(node.id, 'refund.transaction.id'), node));
      linePage = lineResult.pageInfo;
      transactionPage = transactionResult.pageInfo;
      pages += 1;
    }
    return {
      ...refund,
      refundLineItems: { nodes: [...lines.values()], pageInfo: { hasNextPage: false, endCursor: null } },
      transactions: { nodes: [...transactions.values()], pageInfo: { hasNextPage: false, endCursor: null } },
    };
  }

  private async completeFulfillment(fulfillment: Record<string, unknown>) {
    const fulfillmentId = requireString(fulfillment.id, 'fulfillment.id');
    const first = parseConnection(fulfillment.fulfillmentLineItems, 'fulfillment.fulfillmentLineItems');
    const lines = new Map(first.nodes.map((node) => [requireString(node.id, 'fulfillmentLineItem.id'), node]));
    let pageInfo = first.pageInfo;
    let pages = 1;
    const seen = new Set<string>();
    while (pageInfo.hasNextPage) {
      const cursor = nextCursor(pageInfo, seen, 'fulfillment.fulfillmentLineItems');
      if (pages >= MAX_NESTED_PAGES) throw new ShopifyConnectorError('SHOPIFY_PAGINATION_LIMIT', '履约行分页超过安全上限');
      const data = await this.client.graphql<Record<string, unknown>>(fulfillmentLinesPageQuery, {
        id: fulfillmentId,
        first: NESTED_PAGE_SIZE,
        after: cursor,
      });
      const pageFulfillment = asRecord(data.fulfillment);
      if (!pageFulfillment) throw new ShopifyConnectorError('SHOPIFY_FULFILLMENT_MISSING', 'Shopify 履约详情不存在');
      const page = parseConnection(pageFulfillment.fulfillmentLineItems, 'fulfillment.fulfillmentLineItems');
      page.nodes.forEach((node) => lines.set(requireString(node.id, 'fulfillmentLineItem.id'), node));
      pageInfo = page.pageInfo;
      pages += 1;
    }
    return {
      ...fulfillment,
      fulfillmentLineItems: { nodes: [...lines.values()], pageInfo: { hasNextPage: false, endCursor: null } },
    };
  }
}

type PageInfo = { hasNextPage: boolean; endCursor: string | null };

function parseConnection(value: unknown, field: string) {
  const connection = asRecord(value);
  const pageInfo = asRecord(connection?.pageInfo);
  if (!connection || !Array.isArray(connection.nodes) || !pageInfo || typeof pageInfo.hasNextPage !== 'boolean') {
    throw new ShopifyConnectorError('SHOPIFY_INVALID_RESPONSE', `${field} 分页结构无效`);
  }
  const nodes = connection.nodes.map((node) => {
    const record = asRecord(node);
    if (!record) throw new ShopifyConnectorError('SHOPIFY_INVALID_RESPONSE', `${field} 节点无效`);
    return record;
  });
  return {
    nodes,
    pageInfo: {
      hasNextPage: pageInfo.hasNextPage,
      endCursor: stringOrNull(pageInfo.endCursor),
    } satisfies PageInfo,
  };
}

function nextCursor(pageInfo: PageInfo, seen: Set<string>, field: string) {
  if (!pageInfo.hasNextPage || !pageInfo.endCursor || seen.has(pageInfo.endCursor)) {
    throw new ShopifyConnectorError('SHOPIFY_INVALID_CURSOR', `${field} 返回了无效或重复游标`);
  }
  seen.add(pageInfo.endCursor);
  return pageInfo.endCursor;
}

function readObjectArray(value: unknown, field: string) {
  if (!Array.isArray(value)) throw new ShopifyConnectorError('SHOPIFY_INVALID_RESPONSE', `${field} 不是数组`);
  return value.map((item) => {
    const record = asRecord(item);
    if (!record) throw new ShopifyConnectorError('SHOPIFY_INVALID_RESPONSE', `${field} 节点无效`);
    return record;
  });
}

function assertArrayNotTruncated(items: Array<Record<string, unknown>>, limit: number, field: string) {
  if (items.length >= limit) {
    throw new ShopifyConnectorError(
      'SHOPIFY_INCOMPLETE_ORDER_RESPONSE',
      `${field} 达到 Shopify 单次读取上限，已停止写入该订单以避免把截断数据当成完整事实`,
    );
  }
}

function isoSeconds(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new ShopifyConnectorError('INVALID_SYNC_WINDOW', '同步时间窗口无效');
  return date.toISOString().replace('.000Z', 'Z');
}
