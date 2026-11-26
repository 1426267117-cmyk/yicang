'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { ChannelOrder, ChannelOrderDetails, ChannelOrderList, ChannelOrderStatus } from '../lib/channel-orders';
import { cancelledFulfillmentStatuses, completedFulfillmentStatuses } from '../lib/channel-order-status';
import type { ShopifyAccessCapabilities, ShopifyCapabilityState } from '../lib/connectors/shopify/config';
import ErpAmazonStoreConnections from './erp-amazon-store-connections';
import ErpChannelOrderHandoff from './erp-channel-order-handoff';
import ErpShopifyProductArchive from './erp-shopify-product-archive';
import ErpStoreCoverage from './erp-store-coverage';
import ErpWayfairConnection from './erp-wayfair-connection';
import ErpNineStoreOrders, { type NineStoreWorkflow } from './erp-nine-store-orders';

export type StoreConnection = {
  key: 'zimasya' | 'kaguyasu' | 'anzhap' | 'bizfurniz';
  displayName: string; expectedDomain: string | null; verifiedDomain: string | null;
  appConfigured: boolean; credentialsConfigured: boolean; identityVerified: boolean;
  authorizationStartUrl: string | null; lastSuccessfulSyncAt: string | null;
  completedWatermark: string | null; syncStatus: string; lastErrorCode: string | null;
  accessCapabilities?: ShopifyAccessCapabilities;
};

type WorkTask = { label: string; value: number | null; unit: string; detail: string; open: () => void; tone: string };
const fullDay = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'long' });
const syncTime = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const orderDateTime = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'short', hourCycle: 'h23' });
const markers = { FULFILLED: '已履约', PARTIALLY_FULFILLED: '部分履约', UNFULFILLED: '待履约', ON_HOLD: '暂缓',
  PENDING_FULFILLMENT: '等待履约', OPEN: '待履约', IN_PROGRESS: '履约中', SCHEDULED: '已排期',
  PAID: '已付款', PENDING: '付款待确认', AUTHORIZED: '已授权付款', REFUNDED: '已退款', PARTIALLY_REFUNDED: '部分退款',
  VOIDED: '已撤销', PARTIALLY_PAID: '部分付款', EXPIRED: '已失效' } as Record<string, string>;
const fulfillmentLabels: Record<string, string> = {
  PENDING_AVAILABILITY: '等待商品可用', PENDING: '等待确认', UNSHIPPED: '待发货',
  PARTIALLY_SHIPPED: '部分发货', SHIPPED: '已发货', UNFULFILLABLE: '无法履约', INVOICE_UNCONFIRMED: '待确认发票',
};

function timeLabel(value: string | null) {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.valueOf()) ? syncTime.format(date) : '—';
}

function connectionState(store: StoreConnection) {
  if (!store.appConfigured && !store.credentialsConfigured) return { text: '待配置', tone: 'muted' };
  if (!store.credentialsConfigured) return { text: '待授权', tone: 'warning' };
  if (store.syncStatus === 'failed') return { text: '同步异常', tone: 'warning' };
  if (store.syncStatus === 'running') return { text: '同步中', tone: 'info' };
  if (!store.identityVerified || !store.completedWatermark) return { text: '待首轮验证', tone: 'info' };
  return { text: '已核验', tone: 'success' };
}

function StatePill({ label, tone }: { label: string; tone: string }) {
  return <span className={`ops-state ops-state-${tone}`}>{label}</span>;
}

