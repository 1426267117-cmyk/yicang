import { z } from 'zod';
import { HttpError } from '../../db';
import { PlatformOrderRepository, PlatformOrderRepositoryError, type SyncRunStats, type SyncStateRecord } from '../repository';
import { AmazonConnectorError, amazonOrderCloseLagMs, createAmazonOrdersSource } from './orders';
import {
  amazonOrdersApiVersion, amazonStoreId, amazonStoreKeySchema, saveVerifiedAmazonStore, type AmazonStoreConfig,
} from './store-settings';

const dayMs = 86_400_000;
const overlapSeconds = 2 * 60 * 60;
const tokenResumeMs = 23 * 60 * 60 * 1000;
const maxWindowMs = 30 * dayMs;
const savedCursorSchema = z.strictObject({ token: z.string().min(1).max(12_000), issuedAt: z.iso.datetime() });

export const amazonOrderSyncRequestSchema = z.strictObject({
  storeKey: amazonStoreKeySchema,
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  maxPages: z.number().int().min(1).max(5).default(3),
}).refine(({ from, to }) => !to || Boolean(from));
export type AmazonOrderSyncRequest = z.infer<typeof amazonOrderSyncRequestSchema>;

export async function runAmazonOrderSync(input: {
  db: D1Database;
  tenantId: string;
  config: AmazonStoreConfig;
  request: AmazonOrderSyncRequest;
  source?: Pick<ReturnType<typeof createAmazonOrdersSource>, 'verifyOrder' | 'searchOrders'>;
  now?: () => Date;
}) {
  const { config, db, tenantId, request } = input;
  if (request.storeKey !== config.key) {
    throw new HttpError(409, '同步任务与 Amazon 店铺配置不一致', 'AMAZON_STORE_BINDING_CONFLICT');
  }
  const now = input.now ?? (() => new Date());
  const started = now();
  const startedAt = started.toISOString();
  const repository = new PlatformOrderRepository(db, tenantId, 'amazon');
  const storeId = await amazonStoreId(tenantId, config);
  const previous = await repository.getSyncState(storeId);
  const window = syncWindow(request, previous, started);
  const source = input.source ?? createAmazonOrdersSource(config, { now: () => now().valueOf() });
  await source.verifyOrder(config.verificationOrderId);
  await saveVerifiedAmazonStore(db, tenantId, config, startedAt);
  const runId = await repository.beginSyncRun({
    storeId, mode: previous?.completedWatermark ? 'incremental' : 'backfill',
    windowStart: window.from, windowEnd: window.to, startingCursor: window.cursor,
    overlapSeconds, expectedLastRunId: previous?.lastRunId ?? null,
    expectedCompletedWatermark: previous?.completedWatermark ?? null, now: startedAt,
  });
  const stats: SyncRunStats = { pagesCompleted: 0, ordersSeen: 0, ordersInserted: 0, ordersUpdated: 0, ordersUnchanged: 0 };
  let checkpoint = window.cursor;
  let cursor = readCursor(checkpoint)?.token ?? null;
  const seenCursors = new Set(cursor ? [cursor] : []);

  async function pause(code: string, message: string) {
    await repository.failSyncRun({ runId, storeId, errorCode: code, errorMessage: message, stats, now: now().toISOString() });
    return { ok: true as const, complete: false as const, code, message, storeKey: config.key, stats };
  }

  try {
    while (stats.pagesCompleted < request.maxPages) {
      await repository.heartbeatSyncRun({ runId, storeId, now: now().toISOString() });
      const page = await source.searchOrders({ since: window.from, until: window.to, cursor });
      for (const graph of page.nodes) {
        const result = await repository.upsertOrderGraph({
          storeId, graph, apiVersion: amazonOrdersApiVersion, runId, fetchedAt: now().toISOString(),
        });
        stats.ordersSeen += 1;
        if (result === 'inserted') stats.ordersInserted += 1;
        if (result === 'updated') stats.ordersUpdated += 1;
        if (result === 'unchanged') stats.ordersUnchanged += 1;
      }
      const fetchedAt = now().toISOString();
      stats.pagesCompleted += 1;
      cursor = page.hasNextPage ? page.endCursor : null;
      if (page.hasNextPage && (!cursor || seenCursors.has(cursor))) {
        throw new HttpError(502, 'Amazon 返回了空或重复分页令牌', 'AMAZON_INVALID_CURSOR');
      }
      if (cursor) seenCursors.add(cursor);
      checkpoint = cursor ? JSON.stringify({ token: cursor, issuedAt: fetchedAt }) : null;
      await repository.checkpointPage({ runId, storeId, nextCursor: checkpoint, stats, now: fetchedAt });
      if (!page.hasNextPage) {
        const completedAt = now().toISOString();
        await repository.completeSyncRun({ runId, storeId, windowEnd: window.to, stats, now: completedAt });
        return { ok: true as const, complete: true as const, storeKey: config.key, stats, completedAt, completedWatermark: window.to };
      }
    }
    return await pause('AMAZON_PAGE_LIMIT_REACHED', '本次已保存分页断点，可继续同步');
  } catch (error) {
    if (error instanceof AmazonConnectorError && error.code === 'AMAZON_PAGE_TOKEN_REJECTED' && checkpoint) {
      await repository.checkpointPage({ runId, storeId, nextCursor: null, stats, now: now().toISOString() });
      return pause('AMAZON_PAGE_TOKEN_RESTART', '分页令牌已失效，下次将重读原时间窗口并按订单号去重');
    }
    const failure = amazonSyncFailure(error);
    await repository.failSyncRun({
      runId, storeId, errorCode: failure.code, errorMessage: failure.message, stats, now: now().toISOString(),
    });
    throw error;
  }
}

