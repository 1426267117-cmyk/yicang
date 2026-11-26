'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  logisticsPageSize, logisticsStatusLabels, logisticsStatuses,
  type InboundLogisticsRow, type LogisticsHistoryRow, type LogisticsStatus, type ManualLogisticsRow, type PlatformLogisticsRow,
} from '../lib/logistics-contracts';

type View = 'erp' | 'platform' | 'inbound';
type StatusFilter = LogisticsStatus | 'all' | 'unregistered';
type LogisticsList = { view: 'erp'; rows: ManualLogisticsRow[]; total: number }
  | { view: 'platform'; rows: PlatformLogisticsRow[]; total: number }
  | { view: 'inbound'; rows: InboundLogisticsRow[]; total: number; snapshotDate: string | null; syncedAt: string | null };
type Editor = { row: ManualLogisticsRow; newPackage: boolean };
type LogisticsRead = { key: string; data: LogisticsList | null; error: string };

const localDate = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', dateStyle: 'medium', timeStyle: 'short',
});
const platformStatus: Record<string, string> = {
  CONFIRMED: '运输已确认', LABEL_PRINTED: '已打印面单', LABEL_PURCHASED: '已购买面单',
  ATTEMPTED_DELIVERY: '已尝试投递', READY_FOR_PICKUP: '可提货', IN_TRANSIT: '运输中',
  OUT_FOR_DELIVERY: '派送中', DELIVERED: '已签收', FAILURE: '平台标记失败', CANCELED: '已取消',
  CANCELLED: '已取消', SUCCESS: '平台履约成功', PENDING: '平台待处理', ERROR: '平台出错',
};

function displayDate(value: string | null) {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? localDate.format(date) : '—';
}

function stateLabel(status: LogisticsStatus | null) {
  return status ? logisticsStatusLabels[status] : '待登记';
}

function packageCoverage(row: ManualLogisticsRow) {
  return row.packedPackageCount === null ? `已登记 ${row.registeredPackageCount} 箱 · 装箱数未记录`
    : `已登记 ${row.registeredPackageCount} / 装箱 ${row.packedPackageCount} 箱${row.registeredPackageCount > row.packedPackageCount ? ' · 有额外包裹' : ''}`;
}

function allPackedPackagesRegistered(row: ManualLogisticsRow) {
  return row.packedPackageCount !== null && row.registeredPackageCount >= row.packedPackageCount;
}