export function OperationsHome({ tasks, stores, openOrders, openChannels, openStores, openImports, recentOrders, readyForOrders }: {
  tasks: WorkTask[]; stores: StoreConnection[] | null; openOrders: () => void; openChannels: () => void;
  openStores?: () => void; openImports?: () => void; recentOrders: ReactNode; readyForOrders: boolean;
}) {
  const verified = stores?.filter((store) => store.credentialsConfigured && store.identityVerified && store.completedWatermark).length;
  return <div className="content ops-home erp-workbench">
    <header className="ops-heading erp-workbench-heading">
      <div><h1>运营工作台</h1><p>{fullDay.format(new Date())}</p></div>
      <div className="erp-workbench-actions">
        {openImports && !readyForOrders && <button type="button" className="secondary-button" onClick={openImports}>期初资料</button>}
        <button type="button" className="secondary-button" onClick={openChannels}>渠道订单</button>
        <button type="button" className="primary-button" onClick={openOrders}>订单管理</button>
      </div>
    </header>

    <section className="ops-panel erp-workbench-tasks" aria-labelledby="workbench-tasks-title">
      <div className="ops-panel-head"><h2 id="workbench-tasks-title">业务待办</h2></div>
      <div className="ops-task-grid">
        {tasks.map((task) => <button className="ops-task" type="button" key={task.label} onClick={task.open}>
          <span className="ops-task-label"><i aria-hidden="true" className={`ops-dot ops-dot-${task.tone}`} />{task.label}</span>
          <strong>{task.value === null ? '—' : task.value.toLocaleString('zh-CN')}{task.value !== null && task.unit && <small>{task.unit}</small>}</strong>
          {task.value === null && <span className="erp-task-unavailable">{task.detail}</span>}
        </button>)}
      </div>
    </section>

    <div className={`ops-home-grid${openStores ? '' : ' erp-workbench-single'}`}>
      <section className="ops-panel" aria-labelledby="workbench-recent-title">
        <div className="ops-panel-head"><h2 id="workbench-recent-title">最近订单</h2><button className="link-button" type="button" onClick={openOrders}>全部订单</button></div>
        {recentOrders}
      </section>
      {openStores && <section className="ops-panel erp-workbench-connections" aria-labelledby="workbench-connections-title">
        <div className="ops-panel-head"><h2 id="workbench-connections-title">独立站接入</h2><span>{verified == null ? '读取中' : `已核验 ${verified} / ${stores?.length ?? 0}`}</span></div>
        {stores?.length ? <ul className="ops-store-list">{stores.map((store) => {
          const state = connectionState(store);
          return <li key={store.key}><span><strong>{store.displayName}</strong>{store.lastSuccessfulSyncAt && <small>同步于 {timeLabel(store.lastSuccessfulSyncAt)}</small>}</span><StatePill label={state.text} tone={state.tone} /></li>;
        })}</ul> : <p className="ops-empty">暂无店铺接入状态</p>}
        <div className="erp-workbench-panel-foot"><button className="link-button" type="button" onClick={openStores}>管理店铺</button></div>
      </section>}
    </div>
  </div>;
}

const views = [
  { key: 'all', label: '全部' }, { key: 'pending', label: '待履约' }, { key: 'fulfilled', label: '已履约' },
  { key: 'cancelled', label: '已取消' }, { key: 'refund', label: '含退款' },
] as const satisfies readonly { key: ChannelOrderStatus; label: string }[];
const platformNames: Record<string, string> = { amazon: 'Amazon', shopify: 'Shopify', wayfair: 'Wayfair', yqn: 'YQN' };

function orderTime(value: string | null) {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.valueOf()) ? orderDateTime.format(date) : '—';
}

function orderMoney(currency: string | null, amount: string | null) {
  return amount === null ? '—' : [currency, amount].filter(Boolean).join(' ');
}

function orderFulfillment(order: ChannelOrder) {
  const status = order.fulfillmentStatus ?? '';
  if (order.sourceCancelledAt || cancelledFulfillmentStatuses.some((item) => item === status)) {
    return { label: '已取消', tone: 'muted' };
  }
  return {
    label: fulfillmentLabels[status] ?? markers[status] ?? '待核',
    tone: completedFulfillmentStatuses.some((item) => item === status) ? 'success' : 'info',
  };
}