function readCursor(value: string | null) {
  if (!value) return null;
  try {
    const parsed = savedCursorSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function syncWindow(request: AmazonOrderSyncRequest, previous: SyncStateRecord | null, now: Date) {
  const requestedFrom = request.from ? new Date(request.from).toISOString() : null;
  const requestedTo = request.to ? new Date(request.to).toISOString() : null;
  if (previous?.activeWindowStart && previous.activeWindowEnd && previous.status !== 'idle') {
    if ((requestedFrom && requestedFrom !== previous.activeWindowStart) || (requestedTo && requestedTo !== previous.activeWindowEnd)) {
      throw new HttpError(409, '该店铺有未完成的同步窗口，请先继续原同步', 'AMAZON_WINDOW_ALREADY_OPEN');
    }
    const saved = readCursor(previous.nextPageCursor);
    const age = saved ? now.valueOf() - Date.parse(saved.issuedAt) : NaN;
    const cursor = age >= 0 && age < tokenResumeMs ? previous.nextPageCursor : null;
    return { from: previous.activeWindowStart, to: previous.activeWindowEnd, cursor };
  }
  if (previous?.completedWatermark && requestedFrom) {
    throw new HttpError(409, '该店铺已建立同步水位，请直接执行增量同步', 'AMAZON_ALREADY_INITIALIZED');
  }
  const from = requestedFrom ?? (previous?.completedWatermark
    ? new Date(Date.parse(previous.completedWatermark) - overlapSeconds * 1000).toISOString()
    : null);
  if (!from) throw new HttpError(409, '首次同步请选择回补起始日期', 'AMAZON_INITIAL_RANGE_REQUIRED');
  const earliest = new Date(now);
  earliest.setUTCFullYear(earliest.getUTCFullYear() - 2);
  const upper = now.valueOf() - amazonOrderCloseLagMs;
  const fromMs = Date.parse(from);
  const untilMs = requestedTo ? Date.parse(requestedTo) : Math.min(upper, fromMs + maxWindowMs);
  if (fromMs < earliest.valueOf() || fromMs >= untilMs || untilMs > upper || untilMs - fromMs > maxWindowMs) {
    throw new HttpError(400, '请选择最近两年内的有效订单更新时间范围，每轮最多回补 30 天', 'AMAZON_WINDOW_INVALID');
  }
  return { from, to: new Date(untilMs).toISOString(), cursor: null };
}

export function amazonSyncFailure(error: unknown) {
  if (error instanceof HttpError) return { status: error.status, code: error.code, message: error.message, retryable: false, retryAfterSeconds: null };
  if (error instanceof AmazonConnectorError) return {
    status: error.code === 'AMAZON_RATE_LIMITED' ? 429 : error.retryable ? 503 : 422,
    code: error.code, message: error.message, retryable: error.retryable, retryAfterSeconds: error.retryAfterSeconds,
  };
  if (error instanceof PlatformOrderRepositoryError) return {
    status: 409, code: error.code, message: error.message, retryable: error.retryable, retryAfterSeconds: null,
  };
  return { status: 503, code: 'AMAZON_SYNC_FAILED', message: 'Amazon 订单暂时无法同步，请稍后重试', retryable: true, retryAfterSeconds: null };
}
