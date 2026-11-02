import type { CanonicalOrderGraph } from './types';
import { sha256Hex, stableId, stableJson } from './stable';
import type { ShopifyCredentialConfig } from './shopify/config';
import type { ShopifyShopContext } from './shopify/connector';
import { ShopifyConnectorError } from './shopify/errors';

const SYNC_LEASE_MILLISECONDS = 60 * 60 * 1000;
const ORDER_WRITE_LEASE_MILLISECONDS = 2 * 60 * 1000;
const ORDER_WRITE_LEASE_WAIT_MILLISECONDS = 5 * 1000;
const ORDER_WRITE_LEASE_RETRY_MILLISECONDS = 25;

export type PlatformStoreRecord = {
  id: string;
  connectorKey: string;
  officialStoreId: string;
};

export type SyncStateRecord = {
  completedWatermark: string | null;
  activeWindowStart: string | null;
  activeWindowEnd: string | null;
  nextPageCursor: string | null;
  overlapSeconds: number;
  status: 'idle' | 'running' | 'failed';
  lastRunId: string | null;
};

export type SyncRunStats = {
  pagesCompleted: number;
  ordersSeen: number;
  ordersInserted: number;
  ordersUpdated: number;
  ordersUnchanged: number;
};

export class PlatformOrderRepository {
  constructor(
    private readonly db: D1Database,
    private readonly tenantId: string,
  ) {}

  async upsertVerifiedShopifyStore(
    config: ShopifyCredentialConfig,
    context: ShopifyShopContext,
    now: string,
  ): Promise<PlatformStoreRecord> {
    const storeBoundToAnotherConnector = await this.db.prepare(`
      SELECT connector_key
      FROM platform_stores
      WHERE tenant_id = ? AND platform = 'shopify' AND official_store_id = ?
      LIMIT 1
    `).bind(this.tenantId, context.id).first<{ connector_key: string }>();
    if (storeBoundToAnotherConnector && storeBoundToAnotherConnector.connector_key !== config.key) {
      throw new ShopifyConnectorError(
        'SHOPIFY_IDENTITY_ALREADY_BOUND',
        `${config.displayName} 的官方 Shop ID 已绑定到另一个 ERP 店铺配置，已停止写入`,
      );
    }
    const existing = await this.db.prepare(`
      SELECT id, connector_key, official_store_id
      FROM platform_stores
      WHERE tenant_id = ? AND platform = 'shopify' AND connector_key = ?
      LIMIT 1
    `).bind(this.tenantId, config.key).first<{
      id: string;
      connector_key: string;
      official_store_id: string;
    }>();
    if (existing && existing.official_store_id !== context.id) {
      throw new ShopifyConnectorError(
        'SHOPIFY_IDENTITY_CHANGED',
        `${config.displayName} 的官方 Shop ID 与 ERP 已验证身份不一致，已停止写入`,
      );
    }
    const id = existing?.id ?? await stableId('store', this.tenantId, 'shopify', context.id);
    await this.db.prepare(`
      INSERT INTO platform_stores (
        id, tenant_id, platform, connector_key, display_name, official_store_id,
        source_domain, source_timezone, source_timezone_offset, currency, api_version,
        credential_ref, identity_verified_at, active, last_successful_sync_at, created_at, updated_at
      ) VALUES (?, ?, 'shopify', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        display_name = excluded.display_name,
        source_domain = excluded.source_domain,
        source_timezone = excluded.source_timezone,
        source_timezone_offset = excluded.source_timezone_offset,
        currency = excluded.currency,
        api_version = excluded.api_version,
        credential_ref = excluded.credential_ref,
        identity_verified_at = excluded.identity_verified_at,
        active = 1,
        updated_at = excluded.updated_at
      WHERE platform_stores.connector_key = excluded.connector_key
        AND platform_stores.official_store_id = excluded.official_store_id
    `).bind(
      id,
      this.tenantId,
      config.key,
      context.name,
      context.id,
      context.domain,
      context.timezone,
      context.timezoneOffset,
      context.currency,
      '2026-07',
      config.credentialRef,
      now,
      now,
      now,
    ).run();
    const verified = await this.db.prepare(`
      SELECT connector_key, official_store_id
      FROM platform_stores
      WHERE id = ? AND tenant_id = ? AND platform = 'shopify'
      LIMIT 1
    `).bind(id, this.tenantId).first<{ connector_key: string; official_store_id: string }>();
    if (!verified || verified.connector_key !== config.key || verified.official_store_id !== context.id) {
      throw new ShopifyConnectorError(
        'SHOPIFY_IDENTITY_ALREADY_BOUND',
        `${config.displayName} 的官方 Shop ID 已绑定到另一个 ERP 店铺配置，已停止写入`,
      );
    }
    return { id, connectorKey: config.key, officialStoreId: context.id };
  }