type ChannelOrdersProps = {
  query: string; clearQuery: () => void; refreshAfter: object; openStores?: () => void; scoped?: boolean;
  workflow?: NineStoreWorkflow; canRefreshSource: boolean; onLinked: () => void;
};

type ChannelSource = 'native' | 'feishu';

export function ChannelOrderWorkspace({ hasNativeOrders, continuousFeishu, ...props }: ChannelOrdersProps & {
  hasNativeOrders: boolean; continuousFeishu: boolean;
}) {
  const [selection, setSelection] = useState<{ source: ChannelSource; explicit: boolean }>(() => ({
    source: hasNativeOrders ? 'native' : 'feishu', explicit: false,
  }));
  const showFeishuIfEmpty = useCallback(() => setSelection((current) => current.explicit || current.source === 'feishu' ? current
    : { source: 'feishu', explicit: false }), []);
  const feishuWorkflow = props.workflow ? { ...props.workflow, canCreate: continuousFeishu && props.workflow.canCreate } : undefined;

  return <section className="content ops-page erp-channel-page" aria-labelledby="channel-workspace-title">
    <header className="ops-heading"><h1 id="channel-workspace-title">渠道订单</h1>
      {props.openStores && <button type="button" className="secondary-button" onClick={props.openStores}>店铺接入</button>}</header>
    <div className="ops-panel erp-channel-source-tabs"><div className="ops-tabbar" role="group" aria-label="订单来源">
      <button type="button" aria-pressed={selection.source === 'native'} onClick={() => setSelection({ source: 'native', explicit: true })}>平台直连</button>
      <button type="button" aria-pressed={selection.source === 'feishu'} onClick={() => setSelection({ source: 'feishu', explicit: true })}>飞书订单</button>
    </div></div>
    {selection.source === 'native' ? <ChannelOrders {...props} embedded onFirstUnfilteredEmpty={showFeishuIfEmpty} />
      : <ErpNineStoreOrders query={props.query} workflow={feishuWorkflow} archived={!continuousFeishu} />}
  </section>;
}

