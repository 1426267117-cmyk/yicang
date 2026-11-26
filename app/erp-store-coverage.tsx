'use client';

import { useEffect, useState } from 'react';
import type { StoreCoverage } from '../lib/store-coverage';

type CoverageResponse = { ok: true } & StoreCoverage;
type StoreCoverageRow = StoreCoverage['stores'][number];
const platformNames = { amazon: 'Amazon', shopify: 'Shopify', wayfair: 'Wayfair' } as const;
const timestamp = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'short', hourCycle: 'h23' });
const number = new Intl.NumberFormat('zh-CN');

function time(value: string | null) {
  return value ? timestamp.format(new Date(value)) : '—';
}

function Freshness({ value, minutes }: { value: StoreCoverageRow['native']['freshness']; minutes: number }) {
  const state = value === 'recent' ? { label: '近期同步', tone: 'success' } : value === 'stale'
    ? { label: `超过 ${minutes} 分钟`, tone: 'warning' } : { label: '时效待核', tone: 'muted' };
  return <span className={`ops-state ops-state-${state.tone}`}>{state.label}</span>;
}

export default function ErpStoreCoverage({ refreshAfter }: { refreshAfter?: unknown }) {
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{ revision: number; refreshAfter: unknown; data?: CoverageResponse; error?: string }>();
  const current = result?.revision === revision && result.refreshAfter === refreshAfter ? result : null;

  useEffect(() => {
    const abort = new AbortController();
    void (async () => {
      try {
        const response = await fetch('/api/channel-orders/coverage', { cache: 'no-store', signal: abort.signal });
        const payload = await response.json().catch(() => null) as CoverageResponse | { ok?: false; message?: string } | null;
        if (!response.ok || !payload?.ok) throw new Error(payload && !payload.ok && payload.message || '暂时无法读取店铺订单覆盖');
        if (!abort.signal.aborted) setResult({ revision, refreshAfter, data: payload });
      } catch (error) {
        if (!abort.signal.aborted) setResult({ revision, refreshAfter, error: error instanceof Error ? error.message : '暂时无法读取店铺订单覆盖' });
      }
    })();
    return () => abort.abort();
  }, [revision, refreshAfter]);

  const data = current?.data;
  return <article className="ops-panel ops-list" aria-labelledby="erp-store-coverage-title" aria-busy={!current}>
    <div className="ops-panel-head">
      <h2 id="erp-store-coverage-title">订单数据覆盖</h2>
      <button className="secondary-button" type="button" disabled={!current} onClick={() => setRevision(value => value + 1)}>{current?.error ? '重试' : '刷新'}</button>
    </div>
    {!current && <p className="ops-empty" role="status">正在读取店铺覆盖…</p>}
    {current?.error && <p className="ops-empty" role="alert">{current.error}</p>}
    {data && <>
      <div className="table-wrap ops-table erp-channel-table" role="region" aria-label="各店铺订单来源与覆盖" tabIndex={0}>
        <table>
          <thead><tr><th scope="col">店铺 / 平台</th><th scope="col">平台直连订单</th><th scope="col">直连最近成功同步</th><th scope="col">飞书最新批次</th><th scope="col">飞书归档</th></tr></thead>
          <tbody>{data.stores.map(store => <CoverageRow key={store.key} store={store} thresholds={data} />)}</tbody>
        </table>
      </div>
      <p className="ops-empty">订单按来源分别统计，同一订单可能出现在多个来源。飞书归档记录已捕获的变更，完整历史覆盖待核验。</p>
    </>}
  </article>;
}

function CoverageRow({ store, thresholds }: { store: StoreCoverageRow; thresholds: Pick<StoreCoverage, 'nativeFreshMinutes' | 'feishuFreshMinutes'> }) {
  const { native, feishu, archive } = store;
  return <tr>
    <th scope="row"><strong>{store.name}</strong><small className="cell-sub">{platformNames[store.platform]}</small></th>
    <td>{native.orderCount !== null && <strong>{number.format(native.orderCount)} 单</strong>}
      {native.state === 'pending' && <span className="ops-state ops-state-muted">待接入核验</span>}
      {native.state === 'ambiguous' && <span className="ops-state ops-state-warning">店铺映射待核</span>}
      {native.state === 'inactive' && <small className="cell-sub">接入已停用</small>}
      {native.lastOrderFetchedAt && <small className="cell-sub">最近订单读取 {time(native.lastOrderFetchedAt)}</small>}
    </td>
    <td className="erp-channel-date">
      {time(native.lastSuccessfulSyncAt)}
      {native.state === 'verified' && <small className="cell-sub"><Freshness value={native.freshness} minutes={thresholds.nativeFreshMinutes} /></small>}
    </td>
    <td>{feishu ? <>
      <strong>{number.format(feishu.orderCount)} 单</strong><small className="cell-sub">{number.format(feishu.lineCount)} 行 · 采集 {time(feishu.observedAt)}</small>
      <Freshness value={feishu.freshness} minutes={thresholds.feishuFreshMinutes} />
    </> : <span className="ops-state ops-state-muted">待导入</span>}</td>
    <td>{archive ? <>
      <strong>{number.format(archive.orderCount)} 单</strong><small className="cell-sub">{number.format(archive.versionCount)} 个变更版本</small>
      {archive.lastArchivedAt && <small className="cell-sub">最近归档 {time(archive.lastArchivedAt)}</small>}
    </> : '—'}</td>
  </tr>;
}