  async getSyncState(storeId: string): Promise<SyncStateRecord | null> {
    const row = await this.db.prepare(`
      SELECT completed_watermark, active_window_start, active_window_end, next_page_cursor,
             overlap_seconds, status, last_run_id
      FROM connector_sync_state
      WHERE tenant_id = ? AND platform_store_id = ? AND connector = 'shopify' AND resource = 'orders'
      LIMIT 1
    `).bind(this.tenantId, storeId).first<{
      completed_watermark: string | null;
      active_window_start: string | null;
      active_window_end: string | null;
      next_page_cursor: string | null;
      overlap_seconds: number;
      status: SyncStateRecord['status'];
      last_run_id: string | null;
    }>();
    return row ? {
      completedWatermark: row.completed_watermark,
      activeWindowStart: row.active_window_start,
      activeWindowEnd: row.active_window_end,
      nextPageCursor: row.next_page_cursor,
      overlapSeconds: row.overlap_seconds,
      status: row.status,
      lastRunId: row.last_run_id,
    } : null;
  }

  async beginSyncRun(input: {
    storeId: string;
    mode: 'backfill' | 'incremental';
    windowStart: string;
    windowEnd: string;
    startingCursor: string | null;
    overlapSeconds: number;
    expectedLastRunId: string | null;
    expectedCompletedWatermark: string | null;
    now: string;
  }) {
    const runId = crypto.randomUUID();
    const stateId = await stableId('syncstate', this.tenantId, input.storeId, 'shopify', 'orders');
    const leaseExpiredBefore = new Date(new Date(input.now).getTime() - SYNC_LEASE_MILLISECONDS).toISOString();
    const results = await this.db.batch([
      this.db.prepare(`
        INSERT OR IGNORE INTO connector_sync_state (
          id, tenant_id, platform_store_id, connector, resource, completed_watermark,
          active_window_start, active_window_end, next_page_cursor, overlap_seconds,
          status, last_run_id, last_success_at, last_error_code, last_error_at, updated_at
        ) VALUES (?, ?, ?, 'shopify', 'orders', NULL, NULL, NULL, NULL, ?, 'idle', NULL, NULL, NULL, NULL, ?)
      `).bind(
        stateId,
        this.tenantId,
        input.storeId,
        input.overlapSeconds,
        input.now,
      ),
      this.db.prepare(`
        UPDATE connector_sync_state
        SET active_window_start = ?, active_window_end = ?, next_page_cursor = ?,
            overlap_seconds = ?, status = 'running', last_run_id = ?,
            last_error_code = NULL, last_error_at = NULL, updated_at = ?
        WHERE tenant_id = ? AND platform_store_id = ?
          AND connector = 'shopify' AND resource = 'orders'
          AND (status <> 'running' OR updated_at < ?)
          AND last_run_id IS ? AND completed_watermark IS ?
      `).bind(
        input.windowStart,
        input.windowEnd,
        input.startingCursor,
        input.overlapSeconds,
        runId,
        input.now,
        this.tenantId,
        input.storeId,
        leaseExpiredBefore,
        input.expectedLastRunId,
        input.expectedCompletedWatermark,
      ),
      this.db.prepare(`
        UPDATE connector_sync_runs
        SET status = 'failed', error_code = 'SHOPIFY_SYNC_LEASE_EXPIRED',
            error_message = '同步租约已过期并由新任务接管', finished_at = ?
        WHERE tenant_id = ? AND platform_store_id = ?
          AND connector = 'shopify' AND resource = 'orders'
          AND status = 'running' AND id <> ?
          AND EXISTS (
            SELECT 1 FROM connector_sync_state
            WHERE tenant_id = ? AND platform_store_id = ?
              AND connector = 'shopify' AND resource = 'orders'
              AND status = 'running' AND last_run_id = ?
          )
      `).bind(
        input.now,
        this.tenantId,
        input.storeId,
        runId,
        this.tenantId,
        input.storeId,
        runId,
      ),
      this.db.prepare(`
        INSERT INTO connector_sync_runs (
          id, tenant_id, platform_store_id, connector, resource, mode,
          window_start, window_end, starting_cursor, ending_cursor, status,
          pages_completed, orders_seen, orders_inserted, orders_updated, orders_unchanged,
          error_code, error_message, started_at, finished_at
        )
        SELECT ?, ?, ?, 'shopify', 'orders', ?, ?, ?, ?, ?, 'running',
               0, 0, 0, 0, 0, NULL, NULL, ?, NULL
        WHERE EXISTS (
          SELECT 1 FROM connector_sync_state
          WHERE tenant_id = ? AND platform_store_id = ?
            AND connector = 'shopify' AND resource = 'orders'
            AND status = 'running' AND last_run_id = ?
        )
      `).bind(
        runId,
        this.tenantId,
        input.storeId,
        input.mode,
        input.windowStart,
        input.windowEnd,
        input.startingCursor,
        input.startingCursor,
        input.now,
        this.tenantId,
        input.storeId,
        runId,
      ),
    ]);
    if (changedRows(results[3]) !== 1) {
      const current = await this.getSyncState(input.storeId);
      const running = current?.status === 'running';
      throw new ShopifyConnectorError(
        running ? 'SHOPIFY_SYNC_ALREADY_RUNNING' : 'SHOPIFY_SYNC_STATE_CHANGED',
        running
          ? '该店铺已有订单同步任务正在运行，请等待当前任务完成后再试'
          : '同步状态在任务启动前发生变化，请重新发起同步以使用最新水位',
        true,
      );
    }
    return runId;
  }

