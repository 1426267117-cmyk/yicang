import type { ShopifyOrderSyncInput } from '../../contracts';
import { PlatformOrderRepository, type SyncRunStats } from '../repository';
import { SHOPIFY_API_VERSION, type ShopifyCredentialConfig } from './config';
import { ShopifyOrderConnector } from './connector';
import { sanitizedConnectorError, ShopifyConnectorError } from './errors';

const DEFAULT_OVERLAP_SECONDS = 6 * 60 * 60;
const INITIAL_BACKFILL_MILLISECONDS = 7 * 24 * 60 * 60 * 1000;

export type ShopifyScheduledAuthorization = {
  officialStoreId: string;
  initialBackfillEnabled: boolean;
};

export async function runShopifyOrderSync(input: {
  request: ShopifyOrderSyncInput;
  config: ShopifyCredentialConfig;
  connector: Pick<ShopifyOrderConnector, 'getShopContext' | 'fetchOrdersPage' | 'fetchOrder'>;
  repository: PlatformOrderRepository;
  scheduledAuthorization?: ShopifyScheduledAuthorization;
  now?: () => Date;
}) {
  const nowFn = input.now ?? (() => new Date());
  const startedAt = nowFn().toISOString();
  const context = await input.connector.getShopContext();
  if (input.scheduledAuthorization && context.id !== input.scheduledAuthorization.officialStoreId) {
    throw new ShopifyConnectorError('SHOPIFY_IDENTITY_MISMATCH', 'Shopify 返回的官方 Shop ID 与租户已保存的授权不一致');
  }
  const store = await input.repository.upsertVerifiedShopifyStore(input.config, context, startedAt);
  const previousState = await input.repository.getSyncState(store.id);
  const window = determineWindow(input.request, previousState, startedAt, input.scheduledAuthorization?.initialBackfillEnabled ?? false);
  verifyHistoricalScope(window.start, startedAt, context.scopes);

  const runId = await input.repository.beginSyncRun({
    storeId: store.id,
    mode: window.mode,
    windowStart: window.start,
    windowEnd: window.end,
    startingCursor: window.cursor,
    overlapSeconds: window.overlapSeconds,
    expectedLastRunId: previousState?.lastRunId ?? null,
    expectedCompletedWatermark: previousState?.completedWatermark ?? null,
    now: startedAt,
  });
  const stats: SyncRunStats = {
    pagesCompleted: 0,
    ordersSeen: 0,
    ordersInserted: 0,
    ordersUpdated: 0,
    ordersUnchanged: 0,
  };
  let after = window.cursor;
  const seenPageCursors = new Set<string>(after ? [after] : []);

  try {
    while (true) {
      if (stats.pagesCompleted >= input.request.maxPages) {
        throw new ShopifyConnectorError(
          'SHOPIFY_PAGE_LIMIT_REACHED',
          '本次请求达到安全页数上限，已保存断点，可继续运行',
          true,
        );
      }
      await input.repository.heartbeatSyncRun({
        runId,
        storeId: store.id,
        now: nowFn().toISOString(),
      });
      const page = await input.connector.fetchOrdersPage({
        updatedFrom: window.start,
        updatedTo: window.end,
        after,
        first: 10,
      });
      for (const orderRef of page.nodes) {
        await input.repository.heartbeatSyncRun({
          runId,
          storeId: store.id,
          now: nowFn().toISOString(),
        });
        const graph = await input.connector.fetchOrder(orderRef.id, context);
        await input.repository.heartbeatSyncRun({
          runId,
          storeId: store.id,
          now: nowFn().toISOString(),
        });
        const result = await input.repository.upsertOrderGraph({
          storeId: store.id,
          graph,
          apiVersion: SHOPIFY_API_VERSION,
          runId,
          fetchedAt: nowFn().toISOString(),
        });
        stats.ordersSeen += 1;
        if (result === 'inserted') stats.ordersInserted += 1;
        if (result === 'updated') stats.ordersUpdated += 1;
        if (result === 'unchanged') stats.ordersUnchanged += 1;
      }
      stats.pagesCompleted += 1;
      after = page.hasNextPage ? requireNextCursor(page.endCursor, seenPageCursors) : null;
      await input.repository.checkpointPage({
        runId,
        storeId: store.id,
        nextCursor: after,
        stats,
        now: nowFn().toISOString(),
      });
      if (!page.hasNextPage) break;
    }

    const finishedAt = nowFn().toISOString();
    await input.repository.completeSyncRun({
      runId,
      storeId: store.id,
      windowEnd: window.end,
      stats,
      now: finishedAt,
    });
    return {
      ok: true as const,
      runId,
      store: {
        key: input.config.key,
        name: context.name,
        officialStoreId: context.id,
        domain: context.domain,
      },
      apiVersion: SHOPIFY_API_VERSION,
      mode: window.mode,
      window: { from: window.start, to: window.end, overlapSeconds: window.overlapSeconds },
      stats,
      completedAt: finishedAt,
    };
  } catch (error) {
    const sanitized = sanitizedConnectorError(error);
    await input.repository.failSyncRun({
      runId,
      storeId: store.id,
      errorCode: sanitized.code,
      errorMessage: sanitized.message,
      stats,
      now: nowFn().toISOString(),
    });
    throw error;
  }
}