export function ChannelOrders({ query, clearQuery, refreshAfter, openStores, scoped = false, workflow, canRefreshSource, onLinked,
  embedded = false, onFirstUnfilteredEmpty }: ChannelOrdersProps & { embedded?: boolean; onFirstUnfilteredEmpty?: () => void }) {
  const [view, setView] = useState<ChannelOrderStatus>('all');
  const [storeKey, setStoreKey] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [cursor, setCursor] = useState({ key: '', page: 1 });
  const [reload, setReload] = useState(0);
  const [result, setResult] = useState<{ key: string; filterKey: string; data?: ChannelOrderList; error?: string }>();
  const [current, setCurrent] = useState<ChannelOrder | null>(null);
  const checkedInitialResults = useRef(false);
  const q = query.trim().slice(0, 160);
  const rangeInvalid = Boolean(from && to && from > to);
  const filterKey = JSON.stringify([view, storeKey, from, to, q]);
  const page = cursor.key === filterKey ? cursor.page : 1;
  const key = JSON.stringify([filterKey, page, reload]);
  const live = result?.key === key ? result : undefined;
  const data = live?.data;
  const rows = data?.orders ?? [];
  const lastData = result?.filterKey === filterKey ? result.data : undefined;
  const pageCount = lastData ? Math.max(1, Math.ceil(lastData.total / lastData.pageSize)) : 1;
  const hasFilters = Boolean(view !== 'all' || storeKey || from || to || q);

  useEffect(() => {
    if (rangeInvalid) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const search = new URLSearchParams({ status: view, page: String(page), q });
        if (storeKey) search.set('store', storeKey);
        if (from) search.set('from', from);
        if (to) search.set('to', to);
        const response = await fetch(`/api/channel-orders?${search}`, { signal: controller.signal, cache: 'no-store' });
        const body = await response.json() as ChannelOrderList & { ok?: boolean; message?: string };
        if (!response.ok || body.ok !== true || !Array.isArray(body.orders)) throw new Error(body.message ?? '暂时无法读取渠道订单');
        if (controller.signal.aborted) return;
        const lastPage = Math.max(1, Math.ceil(body.total / body.pageSize));
        if (page > lastPage) {
          setCursor({ key: filterKey, page: lastPage });
          return;
        }
        setResult({ key, filterKey, data: body });
        if (!checkedInitialResults.current && !hasFilters && page === 1) {
          checkedInitialResults.current = true;
          if (!body.total) onFirstUnfilteredEmpty?.();
        }
      } catch (cause) {
        if (!controller.signal.aborted) setResult({ key, filterKey, error: cause instanceof Error ? cause.message : '暂时无法读取渠道订单' });
      }
    }, 150);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [view, storeKey, from, to, q, rangeInvalid, page, key, filterKey, hasFilters, refreshAfter, onFirstUnfilteredEmpty]);

  function resetFilters() {
    setView('all');
    setStoreKey('');
    setFrom('');
    setTo('');
    setCursor({ key: '', page: 1 });
    clearQuery();
  }

  const refresh = <button type="button" className="secondary-button" onClick={() => setReload((value) => value + 1)} disabled={rangeInvalid || !live}>刷新</button>;
  const statusTabs = <div className={embedded ? 'erp-channel-register-tabs' : 'ops-tabbar'} role="group" aria-label="渠道订单状态">
    {views.map((tab) => <button key={tab.key} type="button" aria-pressed={view === tab.key}
      onClick={() => { setView(tab.key); setCursor({ key: '', page: 1 }); }}>{tab.label}</button>)}</div>;
  return <div className={embedded ? undefined : 'content ops-page erp-channel-page'}>
    {!embedded && <header className="ops-heading"><h1>{scoped ? '平台直连订单' : '渠道订单'}</h1>
      <div className="erp-workbench-actions">
        {openStores && <button type="button" className="secondary-button" onClick={openStores}>店铺接入</button>}
        {refresh}
      </div>
    </header>}
    <article className="ops-panel ops-list" aria-busy={!live && !rangeInvalid}>
      {embedded ? <div className="erp-channel-register-head">{statusTabs}<div className="erp-channel-register-actions">{refresh}</div></div> : statusTabs}
      <div className="ops-filterline erp-channel-filterbar">
        <div><label>店铺 <select value={storeKey} onChange={(event) => { setStoreKey(event.target.value); setCursor({ key: '', page: 1 }); }}>
          <option value="">全部店铺</option>{(result?.data?.stores ?? []).map((store) => {
            const key = `${store.platform}/${store.key}`;
            return <option key={key} value={key}>{store.label} · {platformNames[store.platform] ?? store.platform}</option>;
          })}</select></label>
          <label>下单起日 <input type="date" value={from} aria-invalid={rangeInvalid} onChange={(event) => { setFrom(event.target.value); setCursor({ key: '', page: 1 }); }} /></label>
          <label>下单止日 <input type="date" value={to} aria-invalid={rangeInvalid} onChange={(event) => { setTo(event.target.value); setCursor({ key: '', page: 1 }); }} /></label>
          <button type="button" className="link-button" disabled={!hasFilters} onClick={resetFilters}>重置筛选</button></div>
        <span aria-live="polite">{data ? `共 ${data.total.toLocaleString('zh-CN')} 条` : !rangeInvalid && !live ? '正在读取…' : ''}</span>
      </div>
      {rangeInvalid && <p className="ops-empty" role="alert">下单起日应早于或等于止日。</p>}
      {live?.error && <div className="inline-alert" role="alert"><p>{live.error}</p><button type="button" onClick={() => setReload((value) => value + 1)}>重试</button></div>}
      <div className="table-wrap ops-table erp-channel-table" role="region" aria-label="渠道订单列表" tabIndex={0}><table>
        <thead><tr><th scope="col">平台订单号</th><th scope="col">店铺</th><th scope="col">付款</th><th scope="col">履约</th><th scope="col" className="erp-align-number">原币金额</th><th scope="col">下单时间</th></tr></thead>
        <tbody>{rows.map((order) => <tr key={order.id}>
          <td><button className="link-button" type="button" onClick={() => setCurrent(order)}>{order.sourceOrderName ?? order.sourceOrderId}</button></td>
          <td>{order.storeName}<small className="cell-sub">{platformNames[order.platform] ?? order.platform}</small></td>
          <td>{markers[order.financialStatus ?? ''] ?? '待核'}</td>
          <td><StatePill {...orderFulfillment(order)} /></td>
          <td className="erp-align-number">{orderMoney(order.currency, order.currentTotalAmount)}</td>
          <td className="erp-channel-date">{orderTime(order.sourceCreatedAt)}</td></tr>)}</tbody>
      </table></div>
      {data && !rows.length && <div className="ops-list-empty"><strong>{hasFilters ? '暂无匹配订单' : '暂无平台直连订单'}</strong>
        {hasFilters ? <button type="button" className="link-button" onClick={resetFilters}>清除筛选</button>
          : openStores && <button type="button" className="link-button" onClick={openStores}>检查店铺接入</button>}
      </div>}
      {pageCount > 1 && <div className="pagination"><span>第 {page} / {pageCount} 页</span><div>
        <button type="button" aria-label="渠道订单上一页" disabled={page <= 1} onClick={() => setCursor({ key: filterKey, page: page - 1 })}>‹</button>
        <button type="button" aria-label="渠道订单下一页" disabled={page >= pageCount} onClick={() => setCursor({ key: filterKey, page: page + 1 })}>›</button>
      </div></div>}
    </article>
    {current && <ChannelOrderDialog key={current.id} order={current} onClose={() => setCurrent(null)}
      workflow={workflow} canRefreshSource={canRefreshSource} onLinked={onLinked} />}
  </div>;
}