  async heartbeatSyncRun(input: { runId: string; storeId: string; now: string }) {
    const result = await this.db.prepare(`
      UPDATE connector_sync_state SET updated_at = ?
      WHERE tenant_id = ? AND platform_store_id = ?
        AND connector = 'shopify' AND resource = 'orders'
        AND status = 'running' AND last_run_id = ?
    `).bind(input.now, this.tenantId, input.storeId, input.runId).run();
    if (changedRows(result) !== 1) throw syncLeaseLost();
  }

  async checkpointPage(input: {
    runId: string;
    storeId: string;
    nextCursor: string | null;
    stats: SyncRunStats;
    now: string;
  }) {
    const results = await this.db.batch([
      this.db.prepare(`
        UPDATE connector_sync_runs
        SET ending_cursor = ?, pages_completed = ?, orders_seen = ?, orders_inserted = ?,
            orders_updated = ?, orders_unchanged = ?
        WHERE id = ? AND tenant_id = ? AND status = 'running'
          AND EXISTS (
            SELECT 1 FROM connector_sync_state
            WHERE tenant_id = ? AND platform_store_id = ?
              AND connector = 'shopify' AND resource = 'orders'
              AND status = 'running' AND last_run_id = ?
          )
      `).bind(
        input.nextCursor,
        input.stats.pagesCompleted,
        input.stats.ordersSeen,
        input.stats.ordersInserted,
        input.stats.ordersUpdated,
        input.stats.ordersUnchanged,
        input.runId,
        this.tenantId,
        this.tenantId,
        input.storeId,
        input.runId,
      ),
      this.db.prepare(`
        UPDATE connector_sync_state
        SET next_page_cursor = ?, status = 'running', updated_at = ?
        WHERE tenant_id = ? AND platform_store_id = ? AND connector = 'shopify' AND resource = 'orders'
          AND status = 'running' AND last_run_id = ?
      `).bind(input.nextCursor, input.now, this.tenantId, input.storeId, input.runId),
    ]);
    if (changedRows(results[1]) !== 1) throw syncLeaseLost();
  }

  async completeSyncRun(input: {
    runId: string;
    storeId: string;
    windowEnd: string;
    stats: SyncRunStats;
    now: string;
  }) {
    const results = await this.db.batch([
      this.db.prepare(`
        UPDATE connector_sync_runs
        SET status = 'succeeded', pages_completed = ?, orders_seen = ?, orders_inserted = ?,
            orders_updated = ?, orders_unchanged = ?, finished_at = ?
        WHERE id = ? AND tenant_id = ? AND status = 'running'
          AND EXISTS (
            SELECT 1 FROM connector_sync_state
            WHERE tenant_id = ? AND platform_store_id = ?
              AND connector = 'shopify' AND resource = 'orders'
              AND status = 'running' AND last_run_id = ?
          )
      `).bind(
        input.stats.pagesCompleted,
        input.stats.ordersSeen,
        input.stats.ordersInserted,
        input.stats.ordersUpdated,
        input.stats.ordersUnchanged,
        input.now,
        input.runId,
        this.tenantId,
        this.tenantId,
        input.storeId,
        input.runId,
      ),
      this.db.prepare(`
        UPDATE connector_sync_state
        SET completed_watermark = ?, active_window_start = NULL, active_window_end = NULL,
            next_page_cursor = NULL, status = 'idle', last_success_at = ?,
            last_error_code = NULL, last_error_at = NULL, updated_at = ?
        WHERE tenant_id = ? AND platform_store_id = ? AND connector = 'shopify' AND resource = 'orders'
          AND status = 'running' AND last_run_id = ?
      `).bind(input.windowEnd, input.now, input.now, this.tenantId, input.storeId, input.runId),
      this.db.prepare(`
        UPDATE platform_stores SET last_successful_sync_at = ?, updated_at = ?
        WHERE id = ? AND tenant_id = ?
          AND EXISTS (
            SELECT 1 FROM connector_sync_state
            WHERE tenant_id = ? AND platform_store_id = ?
              AND connector = 'shopify' AND resource = 'orders'
              AND status = 'idle' AND last_run_id = ? AND completed_watermark = ?
          )
      `).bind(
        input.now,
        input.now,
        input.storeId,
        this.tenantId,
        this.tenantId,
        input.storeId,
        input.runId,
        input.windowEnd,
      ),
    ]);
    if (changedRows(results[1]) !== 1) throw syncLeaseLost();
  }

  async failSyncRun(input: {
    runId: string;
    storeId: string;
    errorCode: string;
    errorMessage: string;
    stats: SyncRunStats;
    now: string;
  }) {
    await this.db.batch([
      this.db.prepare(`
        UPDATE connector_sync_runs
        SET status = 'failed', pages_completed = ?, orders_seen = ?, orders_inserted = ?,
            orders_updated = ?, orders_unchanged = ?, error_code = ?, error_message = ?, finished_at = ?
        WHERE id = ? AND tenant_id = ? AND status = 'running'
      `).bind(
        input.stats.pagesCompleted,
        input.stats.ordersSeen,
        input.stats.ordersInserted,
        input.stats.ordersUpdated,
        input.stats.ordersUnchanged,
        input.errorCode,
        input.errorMessage,
        input.now,
        input.runId,
        this.tenantId,
      ),
      this.db.prepare(`
        UPDATE connector_sync_state
        SET status = 'failed', last_error_code = ?, last_error_at = ?, updated_at = ?
        WHERE tenant_id = ? AND platform_store_id = ? AND connector = 'shopify' AND resource = 'orders'
          AND status = 'running' AND last_run_id = ?
      `).bind(input.errorCode, input.now, input.now, this.tenantId, input.storeId, input.runId),
    ]);
  }