export default function ErpLogistics({ query, canShip, canReadPlatform, canReadInbound, onOpenOrder }: {
  query: string; canShip: boolean; canReadPlatform: boolean; canReadInbound: boolean;
  onOpenOrder?: (orderNo: string) => void;
}) {
  const [view, setView] = useState<View>('erp');
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [cursor, setCursor] = useState({ key: '', page: 1 });
  const [reload, setReload] = useState(0);
  const [read, setRead] = useState<LogisticsRead | null>(null);
  const [notice, setNotice] = useState('');
  const [editor, setEditor] = useState<Editor | null>(null);
  const [history, setHistory] = useState<ManualLogisticsRow | null>(null);
  const pageKey = JSON.stringify([view, filter, query]);
  const page = cursor.key === pageKey ? cursor.page : 1;
  const setPage = (value: number) => setCursor({ key: pageKey, page: value });
  const requestKey = `${pageKey}:${page}:${reload}`;

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const search = new URLSearchParams({ view, q: query.trim().slice(0, 100), page: String(page), status: filter });
        const response = await fetch(`/api/logistics?${search}`, { cache: 'no-store', signal: controller.signal });
        const data = await response.json() as LogisticsList & { message?: string };
        if (!response.ok || !Array.isArray(data.rows) || typeof data.total !== 'number') throw new Error(data.message ?? '读取物流记录失败');
        if (controller.signal.aborted) return;
        if (page > 1 && !data.rows.length) { setCursor({ key: pageKey, page: 1 }); return; }
        setRead({ key: requestKey, data: { ...data, view } as LogisticsList, error: '' });
      } catch (cause) {
        if (!controller.signal.aborted) setRead({ key: requestKey, data: null,
          error: cause instanceof Error ? cause.message : '读取物流记录失败' });
      }
    }, 180);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [view, query, filter, page, pageKey, requestKey]);

  const current = read?.key === requestKey ? read : null;
  const result = current?.data;
  const loading = !current;
  const lastPage = Math.max(1, Math.ceil((result?.total ?? 0) / logisticsPageSize));
  return <div className="content module-content logistics-module">
    <div className="module-head"><div><h1>物流管理</h1><span>核对出库订单和包裹运单</span></div>
      <button type="button" className="secondary-button" disabled={loading} onClick={() => setReload((value) => value + 1)}>刷新</button>
    </div>
    {notice && <p className="logistics-notice" role="status">{notice}</p>}
    {current?.error && <p className="logistics-error" role="alert">{current.error}</p>}
    <article className="card data-card">
      <div className="data-toolbar logistics-toolbar">
        <div aria-label="物流来源">
          <button type="button" className={view === 'erp' ? 'tab-active' : undefined} aria-pressed={view === 'erp'} onClick={() => { setView('erp'); setPage(1); }}>ERP 发货</button>
          {canReadPlatform && <button type="button" className={view === 'platform' ? 'tab-active' : undefined} aria-pressed={view === 'platform'} onClick={() => { setView('platform'); setFilter('all'); setPage(1); }}>平台履约</button>}
          {canReadInbound && <button type="button" className={view === 'inbound' ? 'tab-active' : undefined} aria-pressed={view === 'inbound'} onClick={() => { setView('inbound'); setFilter('all'); setPage(1); }}>采购在途</button>}
        </div>
        {view === 'erp' && <label>包裹状态 <select value={filter} onChange={(event) => { setFilter(event.target.value as StatusFilter); setPage(1); }}>
          <option value="all">全部</option><option value="unregistered">运单待补齐</option>
          {logisticsStatuses.map((status) => <option value={status} key={status}>{stateLabel(status)}</option>)}
        </select></label>}
        <span role="status">{loading ? '正在读取…' : result ? `${result.total} ${view === 'erp' && filter === 'unregistered' ? '单待补齐' : '条记录'}` : ''}</span>
      </div>
      {result?.view === 'erp' && <div className="table-wrap module-table"><table>
        <thead><tr><th>ERP 订单</th><th>发货仓</th><th>承运商 / 运单号</th><th>包裹状态</th><th>更新（北京时间）</th><th>操作</th></tr></thead>
        <tbody>{result.rows.length ? result.rows.map((row) => <tr key={row.packageId ?? row.orderId}>
          <td>{onOpenOrder ? <button type="button" className="link-button" onClick={() => onOpenOrder(row.orderNo)}>{row.orderNo}</button> : <strong>{row.orderNo}</strong>}
            <small className="cell-sub">{row.skuCode} · {row.quantity} 件</small></td>
          <td>{row.warehouseName}<small className="cell-sub">{packageCoverage(row)}</small></td>
          <td>{row.carrier ?? '—'}{row.trackingNumber && <small className="cell-sub">{row.trackingNumber}</small>}</td>
          <td><span className="logistics-status" data-status={row.status ?? 'unregistered'}>{!row.status && row.registeredPackageCount > 0 ? '部分登记' : stateLabel(row.status)}</span></td>
          <td>{displayDate(row.updatedAt ?? row.shippedAt)}</td>
          <td><div className="row-actions">
            {row.packageId && <button type="button" onClick={() => setHistory(row)}>记录</button>}
            {canShip && row.packageId && <button type="button" onClick={() => setEditor({ row, newPackage: false })}>更新</button>}
            {canShip && <button type="button" onClick={() => setEditor({ row, newPackage: true })}>{allPackedPackagesRegistered(row) ? '登记额外包裹' : row.packageId ? '加包裹' : '登记运单'}</button>}
          </div></td>
        </tr>) : <tr><td className="empty-cell" colSpan={6}>{query || filter !== 'all' ? '没有匹配的发货记录' : '仓库确认发货后，订单会出现在这里。'}</td></tr>}</tbody>
      </table></div>}
      {result?.view === 'platform' && <div className="table-wrap module-table"><table>
        <thead><tr><th>平台订单 / 店铺</th><th>承运商 / 运单号</th><th>源状态</th><th>预计送达</th><th>实际送达</th><th>更新时间</th></tr></thead>
        <tbody>{result.rows.length ? result.rows.map((row) => <tr key={row.id}>
          <td><strong>{row.orderNo}</strong><small className="cell-sub">{row.storeName}</small></td>
          <td>{row.carrier ?? '—'}{row.trackingNumber && <small className="cell-sub">{row.trackingNumber}</small>}</td>
          <td>{row.status ? platformStatus[row.status.toUpperCase()] ?? row.status : '源平台未提供'}</td>
          <td>{displayDate(row.expectedAt)}</td><td>{displayDate(row.deliveredAt)}</td><td>{displayDate(row.updatedAt)}</td>
        </tr>) : <tr><td className="empty-cell" colSpan={6}>当前查询范围内没有已同步的平台履约记录。</td></tr>}</tbody>
      </table></div>}
      {result?.view === 'inbound' && <>
        {result.snapshotDate && <p className="logistics-source-time">飞书采购同步 · 数据日期 {result.snapshotDate} · 最近同步（北京时间） {displayDate(result.syncedAt)}</p>}
        <div className="table-wrap module-table"><table>
          <thead><tr><th>SKU</th><th>目的仓 / 地区</th><th>预计到仓</th><th>在途件数</th><th>批次</th><th>柜号</th></tr></thead>
          <tbody>{result.rows.length ? result.rows.map((row, index) => <tr key={`${row.sku}:${row.region}:${row.arrivalDate}:${index}`}>
            <td><strong>{row.sku}</strong></td><td>{row.region}</td><td>{row.arrivalDate}</td><td>{row.pcs}</td><td>{row.batch ?? '—'}</td><td>{row.container ?? '—'}</td>
          </tr>) : <tr><td className="empty-cell" colSpan={6}>{result.snapshotDate ? '当前范围内没有已核对的在途记录。' : '等待飞书采购数据同步。'}</td></tr>}</tbody>
        </table></div>
      </>}
      {result && lastPage > 1 && <div className="logistics-pagination">
        <button type="button" className="secondary-button" disabled={loading || page === 1} onClick={() => setPage(page - 1)}>上一页</button>
        <span>第 {page} / {lastPage} 页</span>
        <button type="button" className="secondary-button" disabled={loading || page >= lastPage} onClick={() => setPage(page + 1)}>下一页</button>
      </div>}
    </article>
    {editor && <TrackingEditor editor={editor} onClose={() => setEditor(null)} onSave={() => {
      setEditor(null); setReload((value) => value + 1); setNotice('运单记录已保存。');
    }} />}
    {history && <TrackingHistory row={history} onClose={() => setHistory(null)} />}
  </div>;
}