function determineWindow(
  request: ShopifyOrderSyncInput,
  state: Awaited<ReturnType<PlatformOrderRepository['getSyncState']>>,
  now: string,
  initialBackfillEnabled: boolean,
) {
  const overlapSeconds = state?.overlapSeconds ?? DEFAULT_OVERLAP_SECONDS;
  const requestedStart = request.from ? new Date(request.from).toISOString() : null;
  const requestedEnd = request.to ? new Date(request.to).toISOString() : null;
  const automaticInitialBackfill = initialBackfillEnabled && request.mode === 'incremental'
    && !requestedStart && !requestedEnd && !state?.completedWatermark;
  const mode: ShopifyOrderSyncInput['mode'] = automaticInitialBackfill ? 'backfill' : request.mode;
  const canResume = state
    && state.status !== 'idle'
    && state.activeWindowStart
    && state.activeWindowEnd
    && (!requestedStart || requestedStart === state.activeWindowStart)
    && (!requestedEnd || requestedEnd === state.activeWindowEnd);

  if (canResume) {
    return {
      start: state.activeWindowStart as string,
      end: state.activeWindowEnd as string,
      cursor: state.nextPageCursor,
      overlapSeconds,
      mode,
    };
  }

  let start = requestedStart;
  if (!start && state?.completedWatermark) {
    start = new Date(new Date(state.completedWatermark).getTime() - overlapSeconds * 1000).toISOString();
  }
  if (!start && automaticInitialBackfill) {
    start = new Date(new Date(now).getTime() - INITIAL_BACKFILL_MILLISECONDS).toISOString();
  }
  if (!start) {
    throw new ShopifyConnectorError(
      'SHOPIFY_INITIAL_RANGE_REQUIRED',
      '首次同步尚无水位，请明确提供 from；历史回补同时提供 to',
    );
  }
  const end = requestedEnd ?? now;
  if (new Date(start).getTime() > new Date(end).getTime()) {
    throw new ShopifyConnectorError('INVALID_SYNC_WINDOW', '同步开始时间不能晚于结束时间');
  }
  return { start, end, cursor: null, overlapSeconds, mode };
}

function verifyHistoricalScope(start: string, now: string, scopes: Set<string>) {
  const sixtyDaysAgo = new Date(now).getTime() - 60 * 24 * 60 * 60 * 1000;
  if (new Date(start).getTime() < sixtyDaysAgo && !scopes.has('read_all_orders')) {
    throw new ShopifyConnectorError(
      'SHOPIFY_READ_ALL_ORDERS_SCOPE_MISSING',
      '同步范围超过最近 60 天，但该店尚未授予 read_all_orders 历史订单访问资格',
    );
  }
}

function requireNextCursor(cursor: string | null, seen: Set<string>) {
  if (!cursor || seen.has(cursor)) {
    throw new ShopifyConnectorError('SHOPIFY_INVALID_CURSOR', 'Shopify 声明有下一页但返回了空或重复游标');
  }
  seen.add(cursor);
  return cursor;
}