  async upsertOrderGraph(input: {
    storeId: string;
    graph: CanonicalOrderGraph;
    apiVersion: string;
    runId: string | null;
    fetchedAt: string;
  }): Promise<'inserted' | 'updated' | 'unchanged'> {
    const orderId = await stableId('porder', this.tenantId, input.storeId, input.graph.sourceOrderId);
    const leaseId = await this.acquireOrderWriteLease(orderId);
    try {
      return await this.upsertOrderGraphWithLease(orderId, input);
    } finally {
      await this.releaseOrderWriteLease(orderId, leaseId);
    }
  }

  private async upsertOrderGraphWithLease(
    orderId: string,
    input: {
      storeId: string;
      graph: CanonicalOrderGraph;
      apiVersion: string;
      runId: string | null;
      fetchedAt: string;
    },
  ): Promise<'inserted' | 'updated' | 'unchanged'> {
    const rawJson = stableJson(input.graph.raw);
    const rawHash = await sha256Hex(rawJson);
    const existing = await this.db.prepare(
      'SELECT raw_hash, source_updated_at FROM platform_orders WHERE id = ? AND tenant_id = ? LIMIT 1',
    ).bind(orderId, this.tenantId).first<{ raw_hash: string; source_updated_at: string }>();
    if (existing && Date.parse(existing.source_updated_at) > Date.parse(input.graph.sourceUpdatedAt)) {
      await this.db.batch([
        this.db.prepare(`
          UPDATE platform_orders SET fetched_at = ?, last_seen_at = ?
          WHERE id = ? AND tenant_id = ?
        `).bind(input.fetchedAt, input.fetchedAt, orderId, this.tenantId),
        this.purchaseDemandRefreshStatement(orderId, input.fetchedAt),
      ]);
      return 'unchanged';
    }
    if (existing?.raw_hash === rawHash) {
      await this.db.batch([
        this.db.prepare(`
          UPDATE platform_orders SET fetched_at = ?, last_seen_at = ?
          WHERE id = ? AND tenant_id = ?
        `).bind(input.fetchedAt, input.fetchedAt, orderId, this.tenantId),
        this.purchaseDemandRefreshStatement(orderId, input.fetchedAt),
      ]);
      return 'unchanged';
    }

    const statements: D1PreparedStatement[] = [];
    statements.push(this.orderUpsertStatement(orderId, input, rawJson, rawHash));
    statements.push(...this.markOrderChildrenNotCurrent(orderId));

    for (const line of input.graph.lines) {
      const lineId = await stableId('poline', orderId, line.sourceLineId);
      const lineJson = stableJson(line.raw);
      const lineHash = await sha256Hex(lineJson);
      statements.push(this.db.prepare(`
        INSERT INTO platform_order_lines (
          id, tenant_id, order_id, source_order_line_id, raw_sku, normalized_sku,
          source_product_id, source_variant_id, title, name, ordered_quantity, current_quantity,
          unfulfilled_quantity, currency, unit_price_amount, unit_price_minor,
          original_total_amount, original_total_minor, discounted_total_amount, discounted_total_minor,
          discount_amount, discount_minor, mapped_sku_id, mapping_status, raw_json, raw_hash,
          is_current, first_seen_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'unmapped', ?, ?, 1, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          raw_sku = excluded.raw_sku, normalized_sku = excluded.normalized_sku,
          source_product_id = excluded.source_product_id, source_variant_id = excluded.source_variant_id,
          title = excluded.title, name = excluded.name, ordered_quantity = excluded.ordered_quantity,
          current_quantity = excluded.current_quantity, unfulfilled_quantity = excluded.unfulfilled_quantity,
          currency = excluded.currency, unit_price_amount = excluded.unit_price_amount,
          unit_price_minor = excluded.unit_price_minor, original_total_amount = excluded.original_total_amount,
          original_total_minor = excluded.original_total_minor, discounted_total_amount = excluded.discounted_total_amount,
          discounted_total_minor = excluded.discounted_total_minor, discount_amount = excluded.discount_amount,
          discount_minor = excluded.discount_minor, raw_json = excluded.raw_json, raw_hash = excluded.raw_hash,
          is_current = 1, last_seen_at = excluded.last_seen_at
      `).bind(
        lineId, this.tenantId, orderId, line.sourceLineId, line.rawSku, line.normalizedSku,
        line.sourceProductId, line.sourceVariantId, line.title, line.name, line.orderedQuantity,
        line.currentQuantity, line.unfulfilledQuantity, firstCurrency(line),
        line.unitPrice?.amount ?? null, line.unitPrice?.minor ?? null,
        line.originalTotal?.amount ?? null, line.originalTotal?.minor ?? null,
        line.discountedTotal?.amount ?? null, line.discountedTotal?.minor ?? null,
        line.discount?.amount ?? null, line.discount?.minor ?? null,
        lineJson, lineHash, input.fetchedAt, input.fetchedAt,
      ));
      if (line.rawSku && line.normalizedSku) {
        const mappingId = await stableId('skumap', this.tenantId, input.storeId, line.rawSku);
        statements.push(this.db.prepare(`
          INSERT INTO platform_sku_mappings (
            id, tenant_id, platform_store_id, raw_sku, normalized_sku, sku_id,
            status, mapping_source, rule_version, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, NULL, 'unmapped', 'connector_observation', NULL, ?, ?)
          ON CONFLICT(platform_store_id, raw_sku) DO UPDATE SET
            normalized_sku = excluded.normalized_sku,
            updated_at = excluded.updated_at
        `).bind(mappingId, this.tenantId, input.storeId, line.rawSku, line.normalizedSku, input.fetchedAt, input.fetchedAt));
      }
    }

    for (const refund of input.graph.refunds) {
      const refundId = await stableId('prefund', orderId, refund.sourceRefundId);
      const refundJson = stableJson(refund.raw);
      const refundHash = await sha256Hex(refundJson);
      statements.push(this.db.prepare(`
        INSERT INTO platform_refunds (
          id, tenant_id, order_id, source_refund_id, source_created_at, source_updated_at,
          note, currency, amount, amount_minor, raw_json, raw_hash, is_current, first_seen_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          source_created_at = excluded.source_created_at, source_updated_at = excluded.source_updated_at,
          note = excluded.note, currency = excluded.currency, amount = excluded.amount,
          amount_minor = excluded.amount_minor, raw_json = excluded.raw_json, raw_hash = excluded.raw_hash,
          is_current = 1, last_seen_at = excluded.last_seen_at
      `).bind(
        refundId, this.tenantId, orderId, refund.sourceRefundId, refund.sourceCreatedAt,
        refund.sourceUpdatedAt, refund.note, refund.amount?.currency ?? null, refund.amount?.amount ?? null,
        refund.amount?.minor ?? null, refundJson, refundHash, input.fetchedAt, input.fetchedAt,
      ));
      for (const line of refund.lines) {
        const refundLineId = await stableId('prline', refundId, line.sourceRefundLineId);
        const lineJson = stableJson(line.raw);
        statements.push(this.db.prepare(`
          INSERT INTO platform_refund_lines (
            id, tenant_id, order_id, refund_id, source_refund_line_id, source_order_line_id,
            quantity, restock_type, source_location_id, currency, subtotal_amount, subtotal_minor,
            tax_amount, tax_minor, raw_json, raw_hash, is_current, first_seen_at, last_seen_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            source_order_line_id = excluded.source_order_line_id, quantity = excluded.quantity,
            restock_type = excluded.restock_type, source_location_id = excluded.source_location_id,
            currency = excluded.currency, subtotal_amount = excluded.subtotal_amount,
            subtotal_minor = excluded.subtotal_minor, tax_amount = excluded.tax_amount,
            tax_minor = excluded.tax_minor, raw_json = excluded.raw_json, raw_hash = excluded.raw_hash,
            is_current = 1, last_seen_at = excluded.last_seen_at
        `).bind(
          refundLineId, this.tenantId, orderId, refundId, line.sourceRefundLineId,
          line.sourceOrderLineId, line.quantity, line.restockType, line.sourceLocationId,
          line.subtotal?.currency ?? line.tax?.currency ?? null,
          line.subtotal?.amount ?? null, line.subtotal?.minor ?? null,
          line.tax?.amount ?? null, line.tax?.minor ?? null,
          lineJson, await sha256Hex(lineJson), input.fetchedAt, input.fetchedAt,
        ));
      }
      for (const transaction of refund.transactions) {
        const transactionId = await stableId('ptxn', orderId, transaction.sourceTransactionId);
        const transactionJson = stableJson(transaction.raw);
        statements.push(this.db.prepare(`
          INSERT INTO platform_order_transactions (
            id, tenant_id, order_id, refund_id, source_transaction_id, source_parent_transaction_id,
            kind, status, gateway, test, currency, amount, amount_minor, source_created_at,
            source_processed_at, raw_json, raw_hash, is_current, first_seen_at, last_seen_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            refund_id = excluded.refund_id, source_parent_transaction_id = excluded.source_parent_transaction_id,
            kind = excluded.kind, status = excluded.status, gateway = excluded.gateway, test = excluded.test,
            currency = excluded.currency, amount = excluded.amount, amount_minor = excluded.amount_minor,
            source_created_at = excluded.source_created_at, source_processed_at = excluded.source_processed_at,
            raw_json = excluded.raw_json, raw_hash = excluded.raw_hash, is_current = 1,
            last_seen_at = excluded.last_seen_at
        `).bind(
          transactionId, this.tenantId, orderId, refundId, transaction.sourceTransactionId,
          transaction.sourceParentTransactionId, transaction.kind, transaction.status, transaction.gateway,
          transaction.test, transaction.amount?.currency ?? null, transaction.amount?.amount ?? null,
          transaction.amount?.minor ?? null, transaction.sourceCreatedAt, transaction.sourceProcessedAt,
          transactionJson, await sha256Hex(transactionJson), input.fetchedAt, input.fetchedAt,
        ));
      }
    }

    for (const fulfillment of input.graph.fulfillments) {
      const fulfillmentId = await stableId('pfulfillment', orderId, fulfillment.sourceFulfillmentId);
      const fulfillmentJson = stableJson(fulfillment.raw);
      statements.push(this.db.prepare(`
        INSERT INTO platform_fulfillments (
          id, tenant_id, order_id, source_fulfillment_id, status, shipment_status,
          source_location_id, source_created_at, source_updated_at, delivered_at,
          estimated_delivery_at, raw_json, raw_hash, is_current, first_seen_at, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          status = excluded.status, shipment_status = excluded.shipment_status,
          source_location_id = excluded.source_location_id, source_created_at = excluded.source_created_at,
          source_updated_at = excluded.source_updated_at, delivered_at = excluded.delivered_at,
          estimated_delivery_at = excluded.estimated_delivery_at, raw_json = excluded.raw_json,
          raw_hash = excluded.raw_hash, is_current = 1, last_seen_at = excluded.last_seen_at
      `).bind(
        fulfillmentId, this.tenantId, orderId, fulfillment.sourceFulfillmentId,
        fulfillment.status, fulfillment.shipmentStatus, fulfillment.sourceLocationId,
        fulfillment.sourceCreatedAt, fulfillment.sourceUpdatedAt, fulfillment.deliveredAt,
        fulfillment.estimatedDeliveryAt, fulfillmentJson, await sha256Hex(fulfillmentJson),
        input.fetchedAt, input.fetchedAt,
      ));
      for (const line of fulfillment.lines) {
        const fulfillmentLineId = await stableId('pfline', fulfillmentId, line.sourceFulfillmentLineId);
        const lineJson = stableJson(line.raw);
        statements.push(this.db.prepare(`
          INSERT INTO platform_fulfillment_lines (
            id, tenant_id, order_id, fulfillment_id, source_fulfillment_line_id,
            source_order_line_id, quantity, raw_json, raw_hash, is_current, first_seen_at, last_seen_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            source_order_line_id = excluded.source_order_line_id, quantity = excluded.quantity,
            raw_json = excluded.raw_json, raw_hash = excluded.raw_hash, is_current = 1,
            last_seen_at = excluded.last_seen_at
        `).bind(
          fulfillmentLineId, this.tenantId, orderId, fulfillmentId, line.sourceFulfillmentLineId,
          line.sourceOrderLineId, line.quantity, lineJson, await sha256Hex(lineJson),
          input.fetchedAt, input.fetchedAt,
        ));
      }
      for (const tracking of fulfillment.tracking) {
        const identity = tracking.number ?? tracking.url ?? await sha256Hex(stableJson(tracking.raw));
        const trackingId = await stableId('ptracking', fulfillmentId, identity);
        const trackingJson = stableJson(tracking.raw);
        statements.push(this.db.prepare(`
          INSERT INTO platform_fulfillment_tracking (
            id, tenant_id, order_id, fulfillment_id, sequence, company, tracking_number,
            tracking_url, raw_json, raw_hash, is_current, first_seen_at, last_seen_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            sequence = excluded.sequence, company = excluded.company,
            tracking_number = excluded.tracking_number, tracking_url = excluded.tracking_url,
            raw_json = excluded.raw_json, raw_hash = excluded.raw_hash, is_current = 1,
            last_seen_at = excluded.last_seen_at
        `).bind(
          trackingId, this.tenantId, orderId, fulfillmentId, tracking.sequence, tracking.company,
          tracking.number, tracking.url, trackingJson, await sha256Hex(trackingJson),
          input.fetchedAt, input.fetchedAt,
        ));
      }
    }

    const snapshotId = await stableId('posnapshot', orderId, rawHash);
    statements.push(this.purchaseDemandRefreshStatement(orderId, input.fetchedAt));
    statements.push(this.db.prepare(`
      INSERT OR IGNORE INTO platform_order_snapshots (
        id, tenant_id, order_id, sync_run_id, source_updated_at, raw_hash, raw_json, fetched_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      snapshotId, this.tenantId, orderId, input.runId, input.graph.sourceUpdatedAt,
      rawHash, rawJson, input.fetchedAt,
    ));
    await this.db.batch(statements);
    return existing ? 'updated' : 'inserted';
  }

  private async acquireOrderWriteLease(orderId: string) {
    const leaseId = crypto.randomUUID();
    const deadline = Date.now() + ORDER_WRITE_LEASE_WAIT_MILLISECONDS;
    while (true) {
      const now = new Date().toISOString();
      const expiresAt = new Date(Date.now() + ORDER_WRITE_LEASE_MILLISECONDS).toISOString();
      const results = await this.db.batch([
        this.db.prepare(`
          INSERT OR IGNORE INTO platform_order_write_leases (
            order_id, tenant_id, lease_id, lease_expires_at, updated_at
          ) VALUES (?, ?, NULL, NULL, ?)
        `).bind(orderId, this.tenantId, now),
        this.db.prepare(`
          UPDATE platform_order_write_leases
          SET lease_id = ?, lease_expires_at = ?, updated_at = ?
          WHERE order_id = ? AND tenant_id = ?
            AND (lease_id IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= ?)
        `).bind(leaseId, expiresAt, now, orderId, this.tenantId, now),
      ]);
      if (changedRows(results[1]) === 1) return leaseId;
      if (Date.now() >= deadline) {
        throw new ShopifyConnectorError(
          'SHOPIFY_ORDER_WRITE_BUSY',
          '同一订单正在由另一同步任务更新，请稍后重试',
          true,
          409,
        );
      }
      await wait(ORDER_WRITE_LEASE_RETRY_MILLISECONDS);
    }
  }

  private async releaseOrderWriteLease(orderId: string, leaseId: string) {
    await this.db.prepare(`
      UPDATE platform_order_write_leases
      SET lease_id = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE order_id = ? AND tenant_id = ? AND lease_id = ?
    `).bind(new Date().toISOString(), orderId, this.tenantId, leaseId).run();
  }

  private orderUpsertStatement(
    orderId: string,
    input: {
      storeId: string;
      graph: CanonicalOrderGraph;
      apiVersion: string;
      runId: string | null;
      fetchedAt: string;
    },
    rawJson: string,
    rawHash: string,
  ) {
    const order = input.graph;
    return this.db.prepare(`
      INSERT INTO platform_orders (
        id, tenant_id, platform_store_id, platform, source_order_id, source_order_name,
        source_created_at, source_updated_at, source_processed_at, source_cancelled_at,
        source_closed_at, source_timezone, business_date, test, financial_status,
        fulfillment_status, currency, subtotal_amount, subtotal_minor, discount_amount,
        discount_minor, shipping_amount, shipping_minor, tax_amount, tax_minor,
        original_total_amount, original_total_minor, current_total_amount, current_total_minor,
        received_amount, received_minor, refunded_amount, refunded_minor, business_ownership,
        api_version, raw_json, raw_hash, fetched_at, first_seen_at, last_seen_at
      ) VALUES (?, ?, ?, 'shopify', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        source_order_name = excluded.source_order_name, source_created_at = excluded.source_created_at,
        source_updated_at = excluded.source_updated_at, source_processed_at = excluded.source_processed_at,
        source_cancelled_at = excluded.source_cancelled_at, source_closed_at = excluded.source_closed_at,
        source_timezone = excluded.source_timezone, business_date = excluded.business_date,
        test = excluded.test, financial_status = excluded.financial_status,
        fulfillment_status = excluded.fulfillment_status, currency = excluded.currency,
        subtotal_amount = excluded.subtotal_amount, subtotal_minor = excluded.subtotal_minor,
        discount_amount = excluded.discount_amount, discount_minor = excluded.discount_minor,
        shipping_amount = excluded.shipping_amount, shipping_minor = excluded.shipping_minor,
        tax_amount = excluded.tax_amount, tax_minor = excluded.tax_minor,
        original_total_amount = excluded.original_total_amount,
        original_total_minor = excluded.original_total_minor,
        current_total_amount = excluded.current_total_amount,
        current_total_minor = excluded.current_total_minor,
        received_amount = excluded.received_amount, received_minor = excluded.received_minor,
        refunded_amount = excluded.refunded_amount, refunded_minor = excluded.refunded_minor,
        business_ownership = excluded.business_ownership, api_version = excluded.api_version,
        raw_json = excluded.raw_json, raw_hash = excluded.raw_hash, fetched_at = excluded.fetched_at,
        last_seen_at = excluded.last_seen_at
    `).bind(
      orderId, this.tenantId, input.storeId, order.sourceOrderId, order.sourceOrderName,
      order.sourceCreatedAt, order.sourceUpdatedAt, order.sourceProcessedAt, order.sourceCancelledAt,
      order.sourceClosedAt, order.sourceTimezone, order.businessDate, order.test,
      order.financialStatus, order.fulfillmentStatus, order.currency,
      order.subtotal?.amount ?? null, order.subtotal?.minor ?? null,
      order.discount?.amount ?? null, order.discount?.minor ?? null,
      order.shipping?.amount ?? null, order.shipping?.minor ?? null,
      order.tax?.amount ?? null, order.tax?.minor ?? null,
      order.originalTotal?.amount ?? null, order.originalTotal?.minor ?? null,
      order.currentTotal?.amount ?? null, order.currentTotal?.minor ?? null,
      order.received?.amount ?? null, order.received?.minor ?? null,
      order.refunded?.amount ?? null, order.refunded?.minor ?? null,
      order.businessOwnership, input.apiVersion, rawJson, rawHash,
      input.fetchedAt, input.fetchedAt, input.fetchedAt,
    );
  }

  private markOrderChildrenNotCurrent(orderId: string) {
    return [
      'platform_order_lines',
      'platform_refunds',
      'platform_refund_lines',
      'platform_order_transactions',
      'platform_fulfillments',
      'platform_fulfillment_lines',
      'platform_fulfillment_tracking',
    ].map((table) => this.db.prepare(`UPDATE ${table} SET is_current = 0 WHERE order_id = ? AND is_current = 1`).bind(orderId));
  }

  private purchaseDemandRefreshStatement(orderId: string, refreshedAt: string) {
    return this.db.prepare(`
      WITH demand_source AS (
        SELECT
          'pdemand_' || l.id AS id,
          po.tenant_id,
          po.platform_store_id,
          po.id AS order_id,
          l.id AS order_line_id,
          po.platform,
          po.source_order_id,
          l.source_order_line_id,
          l.raw_sku,
          l.normalized_sku,
          CASE
            WHEN l.mapping_status = 'mapped' AND l.mapped_sku_id IS NOT NULL THEN l.mapped_sku_id
            WHEN pm.status = 'mapped' AND pm.sku_id IS NOT NULL THEN pm.sku_id
            ELSE NULL
          END AS effective_sku_id,
          CASE
            WHEN (l.mapping_status = 'mapped' AND l.mapped_sku_id IS NOT NULL)
              OR (pm.status = 'mapped' AND pm.sku_id IS NOT NULL) THEN 'mapped'
            WHEN l.mapping_status = 'ambiguous' OR pm.status = 'ambiguous' THEN 'ambiguous'
            ELSE 'unmapped'
          END AS effective_mapping_status,
          l.ordered_quantity,
          l.current_quantity,
          l.unfulfilled_quantity,
          CASE
            WHEN l.current_quantity IS NOT NULL AND l.unfulfilled_quantity IS NOT NULL
              THEN MAX(0, MIN(l.current_quantity, l.unfulfilled_quantity))
            ELSE MAX(0, COALESCE(l.unfulfilled_quantity, l.current_quantity, l.ordered_quantity, 0))
          END AS candidate_quantity,
          l.is_current,
          po.test,
          po.source_cancelled_at,
          po.fulfillment_status,
          po.source_updated_at
        FROM platform_order_lines l
        JOIN platform_orders po
          ON po.id = l.order_id AND po.tenant_id = l.tenant_id
        LEFT JOIN platform_sku_mappings pm
          ON pm.tenant_id = l.tenant_id
          AND pm.platform_store_id = po.platform_store_id
          AND pm.raw_sku = l.raw_sku
        WHERE po.id = ? AND po.tenant_id = ?
      )
      INSERT INTO purchase_demands (
        id, tenant_id, platform_store_id, order_id, order_line_id, platform,
        source_order_id, source_order_line_id, raw_sku, normalized_sku, mapped_sku_id,
        status, ordered_quantity, current_quantity, unfulfilled_quantity, required_quantity,
        reason_code, source_updated_at, first_seen_at, last_refreshed_at, updated_at
      )
      SELECT
        id, tenant_id, platform_store_id, order_id, order_line_id, platform,
        source_order_id, source_order_line_id, raw_sku, normalized_sku, effective_sku_id,
        CASE
          WHEN is_current = 0 OR test = 1 OR source_cancelled_at IS NOT NULL
            OR UPPER(COALESCE(fulfillment_status, '')) = 'FULFILLED'
            OR candidate_quantity <= 0 THEN 'not_required'
          WHEN effective_sku_id IS NULL OR effective_mapping_status <> 'mapped' THEN 'needs_mapping'
          ELSE 'open'
        END,
        ordered_quantity, current_quantity, unfulfilled_quantity,
        CASE
          WHEN is_current = 0 OR test = 1 OR source_cancelled_at IS NOT NULL
            OR UPPER(COALESCE(fulfillment_status, '')) = 'FULFILLED'
            OR candidate_quantity <= 0 THEN 0
          ELSE candidate_quantity
        END,
        CASE
          WHEN is_current = 0 THEN 'line_removed'
          WHEN test = 1 THEN 'test_order'
          WHEN source_cancelled_at IS NOT NULL THEN 'cancelled_order'
          WHEN UPPER(COALESCE(fulfillment_status, '')) = 'FULFILLED' THEN 'fulfilled_order'
          WHEN candidate_quantity <= 0 THEN 'no_unfulfilled_quantity'
          WHEN effective_sku_id IS NULL AND (raw_sku IS NULL OR TRIM(raw_sku) = '') THEN 'sku_missing'
          WHEN effective_mapping_status = 'ambiguous' THEN 'sku_ambiguous'
          WHEN effective_sku_id IS NULL OR effective_mapping_status <> 'mapped' THEN 'sku_unmapped'
          ELSE NULL
        END,
        source_updated_at, ?, ?, ?
      FROM demand_source
      WHERE 1 = 1
      ON CONFLICT(tenant_id, platform_store_id, source_order_id, source_order_line_id)
      DO UPDATE SET
        order_id = excluded.order_id,
        order_line_id = excluded.order_line_id,
        platform = excluded.platform,
        raw_sku = excluded.raw_sku,
        normalized_sku = excluded.normalized_sku,
        mapped_sku_id = excluded.mapped_sku_id,
        status = excluded.status,
        ordered_quantity = excluded.ordered_quantity,
        current_quantity = excluded.current_quantity,
        unfulfilled_quantity = excluded.unfulfilled_quantity,
        required_quantity = excluded.required_quantity,
        reason_code = excluded.reason_code,
        source_updated_at = excluded.source_updated_at,
        last_refreshed_at = excluded.last_refreshed_at,
        updated_at = excluded.updated_at
    `).bind(orderId, this.tenantId, refreshedAt, refreshedAt, refreshedAt);
  }
}

function firstCurrency(line: CanonicalOrderGraph['lines'][number]) {
  return line.unitPrice?.currency
    ?? line.originalTotal?.currency
    ?? line.discountedTotal?.currency
    ?? line.discount?.currency
    ?? null;
}

function changedRows(result: D1Result<unknown> | undefined) {
  return Number(result?.meta?.changes ?? 0);
}

function wait(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function syncLeaseLost() {
  return new ShopifyConnectorError(
    'SHOPIFY_SYNC_LEASE_LOST',
    '该同步任务已被新的任务接管，当前任务已停止',
    true,
  );
}
