'use client';

import { useEffect, useState } from 'react';
import type { ChannelScope } from '../lib/domain';
import { nineStorePageSize, type NineStoreOrderResponse } from '../lib/nine-store-orders-contract';
import ErpNineStoreHandoff, { type HandoffInventory, type HandoffSelection } from './erp-nine-store-handoff';

type Section = NineStoreOrderResponse['section'];
type RequestState = { key: string; data: NineStoreOrderResponse | null; snapshot: NineStoreOrderResponse['snapshot']; error: string };

const channels = { amazon: '亚马逊', shopify: '独立站', wayfair: 'Wayfair' };
const fulfillmentNames = { pending: '待发货', shipped: '已发货', delivered: '已签收', cancelled: '已取消', exception: '异常' };
const time = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Shanghai' });

export type NineStoreWorkflow = {
  inventory: HandoffInventory[]; canCreate: boolean;
  onOpenOrder: (orderNo: string) => void;
  onOpenWarehouse: (orderNo: string) => void;
  onOpenLogistics: (orderNo: string) => void;
  onOpenInventory: (sku: string) => void;
};

export default function ErpNineStoreOrders({ query, workflow, archived = false, channelScope }: {
  query: string; workflow?: NineStoreWorkflow; archived?: boolean; channelScope?: ChannelScope;
}) {
  const [section, setSection] = useState<Section>('orders');
  const [store, setStore] = useState('');
  const [scope, setScope] = useState<'current' | 'history'>('current');
  const [from, setFrom] = useState('');
  const [through, setThrough] = useState('');
  const [fulfillment, setFulfillment] = useState('');
  const [selected, setSelected] = useState<HandoffSelection | null>(null);
  const [cursor, setCursor] = useState({ key: '', page: 1 });
  const [reload, setReload] = useState(0);
  const [state, setState] = useState<RequestState>();
  const channelName = channelScope ? channels[channelScope] : '九店';
  const search = query.trim().slice(0, 100);
  const status = section === 'orders' ? fulfillment : '';
  const invalidRange = Boolean(from && through && from > through);
  const key = JSON.stringify([section, scope, store, search, from, through, status]);
  const page = cursor.key === key ? cursor.page : 1;
  const requestKey = `${key}:${page}:${reload}`;

  useEffect(() => {
    if (invalidRange) return;
    const controller = new AbortController();
    let timer: number;
    async function read() {
      const parameters = new URLSearchParams({ section, scope, search, page: String(page) });
      if (store) parameters.set('store', store);
      if (from) parameters.set('from', from);
      if (through) parameters.set('through', through);
      if (status) parameters.set('fulfillment', status);
      try {
        const response = await fetch(`/api/nine-store-orders?${parameters}`, { cache: 'no-store',
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]) });
        const body = await response.json() as NineStoreOrderResponse & { message?: string };
        if (!response.ok || body.ok !== true || body.section !== section || !Array.isArray(body.rows)) {
          throw new Error(body.message ?? `读取${channelName}订单失败`);
        }
        if (controller.signal.aborted) return;
        const lastPage = Math.max(1, Math.ceil(body.total / nineStorePageSize));
        if (page > lastPage) setCursor({ key, page: lastPage });
        else setState({ key: requestKey, data: body, snapshot: body.snapshot, error: '' });
      } catch (cause) {
        if (!controller.signal.aborted) setState((previous) => ({ key: requestKey, data: null, snapshot: previous?.snapshot ?? null,
          error: cause instanceof Error ? cause.message : `读取${channelName}订单失败` }));
      } finally {
        if (!controller.signal.aborted && !archived) timer = window.setTimeout(() => { void read(); }, 60_000);
      }
    }
    timer = window.setTimeout(() => { void read(); }, 150);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [section, scope, store, search, from, through, status, invalidRange, page, requestKey, key, reload, archived, channelName]);

  const current = state?.key === requestKey ? state : null;
  const result = current?.data;
  const snapshot = state?.snapshot ?? null;
  const stores = snapshot?.stores ?? [];
  const mapped = stores.filter((item) => item.orderLines > 0).length;
  const imported = snapshot ? new Date(snapshot.observedAt) : null;
  const byKey = new Map(stores.map((item) => [item.key, item.name]));
  const invalidRows = snapshot?.tables.reduce((sum, item) => sum + item.invalid, 0) ?? 0;
  const pages = Math.max(1, Math.ceil((result?.total ?? 0) / nineStorePageSize));
  const historical = scope === 'history';
  const refunds = section === 'refunds';
  const columns = (refunds ? 4 : 6) + Number(historical);
  const filtered = historical || !!store || !!from || !!through || !!status;
  const loading = !current && !invalidRange;
  const empty = invalidRange ? '请核对日期范围。' : loading ? '正在读取记录…'
    : current?.error ? '查询暂不可用。' : !snapshot ? '暂无导入记录。'
      : filtered || search ? '暂无匹配记录。' : refunds ? '暂无退款记录。' : '暂无订单记录。';

  function resetFilters() {
    setScope('current');
    setStore('');
    setFrom('');
    setThrough('');
    setFulfillment('');
  }

  return <div className="nine-store-orders erp-channel-register">
      <article className="card data-card erp-channel-register-panel">
        <div className="erp-channel-register-head">
          <div className="erp-channel-register-tabs" role="group" aria-label={`${channelName}订单内容`}>
            <button type="button" aria-pressed={section === 'orders'} onClick={() => setSection('orders')}>订单记录</button>
            <button type="button" aria-pressed={section === 'refunds'} onClick={() => setSection('refunds')}>退款记录</button>
          </div>
          <div className="erp-channel-register-actions">
            <button type="button" className="secondary-button" disabled={loading || invalidRange} onClick={() => setReload((value) => value + 1)}>刷新</button>
            <button type="button" className="secondary-button" disabled={!result?.rows.length || invalidRange}
              onClick={() => { if (result?.rows.length) exportPage(result, byKey, historical, channelName); }}>导出本页</button>
          </div>
        </div>
        <div className="nine-store-filters" role="group" aria-label={`${channelName}订单筛选`}>
          <label>记录范围<select value={scope} onChange={(event) => setScope(event.target.value as 'current' | 'history')}>
            <option value="current">当前记录</option><option value="history">变更历史</option></select></label>
          <label>店铺<select value={store} onChange={(event) => setStore(event.target.value)}>
            <option value="">全部店铺</option>{stores.map((item) => <option key={item.key} value={item.key}>{channels[item.platform]} · {item.name}</option>)}
          </select></label>
          {!refunds && <label>来源履约<select value={fulfillment} onChange={(event) => setFulfillment(event.target.value)}>
            <option value="">全部</option><option value="unknown">待核</option>{Object.entries(fulfillmentNames).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select></label>}
          <label>起始日期<input type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
          <label>截止日期<input type="date" value={through} onChange={(event) => setThrough(event.target.value)} /></label>
          <button type="button" className="link-button erp-channel-reset" disabled={!filtered} onClick={resetFilters}>重置筛选</button>
        </div>
        {invalidRange && <p className="nine-store-message" role="alert">截止日期不能早于起始日期。</p>}
        {current?.error && <div className="inline-alert" role="alert"><p>{current.error}</p><button type="button" onClick={() => setReload((value) => value + 1)}>重试</button></div>}
        <div className="table-wrap module-table erp-channel-table"><table aria-label={refunds ? '退款列表' : '渠道记录列表'} aria-busy={loading}>
          <thead><tr><th scope="col">{refunds ? '退款日期' : '订单日期'}</th><th scope="col">店铺</th><th scope="col">订单号</th><th scope="col">SKU</th>
            {!refunds && <><th scope="col" className="erp-align-number">数量</th><th scope="col">来源履约</th></>}{historical && <th scope="col">变更归档</th>}</tr></thead>
          <tbody>{result?.rows.length ? result.rows.map((row, index) => <tr key={`${row.storeKey}:${row.orderNo}:${index}`}>
            <td className="erp-channel-date">{('orderDate' in row ? row.orderDate : row.refundDate) ?? '待核'}</td><td>{byKey.get(row.storeKey) ?? row.storeKey}</td>
            <td>{refunds || !workflow ? row.orderNo : <button type="button" className="link-button" title="查看订单流转" aria-label={`查看 ${row.orderNo} 的订单流转`}
              onClick={() => setSelected({ storeKey: row.storeKey, storeName: byKey.get(row.storeKey) ?? row.storeKey, orderNo: row.orderNo, historical })}>{row.orderNo}</button>}</td>
            <td>{row.sku ?? '待核'}</td>{'orderDate' in row && <><td className="erp-align-number">{row.quantity?.toLocaleString('zh-CN') ?? '待核'}</td>
              <td><span className={`ops-state${row.fulfillment === 'delivered' ? ' ops-state-success' : row.fulfillment === 'exception' ? ' ops-state-warning' : row.fulfillment === 'shipped' ? ' ops-state-info' : ''}`}>
                {row.fulfillment ? fulfillmentNames[row.fulfillment] : '待核'}</span></td></>}
            {historical && <td>{row.history?.change === 'removed' ? '来源移除' : '更新前'}{row.history && <small className="cell-sub">{time.format(new Date(row.history.archivedAt))}</small>}</td>}
          </tr>) : <tr><td className="empty-cell" colSpan={columns}>{empty}</td></tr>}</tbody>
        </table></div>
        <footer className="erp-channel-register-foot">
          <span aria-live="polite">{result ? `共 ${result.total.toLocaleString('zh-CN')} 条记录` : loading ? '查询中' : '—'}</span>
          {pages > 1 && <div className="logistics-pagination"><button type="button" className="secondary-button" disabled={page <= 1} onClick={() => setCursor({ key, page: page - 1 })}>上一页</button>
            <span>第 {page} / {pages} 页</span><button type="button" className="secondary-button" disabled={page >= pages} onClick={() => setCursor({ key, page: page + 1 })}>下一页</button></div>}
        </footer>
      </article>
      {snapshot && <details className="card data-card nine-store-coverage">
        <summary><strong>店铺覆盖 {mapped} / {stores.length}</strong><span>{imported && `资料时间 ${time.format(imported)}（北京时间）`}</span></summary>
        <div className="table-wrap module-table erp-channel-table"><table aria-label="店铺导入覆盖">
          <thead><tr><th scope="col">店铺</th><th scope="col">渠道</th><th scope="col" className="erp-align-number">订单</th><th scope="col" className="erp-align-number">商品明细</th><th scope="col" className="erp-align-number">已记录履约</th><th scope="col" className="erp-align-number">退款</th></tr></thead>
          <tbody>{stores.map((item) => <tr key={item.key}><td><button type="button" className="link-button" aria-pressed={store === item.key}
            onClick={() => setStore((value) => value === item.key ? '' : item.key)}>{item.name}</button></td><td>{channels[item.platform]}</td>
            <td className="erp-align-number">{item.uniqueOrders.toLocaleString('zh-CN')}</td><td className="erp-align-number">{item.orderLines.toLocaleString('zh-CN')}</td>
            <td className="erp-align-number">{item.fulfillmentKnown.toLocaleString('zh-CN')} / {item.orderLines.toLocaleString('zh-CN')}</td><td className="erp-align-number">{item.refundLines.toLocaleString('zh-CN')}</td>
          </tr>)}</tbody>
        </table></div>
        {invalidRows > 0 && <p className="nine-store-message">{invalidRows.toLocaleString('zh-CN')} 条资料缺少可核验的订单标识，未进入归档。</p>}
      </details>}
    {selected && workflow && <ErpNineStoreHandoff selection={selected} {...workflow} onClose={() => setSelected(null)} />}
  </div>;
}