function ChannelOrderDialog({ order, onClose, workflow, canRefreshSource, onLinked }: {
  order: ChannelOrder; onClose: () => void; workflow?: NineStoreWorkflow; canRefreshSource: boolean; onLinked: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [details, setDetails] = useState<ChannelOrderDetails>();
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => { if (element?.open) element.close(); };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    async function loadDetails() {
      try {
        const response = await fetch(`/api/channel-orders/${encodeURIComponent(order.id)}`, { cache: 'no-store', signal: controller.signal });
        const body = await response.json() as ChannelOrderDetails & { ok?: boolean; message?: string };
        if (!response.ok || body.ok !== true || !body.order) throw new Error(body.message ?? '暂时无法读取订单详情');
        if (!controller.signal.aborted) setDetails(body);
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '暂时无法读取订单详情');
      }
    }
    void loadDetails();
    return () => controller.abort();
  }, [order.id, reload]);
  const record = details?.order ?? order;

  return <dialog ref={dialog} className="modal erp-channel-dialog" aria-labelledby="channel-order-title"
    onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <div className="modal-head"><div><h2 id="channel-order-title">{record.sourceOrderName ?? record.sourceOrderId}</h2><p>{record.storeName}</p></div>
      <button type="button" aria-label="关闭订单详情" onClick={onClose}>×</button></div>
    <dl className="ops-order-details"><div><dt>付款状态</dt><dd>{markers[record.financialStatus ?? ''] ?? '待核'}</dd></div>
      <div><dt>履约状态</dt><dd>{orderFulfillment(record).label}</dd></div>
      <div><dt>订单金额</dt><dd>{orderMoney(record.currency, record.currentTotalAmount)}</dd></div>
      <div><dt>已退款</dt><dd>{orderMoney(record.currency, record.refundedAmount)}</dd></div>
      <div><dt>下单时间</dt><dd>{orderTime(record.sourceCreatedAt)}</dd></div><div><dt>平台更新时间</dt><dd>{orderTime(record.sourceUpdatedAt)}</dd></div></dl>
    {!details && (error ? <div className="inline-alert" role="alert"><p>{error}</p><button type="button" onClick={() => { setError(''); setReload((value) => value + 1); }}>重试</button></div>
      : <p className="ops-empty" role="status">正在读取商品、退款与履约明细…</p>)}
    {details && workflow && ['shopify', 'amazon'].includes(record.platform) &&
      <ErpChannelOrderHandoff order={record} workflow={workflow} canRefreshSource={canRefreshSource}
        onChanged={() => { setReload((value) => value + 1); onLinked(); }} />}
    {details && <ChannelOrderActivity details={details} />}
  </dialog>;
}

