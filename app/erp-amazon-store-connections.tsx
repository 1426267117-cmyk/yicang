'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { AmazonStoreKey, AmazonStoreStatus } from '../lib/connectors/amazon/store-settings';

const shanghaiClock = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'short' });

function localDay(instant: number) {
  return new Date(instant + 8 * 60 * 60_000).toISOString().slice(0, 10);
}

function formatTime(timestamp: string | null) {
  const ms = timestamp ? Date.parse(timestamp) : NaN;
  return Number.isFinite(ms) ? shanghaiClock.format(ms) : '—';
}

function connectionStatus(store: AmazonStoreStatus): { label: string; tone: string } {
  if (store.configuration === 'duplicate') return { label: '店铺配置重复', tone: 'warning' };
  if (store.configuration === 'invalid') return { label: '配置待补齐', tone: 'warning' };
  if (store.configuration === 'unconfigured') return { label: '待授权', tone: 'muted' };
  if (store.syncStatus === 'running') return { label: '正在同步', tone: 'info' };
  if (store.lastErrorCode === 'AMAZON_PAGE_LIMIT_REACHED' || store.lastErrorCode === 'AMAZON_PAGE_TOKEN_RESTART') {
    return { label: '分页待继续', tone: 'info' };
  }
  if (store.syncStatus === 'failed') return { label: '最近同步失败', tone: 'warning' };
  if (store.completedWatermark) return { label: '已同步', tone: 'success' };
  return { label: store.sourceVerified ? '待完成首轮' : '待核验', tone: 'info' };
}

export default function ErpAmazonStoreConnections({ canSync, onSync }: { canSync: boolean; onSync: () => void }) {
  const [stores, setStores] = useState<AmazonStoreStatus[] | null>(null);
  const [loadingError, setLoadingError] = useState('');
  const [busy, setBusy] = useState<AmazonStoreKey | null>(null);
  const [firstStore, setFirstStore] = useState<{ store: AmazonStoreStatus; latestDay: string } | null>(null);
  const [fromDay, setFromDay] = useState('');
  const [openedAt] = useState(() => Date.now());
  const [feedback, setFeedback] = useState<{ text: string; error?: boolean }>();
  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch('/api/connectors/amazon/status', { cache: 'no-store', signal });
      const body = await response.json() as { ok?: boolean; stores?: AmazonStoreStatus[]; message?: string };
      if (!response.ok || body.ok !== true || !Array.isArray(body.stores)) throw new Error(body.message ?? '暂时无法读取 Amazon 店铺状态');
      if (!signal?.aborted) {
        setStores(body.stores);
        setLoadingError('');
      }
    } catch (cause) {
      if (!signal?.aborted) setLoadingError(cause instanceof Error ? cause.message : '暂时无法读取 Amazon 店铺状态');
    }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => { void refresh(controller.signal); }, 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [refresh]);

  async function synchronize(store: AmazonStoreStatus, date?: string) {
    if (!canSync || busy) return;
    setBusy(store.key);
    setFeedback(undefined);
    try {
      const from = date ? new Date(`${date}T00:00:00+08:00`).toISOString() : undefined;
      const response = await fetch('/api/connectors/amazon/sync', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ storeKey: store.key, from }),
      });
      const body = await response.json() as {
        ok?: boolean; complete?: boolean; message?: string; stats?: { ordersInserted: number; ordersUpdated: number };
      };
      if (!response.ok || body.ok !== true || !body.stats) throw new Error(body.message ?? 'Amazon 同步失败');
      setFirstStore(null);
      setFeedback({ text: `${store.name}新增 ${body.stats.ordersInserted} 单，更新 ${body.stats.ordersUpdated} 单。 ${body.complete ? '本轮同步完成。' : body.message ?? '可从断点继续同步。'}` });
      onSync();
    } catch (cause) {
      setFeedback({ text: cause instanceof Error ? cause.message : 'Amazon 同步失败', error: true });
    } finally {
      await refresh();
      setBusy(null);
    }
  }

  function start(store: AmazonStoreStatus) {
    if (store.resumable || store.completedWatermark) {
      setFirstStore(null);
      void synchronize(store);
      return;
    }
    setFirstStore({ store, latestDay: localDay(openedAt) });
    setFromDay(localDay(openedAt - 7 * 86_400_000));
    setFeedback(undefined);
  }

  function submitBackfill(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (firstStore && fromDay) void synchronize(firstStore.store, fromDay);
  }

  return <article className="ops-panel erp-amazon-connections">
    <div className="ops-panel-head"><h2>Amazon 四店</h2>
      <button type="button" className="link-button" onClick={() => { void refresh(); }} disabled={Boolean(busy)}>刷新状态</button>
    </div>
    {loadingError && <p className="ops-empty" role="alert">{loadingError}</p>}
    {feedback && <p className="ops-empty" role={feedback.error ? 'alert' : 'status'}>{feedback.text}</p>}
    {stores ? <div className="table-wrap ops-table erp-channel-table" role="region" aria-label="Amazon 店铺接入" tabIndex={0}><table>
      <thead><tr><th scope="col">店铺</th><th scope="col">订单同步</th><th scope="col">最近成功</th><th scope="col">已覆盖至</th>{canSync && <th scope="col">操作</th>}</tr></thead>
      <tbody>{stores.map((store) => {
        const state = connectionStatus(store);
        return <tr key={store.key}>
          <td><strong>{store.name}</strong></td>
          <td><span className={`ops-state ops-state-${state.tone}`}>{state.label}</span></td>
          <td className="erp-channel-date">{formatTime(store.lastSuccessfulSyncAt)}</td>
          <td className="erp-channel-date">{formatTime(store.completedWatermark)}</td>
          {canSync && <td>{store.configuration === 'configured'
            ? <button type="button" className="link-button" disabled={Boolean(busy) || store.syncStatus === 'running'} onClick={() => start(store)}>
              {busy === store.key ? '正在同步…' : store.resumable ? '继续同步' : store.completedWatermark ? '同步增量' : '首次同步'}
            </button> : '—'}</td>}
        </tr>;
      })}</tbody>
    </table></div> : !loadingError && <p className="ops-empty" role="status">正在读取 Amazon 店铺状态…</p>}
    {firstStore && <form className="ops-filterline erp-amazon-backfill" onSubmit={submitBackfill}>
      <label>{firstStore.store.name}起始日期 <input type="date" aria-label={`${firstStore.store.name}订单回补起始日期`} value={fromDay}
        onChange={(event) => setFromDay(event.target.value)} max={firstStore.latestDay} required disabled={Boolean(busy)} /></label>
      <button type="submit" className="primary-button" disabled={Boolean(busy) || !fromDay}>开始回补</button>
      <button type="button" className="secondary-button" disabled={Boolean(busy)} onClick={() => setFirstStore(null)}>取消</button>
      <span>按订单更新时间回补，每轮最多 30 天。</span>
    </form>}
  </article>;
}