function TrackingEditor({ editor, onClose, onSave }: { editor: Editor; onClose: () => void; onSave: () => void }) {
  const { row, newPackage } = editor;
  const pendingKey = useRef<{ body: string; key: string } | null>(null);
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState<LogisticsStatus>(newPackage ? 'registered' : row.status ?? 'registered');
  const additional = newPackage && allPackedPackagesRegistered(row);
  const existingStatus = newPackage ? null : row.status;
  const options = logisticsStatuses.filter((value) => existingStatus === 'delivered' ? value === 'delivered'
    : !existingStatus || existingStatus === 'registered' || value !== 'registered');

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return;
    const values = new FormData(event.currentTarget);
    const body = JSON.stringify({ orderId: row.orderId, packageId: newPackage ? undefined : row.packageId,
      expectedVersion: newPackage ? 0 : row.version, carrier: values.get('carrier'), trackingNumber: values.get('tracking'),
      status, note: values.get('note'), additionalPackage: additional || undefined });
    const key = pendingKey.current?.body === body ? pendingKey.current.key : crypto.randomUUID();
    pendingKey.current = { body, key };
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/logistics', { method: 'POST', headers: {
        'Content-Type': 'application/json', 'Idempotency-Key': key,
      }, body });
      const result = await response.json() as { ok?: boolean; message?: string };
      if (!response.ok || result.ok !== true) throw new Error(result.message ?? '保存运单失败');
      onSave();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存运单失败');
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return <div className="modal-backdrop" onMouseDown={() => { if (!busy) onClose(); }}>
    <form className="modal procurement-modal" role="dialog" aria-modal="true" aria-labelledby="tracking-title" onSubmit={save} onMouseDown={(event) => event.stopPropagation()}>
      <div className="modal-head"><div><h2 id="tracking-title">{additional ? '登记额外包裹' : newPackage ? '登记包裹运单' : '更新包裹状态'}</h2><p>{row.orderNo} · {row.warehouseName} · {packageCoverage(row)}</p></div><button type="button" aria-label="关闭" disabled={busy} onClick={onClose}>×</button></div>
      <div className="form-grid"><label>承运商<input name="carrier" maxLength={100} required defaultValue={newPackage ? '' : row.carrier ?? ''} disabled={busy} /></label>
        <label>运单号<input name="tracking" minLength={3} maxLength={120} required defaultValue={newPackage ? '' : row.trackingNumber ?? ''} disabled={busy} /></label>
        <label>状态<select value={status} onChange={(event) => setStatus(event.target.value as LogisticsStatus)} disabled={busy}>{options.map((option) => <option value={option} key={option}>{stateLabel(option)}</option>)}</select></label>
        <label className="full">{additional ? '额外包裹原因' : '变更说明'}<textarea name="note" maxLength={500} rows={3} required={additional || status === 'exception'} disabled={busy} /></label>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="modal-actions"><button type="button" onClick={onClose} disabled={busy}>取消</button><button type="submit" className="primary-button" disabled={busy}>{busy ? '正在保存…' : '保存运单记录'}</button></div>
    </form>
  </div>;
}