function ChannelOrderActivity({ details }: { details: ChannelOrderDetails }) {
  const { order, lines, refunds, fulfillments, tracking } = details;
  const tracksByFulfillment = new Map<string, typeof tracking>();
  for (const track of tracking) {
    const records = tracksByFulfillment.get(track.fulfillmentId) ?? [];
    records.push(track);
    tracksByFulfillment.set(track.fulfillmentId, records);
  }
  return <div className="erp-channel-activity">
    <section>
      <h3>商品明细 <small>{order.lineCount} 项</small></h3>
      {lines.length ? <div className="table-wrap ops-table" tabIndex={0} role="region" aria-label="渠道订单商品明细"><table>
        <thead><tr><th scope="col">平台 SKU / 商品</th><th scope="col">ERP SKU</th><th scope="col" className="erp-align-number">下单 / 当前 / 待履约</th><th scope="col" className="erp-align-number">原币单价</th></tr></thead>
        <tbody>{lines.map((line) => <tr key={line.id}><td><strong>{line.rawSku ?? '—'}</strong>{line.title && <small className="cell-sub">{line.title}</small>}</td><td>{line.skuCode ?? '—'}</td>
          <td className="erp-align-number">{line.orderedQuantity} / {line.currentQuantity ?? '—'} / {line.unfulfilledQuantity ?? '—'}</td>
          <td className="erp-align-number">{orderMoney(line.currency, line.unitPriceAmount)}</td></tr>)}</tbody>
      </table></div> : <p>暂无商品明细</p>}
      {order.lineCount > lines.length && <p>当前显示前 {lines.length} 项。</p>}
    </section>
    <section>
      <h3>退款记录 <small>{order.refundCount} 笔</small></h3>
      {refunds.length ? <ul>{refunds.map((refund) => <li key={refund.id}><span>{orderTime(refund.createdAt)}</span><strong>{orderMoney(refund.currency, refund.amount)}</strong></li>)}</ul> : <p>暂无退款记录</p>}
      {order.refundCount > refunds.length && <p>当前显示前 {refunds.length} 笔。</p>}
    </section>
    <section>
      <h3>履约记录 <small>{order.fulfillmentCount} 笔</small></h3>
      {fulfillments.length ? <ul>{fulfillments.map((record) => <li key={record.id}><div>
        <strong>{shipmentLabel(record.shipmentStatus ?? record.status)}</strong>
        {(tracksByFulfillment.get(record.id) ?? []).map((track) => <span key={track.id}>{[track.company, track.trackingNumber].filter(Boolean).join(' ') || '暂无运单号'}</span>)}
      </div><span>{orderTime(record.deliveredAt ?? record.updatedAt)}</span></li>)}</ul> : <p>暂无履约记录</p>}
      {order.fulfillmentCount > fulfillments.length && <p>当前显示前 {fulfillments.length} 笔。</p>}
      {details.trackingLimited && <p>当前只显示部分运单。</p>}
    </section>
  </div>;
}