function exportPage(page: NineStoreOrderResponse, stores: Map<string, string>, historical: boolean, channelName: string) {
  const orders = page.section === 'orders';
  const header = [orders ? '订单日期' : '退款日期', '店铺', '店铺标识', '订单号', 'SKU',
    ...(orders ? ['来源记录件数', '来源履约'] : []), ...(historical ? ['归档时间'] : [])];
  const lines = page.rows.map((row) => {
    const order = 'orderDate' in row;
    return [order ? row.orderDate : row.refundDate, stores.get(row.storeKey) ?? row.storeKey, row.storeKey, row.orderNo, row.sku,
      ...(order ? [row.quantity, row.fulfillment ? fulfillmentNames[row.fulfillment] : '待核'] : []), ...(historical ? [row.history?.archivedAt] : [])];
  });
  const csv = [header, ...lines].map((line) => line.map((value) => {
    const text = String(value ?? '');
    return `"${(/^[\s]*[=+\-@]/u.test(text) ? `'${text}` : text).replaceAll('"', '""')}"`;
  }).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob(['\ufeff', csv], { type: 'text/csv;charset=utf-8' }));
  const download = document.createElement('a');
  download.href = url;
  download.download = `${channelName}${orders ? '订单' : '退款'}-当前页.csv`;
  download.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