function TrackingHistory({ row, onClose }: { row: ManualLogisticsRow; onClose: () => void }) {
  const [events, setEvents] = useState<LogisticsHistoryRow[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    async function read() {
      try {
        const response = await fetch(`/api/logistics?package=${encodeURIComponent(row.packageId ?? '')}`, { cache: 'no-store', signal: controller.signal });
        const result = await response.json() as { history?: LogisticsHistoryRow[]; message?: string };
        if (!response.ok || !Array.isArray(result.history)) throw new Error(result.message ?? '读取运单记录失败');
        if (!controller.signal.aborted) setEvents(result.history);
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '读取运单记录失败');
      }
    }
    void read();
    return () => controller.abort();
  }, [row.packageId]);
  return <div className="modal-backdrop" onMouseDown={onClose}><section className="modal procurement-modal" role="dialog" aria-modal="true" aria-labelledby="tracking-history-title" onMouseDown={(event) => event.stopPropagation()}>
    <div className="modal-head"><div><h2 id="tracking-history-title">包裹变更记录</h2><p>{row.orderNo} · {row.trackingNumber}</p></div><button type="button" aria-label="关闭" onClick={onClose}>×</button></div>
    {error ? <p className="form-error" role="alert">{error}</p> : !events ? <p role="status">正在读取记录…</p> : <div className="table-wrap module-table"><table>
      <thead><tr><th>状态</th><th>承运商 / 运单</th><th>记录时间</th><th>操作人 / 说明</th></tr></thead>
      <tbody>{events.map((event) => <tr key={event.id}>
        <td>{stateLabel(event.status)}</td><td>{event.carrier}<small className="cell-sub">{event.trackingNumber}</small></td>
        <td>{displayDate(event.createdAt)}</td><td>{event.actor}{event.note && <small className="cell-sub">{event.note}</small>}</td>
      </tr>)}</tbody>
    </table></div>}
  </section></div>;
}