function shipmentLabel(status: string | null) {
  const labels: Record<string, string> = { SUCCESS: '履约成功', CANCELLED: '已取消', DELIVERED: '已签收', IN_TRANSIT: '运输中', FAILURE: '履约失败', OUT_FOR_DELIVERY: '派送中' };
  return status ? labels[status] ?? markers[status] ?? status : '状态待核';
}

const shopifyAccessLabels = { orders: '订单', products: '商品', inventory: '库存' } as const;
const shopifyAccessStatus: Record<ShopifyCapabilityState, string> = {
  granted: '已授权', missing: '缺授权', unknown: '待核验', unconfigured: '未接入',
};

export function StoreConnections({ stores, jobActive, canSync, syncBusy, runSync, inventoryPanel, onOrdersSynced }: {
  stores: StoreConnection[] | null; jobActive: boolean; canSync: boolean; syncBusy: string;
  runSync: (store: StoreConnection) => void; inventoryPanel?: ReactNode; onOrdersSynced: () => void;
}) {
  return <div className="content ops-page erp-channel-page erp-connection-page">
    <header className="ops-heading"><h1>店铺接入</h1></header>
    <ErpStoreCoverage refreshAfter={stores} />
    <article className="ops-panel ops-list">
      <div className="ops-panel-head"><h2>Shopify 独立站</h2><StatePill label={jobActive ? '后台任务已配置' : '后台任务未启用'} tone={jobActive ? 'info' : 'muted'} /></div>
      <div className="table-wrap ops-table erp-channel-table"><table aria-label="Shopify 店铺接入列表"><thead><tr><th scope="col">店铺</th><th scope="col">连接状态</th><th scope="col">读取权限</th><th scope="col">最近成功同步</th><th scope="col">操作</th></tr></thead>
        <tbody>{stores?.map((store) => {
          const state = connectionState(store);
          const access = store.accessCapabilities;
          const canRunOrders = canSync && store.credentialsConfigured && access?.orders !== 'missing';
          const authorizeUrl = canSync ? store.authorizationStartUrl : null;
          const domain = store.verifiedDomain ?? store.expectedDomain;
          return <tr key={store.key}><td><strong>{store.displayName}</strong>{domain && <small className="cell-sub">{domain}</small>}</td>
            <td><StatePill label={state.text} tone={state.tone} />{store.syncStatus === 'failed' && store.lastErrorCode && <small className="cell-sub">{store.lastErrorCode}</small>}</td>
            <td>{access && store.credentialsConfigured ? <div className="erp-shopify-permissions">
              {(Object.keys(shopifyAccessLabels) as (keyof ShopifyAccessCapabilities)[]).map((key) => <span key={key}>
                {shopifyAccessLabels[key]} <StatePill label={shopifyAccessStatus[access[key]]} tone={access[key] === 'granted' ? 'success' : access[key] === 'missing' ? 'warning' : 'muted'} />
              </span>)}
            </div> : '—'}</td>
            <td className="erp-channel-date">{timeLabel(store.lastSuccessfulSyncAt)}</td>
            <td>{canRunOrders || authorizeUrl ? <div className="erp-workbench-actions">
              {canRunOrders && <button className="link-button" type="button" disabled={Boolean(syncBusy)} onClick={() => runSync(store)}>{syncBusy === store.key ? '同步中…' : store.completedWatermark ? '手动补同步' : '首次同步'}</button>}
              {authorizeUrl && <a className="link-button" href={authorizeUrl}>{store.credentialsConfigured ? '补充授权' : '授权店铺'}</a>}
            </div> : '—'}</td>
          </tr>;
        })}</tbody></table></div>
      {!stores?.length && <p className="ops-empty">暂无 Shopify 接入状态</p>}
    </article>
    {inventoryPanel}
    <ErpShopifyProductArchive stores={stores} canSync={canSync} />
    <ErpAmazonStoreConnections canSync={canSync} onSync={onOrdersSynced} />
    <ErpWayfairConnection canPreview={canSync} />
  </div>;
}
