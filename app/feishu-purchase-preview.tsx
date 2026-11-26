'use client';

import { Fragment, useEffect, useId, useMemo, useRef, useState } from 'react';
import { buildFeishuPilotCandidates, feishuPilotSkuKey, type FeishuPilotPurchaseContext } from '../lib/feishu-replenishment-pilot';
import FeishuReplenishmentPilot from './feishu-replenishment-pilot';

type PreviewSku = {
  sku: string;
  verifiedSales: number | null;
  otherSales: number | null;
  storeCount: number;
  ca: number | null;
  ga: number | null;
  nj: number | null;
  stockTotal: number | null;
  warehouseCount: number;
  transitPcs: number | null;
  status: string;
};

type StoreSale = {
  sku: string;
  platform: string;
  store: string;
  verifiedSales: number | null;
  otherSales: number | null;
  trustedDays: number;
  averagePerDay: number | null;
};

type TransitRow = {
  sku: string;
  region: string;
  arrivalDate: string;
  pcs: number;
  batch: string | null;
  container: string | null;
};

type ReviewRow = {
  category: string;
  source: string;
  date: string | null;
  sku: string;
  quantity: number | null;
  unit: string;
  reason: string;
  evidence: string;
};

type PreviewSnapshot = {
  snapshotDate: string;
  salesStart: string;
  salesEnd: string;
  skus: PreviewSku[];
  storeSales: StoreSale[];
  transit: TransitRow[];
  review: ReviewRow[];
};

type PreviewSync = {
  enabled: boolean;
  status: 'idle' | 'running' | 'success' | 'failed';
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  error: string | null;
  canTrigger: boolean;
};
type PreviewResult = { snapshot: PreviewSnapshot | null; sync: PreviewSync | null };
type PreviewResponse = { ok?: boolean; snapshot?: PreviewSnapshot | null; sync?: PreviewSync | null; code?: string; message?: string };
type PreviewView = 'sku' | 'review';

const zeroStockLabel = '三仓确认可用为 0';
const pageSize = 25;
const quantityFormat = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 6 });
const beijingTime = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});
const syncStatusLabels: Record<PreviewSync['status'], string> = {
  idle: '等待同步', running: '同步中', success: '最近同步成功', failed: '最近同步失败',
};

function Quantity({ value }: { value: number | null }) {
  return value === null ? <span className="feishu-preview-unknown">待核</span> : quantityFormat.format(value);
}

function hasConfirmedZeroStock(row: PreviewSku) {
  return row.ca === 0 && row.ga === 0 && row.nj === 0;
}

function skuStatus(row: PreviewSku) {
  return row.status === zeroStockLabel && !hasConfirmedZeroStock(row) ? '库存归属待核' : row.status;
}

type PreviewProps = {
  query: string;
  onQueryChange: (query: string) => void;
  purchaseContext: Record<string, FeishuPilotPurchaseContext>;
  onPrepareRequest?: (sku: string, quantity: number, basis: string) => Promise<void>;
  archived?: boolean;
};

export default function FeishuPurchasePreview({ query, onQueryChange, purchaseContext, onPrepareRequest, archived = false }: PreviewProps) {
  const [result, setResult] = useState<PreviewResult | null>(null);
  const [readError, setReadError] = useState('');
  const [startError, setStartError] = useState('');
  const [starting, setStarting] = useState(false);
  const actions = useRef<{ refresh: () => void; start: () => void } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let timer: number | undefined;
    let operation: 'read' | 'start' | null = null;
    let startQueued = false;
    let latestSync: PreviewSync | null = null;

    function requestSignal() {
      return AbortSignal.any([controller.signal, AbortSignal.timeout(12_000)]);
    }

    function scheduleRead() {
      window.clearTimeout(timer);
      if (archived) return;
      timer = window.setTimeout(() => { void loadSnapshot(); }, latestSync?.status === 'running' ? 2_000 : 30_000);
    }

    async function loadSnapshot() {
      if (controller.signal.aborted || operation) return;
      operation = 'read';
      try {
        const response = await fetch('/api/purchase/feishu-preview', {
          cache: 'no-store',
          credentials: 'same-origin',
          signal: requestSignal(),
        });
        if (response.status === 401 || response.status === 403) {
          latestSync = null;
          if (!controller.signal.aborted) setResult(null);
          throw new Error('当前账号无法查看飞书补货预览。');
        }
        const body = await response.json().catch(() => null) as PreviewResponse | null;
        if (!response.ok || body?.ok !== true || body.snapshot === undefined) {
          throw new Error(body?.message || '飞书补货快照读取失败。');
        }
        const snapshot = body.snapshot;
        if (snapshot !== null && [snapshot.skus, snapshot.storeSales, snapshot.transit, snapshot.review].some((rows) => !Array.isArray(rows))) {
          throw new Error('飞书补货快照格式有误。');
        }
        latestSync = body.sync ?? null;
        if (!controller.signal.aborted) {
          setResult({ snapshot, sync: latestSync });
          setReadError('');
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          setReadError(error instanceof Error && error.message ? error.message : '飞书补货快照读取失败。');
        }
      } finally {
        operation = null;
        if (!controller.signal.aborted) {
          if (startQueued) {
            startQueued = false;
            void startSync();
          } else {
            scheduleRead();
          }
        }
      }
    }

    async function startSync() {
      if (!latestSync?.enabled || !latestSync.canTrigger || latestSync.status === 'running') {
        setStarting(false);
        scheduleRead();
        return;
      }
      operation = 'start';
      try {
        const response = await fetch('/api/purchase/feishu-preview/sync', {
          method: 'POST',
          credentials: 'same-origin',
          signal: requestSignal(),
        });
        const body = await response.json().catch(() => null) as PreviewResponse | null;
        if ((response.status === 202 && body?.ok === true)
          || (response.status === 409 && body?.code === 'FEISHU_SYNC_BUSY')) {
          const sync: PreviewSync = { ...latestSync, status: 'running', error: null };
          latestSync = sync;
          if (!controller.signal.aborted) setResult((previous) => previous && { ...previous, sync });
        } else if (!controller.signal.aborted) {
          setStartError(body?.message || '无法发起飞书同步。');
        }
      } catch {
        if (!controller.signal.aborted) setStartError('未收到同步请求的响应。请查看最新同步状态。');
      } finally {
        operation = null;
        if (!controller.signal.aborted) {
          setStarting(false);
          void loadSnapshot();
        }
      }
    }

    actions.current = {
      refresh() {
        window.clearTimeout(timer);
        void loadSnapshot();
      },
      start() {
        if (!latestSync?.enabled || !latestSync.canTrigger || latestSync.status === 'running' || operation === 'start' || startQueued) return;
        window.clearTimeout(timer);
        setStartError('');
        setStarting(true);
        if (operation === 'read') startQueued = true;
        else void startSync();
      },
    };
    void loadSnapshot();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
      actions.current = null;
    };
  }, [archived]);

  if (!result && !readError) return <p className="feishu-preview-state" role="status">正在读取期初采购资料…</p>;

  return <>
    {result && !archived && <SyncPanel sync={result.sync} starting={starting} startError={startError} onStart={() => actions.current?.start()} />}
    {readError && <div className="feishu-preview-state">
      <p role="alert">{readError}{result?.snapshot && ' 当前显示最近一次读取成功的快照。'}</p>
      <button className="secondary-button" type="button" onClick={() => actions.current?.refresh()}>重新读取</button>
    </div>}
    {result?.snapshot ? <SnapshotView snapshot={result.snapshot} query={query} onQueryChange={onQueryChange}
      purchaseContext={purchaseContext} onPrepareRequest={onPrepareRequest} archived={archived} />
      : result && <p className="feishu-preview-state">暂无已导入的采购与库存资料。</p>}
  </>;
}

function SyncTime({ value }: { value: string | null }) {
  if (!value) return '尚无记录';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? '时间待核' : <time dateTime={value}>{beijingTime.format(date)}</time>;
}

function SyncPanel({ sync, starting, startError, onStart }: {
  sync: PreviewSync | null;
  starting: boolean;
  startError: string;
  onStart: () => void;
}) {
  const status = sync?.enabled ? sync.status : 'disabled';
  const label = status === 'disabled' ? '未启用' : syncStatusLabels[status];
  return <section className="feishu-preview-sync" aria-label="飞书同步">
    <div className="feishu-preview-sync-header">
      <div className="feishu-preview-sync-title">
        <strong>飞书同步</strong>
        <span className="feishu-preview-sync-status" data-status={status} role="status">{label}</span>
      </div>
      {sync?.canTrigger && <button
        className="primary-button"
        type="button"
        disabled={!sync.enabled || sync.status === 'running' || starting}
        onClick={onStart}
      >{starting ? '正在发起…' : sync.status === 'running' ? '同步中…' : '立即同步'}</button>}
    </div>
    {sync ? <dl className="feishu-preview-sync-times">
      <div><dt>最近成功（北京时间）</dt><dd><SyncTime value={sync.lastSuccessAt} /></dd></div>
      <div><dt>最近尝试（北京时间）</dt><dd><SyncTime value={sync.lastAttemptAt} /></dd></div>
    </dl> : <p className="feishu-preview-sync-note">此环境未配置飞书同步。</p>}
    {sync && !sync.enabled && <p className="feishu-preview-sync-note">飞书同步未启用，可查看已保存的快照。</p>}
    {sync?.status === 'failed' && sync.error && <p className="feishu-preview-sync-error" role="status">{sync.error}</p>}
    {startError && <p className="feishu-preview-sync-error" role="alert">{startError}</p>}
  </section>;
}

function SnapshotView({ snapshot, query, onQueryChange, purchaseContext, onPrepareRequest, archived }: PreviewProps & { snapshot: PreviewSnapshot }) {
  const [view, setView] = useState<PreviewView>('sku');
  const [status, setStatus] = useState('');
  const [category, setCategory] = useState('');
  const [expandedSku, setExpandedSku] = useState<string | null>(null);
  const [pagination, setPagination] = useState<{ filterKey: string; page: number } | null>(null);
  const detailPrefix = useId();
  const pilotCandidates = useMemo(() => buildFeishuPilotCandidates(snapshot), [snapshot]);
  const pilotContext = Object.fromEntries(pilotCandidates.flatMap((candidate) => {
    const entry = purchaseContext[feishuPilotSkuKey(candidate.sku)];
    return entry ? [[candidate.sku, entry]] : [];
  }));
  const zeroCount = snapshot.skus.filter(hasConfirmedZeroStock).length;
  const statusOptions = [...new Set([...snapshot.skus.map(skuStatus), status])]
    .filter((value) => value && value !== zeroStockLabel)
    .sort((left, right) => left.localeCompare(right, 'zh-CN'));
  const categoryOptions = [...new Set([...snapshot.review.map((row) => row.category), category])]
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right, 'zh-CN'));
  const search = query.trim().toLowerCase();
  const skuRows = snapshot.skus.filter((row) => {
    const matchesStatus = status === zeroStockLabel ? hasConfirmedZeroStock(row) : !status || skuStatus(row) === status;
    return matchesStatus && row.sku.toLowerCase().includes(search);
  });
  const reviewRows = snapshot.review.filter((row) => (
    row.sku.toLowerCase().includes(search) && (!category || row.category === category)
  ));
  const rowCount = view === 'sku' ? skuRows.length : reviewRows.length;
  const filterKey = JSON.stringify([view, search, status, category]);
  const pageCount = Math.max(1, Math.ceil(rowCount / pageSize));
  const page = pagination?.filterKey === filterKey ? Math.min(pagination.page, pageCount) : 1;
  const offset = (page - 1) * pageSize;
  const visibleSkus = skuRows.slice(offset, offset + pageSize);
  const visibleReview = reviewRows.slice(offset, offset + pageSize);

  return <section className="feishu-preview" aria-label="采购与库存资料">
    <div className="feishu-preview-source">
      <strong>快照日期 <time dateTime={snapshot.snapshotDate}>{snapshot.snapshotDate}</time></strong>
      <span>销量范围 <time dateTime={snapshot.salesStart}>{snapshot.salesStart}</time> 至 <time dateTime={snapshot.salesEnd}>{snapshot.salesEnd}</time></span>
      {snapshot.salesEnd === snapshot.snapshotDate && <span className="feishu-preview-source-note">当日未结销量计入「其他销量」</span>}
    </div>
    {!archived && <FeishuReplenishmentPilot candidates={pilotCandidates} snapshotDate={snapshot.snapshotDate}
      purchaseContext={pilotContext} onPrepareRequest={onPrepareRequest} />}
    <div className="feishu-preview-views" aria-label="预览范围" role="group">
      <button className="secondary-button" type="button" aria-pressed={view === 'sku' && status === ''} onClick={() => {
        setView('sku');
        setStatus('');
      }}>全部 SKU <b>{quantityFormat.format(snapshot.skus.length)}</b></button>
      <button className="secondary-button" type="button" aria-pressed={view === 'sku' && status === zeroStockLabel} onClick={() => {
        setView('sku');
        setStatus(zeroStockLabel);
      }}>{zeroStockLabel} <b>{quantityFormat.format(zeroCount)}</b></button>
      <button className="secondary-button" type="button" aria-pressed={view === 'review'} onClick={() => setView('review')}>
        剔除待核 <b>{quantityFormat.format(snapshot.review.length)}</b>
      </button>
    </div>
    <div className="procurement-filters feishu-preview-filters">
      <label>搜索 SKU<input type="search" value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder="输入 SKU 编码" /></label>
      {view === 'sku' ? <label>状态
        <select value={status} onChange={(event) => setStatus(event.target.value)}>
          <option value="">全部状态</option>
          <option value={zeroStockLabel}>{zeroStockLabel}</option>
          {statusOptions.map((value) => <option value={value} key={value}>{value}</option>)}
        </select>
      </label> : <label>类别
        <select value={category} onChange={(event) => setCategory(event.target.value)}>
          <option value="">全部类别</option>
          {categoryOptions.map((value) => <option value={value} key={value}>{value}</option>)}
        </select>
      </label>}
    </div>
    {view === 'sku' ? <>
      <p className="procurement-filter-note">0 表示已核实的零值，「待核」表示该项尚未确认。点击 SKU 查看店铺销量及在途明细。</p>
      {visibleSkus.length > 0 ? <div className="table-wrap module-table feishu-preview-list">
        <table aria-label="飞书补货 SKU 预览">
          <thead><tr>
            <th scope="col">SKU</th><th scope="col">核实销量</th><th scope="col">其他销量</th><th scope="col">店铺数</th>
            <th scope="col">CA 可用</th><th scope="col">GA 可用</th><th scope="col">NJ 可用</th><th scope="col">库存合计</th>
            <th scope="col">在途 PCS</th><th scope="col">状态</th>
          </tr></thead>
          <tbody>{visibleSkus.map((row, index) => {
            const expanded = expandedSku === row.sku;
            const detailId = `${detailPrefix}-${offset + index}`;
            return <Fragment key={row.sku}>
              <tr>
                <th scope="row">
                  <button className="feishu-preview-sku" type="button" aria-expanded={expanded} aria-controls={expanded ? detailId : undefined} onClick={() => {
                    setExpandedSku(expanded ? null : row.sku);
                  }}><span>{row.sku}</span></button>
                </th>
                <td><Quantity value={row.verifiedSales} /></td><td><Quantity value={row.otherSales} /></td>
                <td><Quantity value={row.storeCount} /></td><td><Quantity value={row.ca} /></td>
                <td><Quantity value={row.ga} /></td><td><Quantity value={row.nj} /></td>
                <td><Quantity value={row.stockTotal} /><small className="cell-sub">仓库记录 {row.warehouseCount}/3</small></td>
                <td><Quantity value={row.transitPcs} /></td>
                <td><span className={hasConfirmedZeroStock(row) ? 'feishu-preview-zero' : undefined}>{skuStatus(row) || '待核'}</span></td>
              </tr>
              {expanded && <tr id={detailId}><td colSpan={10} className="feishu-preview-detail-cell">
                <SkuDetails sku={row.sku} storeSales={snapshot.storeSales} transit={snapshot.transit} />
              </td></tr>}
            </Fragment>;
          })}</tbody>
        </table>
      </div> : <p className="feishu-preview-state">没有匹配的 SKU。</p>}
    </> : visibleReview.length > 0 ? <ReviewTable rows={visibleReview} offset={offset} showEvidence={!archived} /> : (
      <p className="feishu-preview-state">没有匹配的剔除待核记录。</p>
    )}
    <div className="feishu-preview-pagination">
      <span role="status">{rowCount > 0 ? `显示 ${offset + 1}–${Math.min(offset + pageSize, rowCount)} / ${rowCount} 条` : '共 0 条'}</span>
      {pageCount > 1 && <div aria-label="预览分页" role="group">
        <button className="secondary-button" type="button" disabled={page <= 1} onClick={() => setPagination({ filterKey, page: page - 1 })}>上一页</button>
        <span>第 {page}/{pageCount} 页</span>
        <button className="secondary-button" type="button" disabled={page >= pageCount} onClick={() => setPagination({ filterKey, page: page + 1 })}>下一页</button>
      </div>}
    </div>
  </section>;
}

function SkuDetails({ sku, storeSales, transit }: {
  sku: string;
  storeSales: StoreSale[];
  transit: TransitRow[];
}) {
  const sales = storeSales.filter((row) => row.sku === sku);
  const shipments = transit.filter((row) => row.sku === sku);
  return <div className="feishu-preview-detail">
    <section aria-label={`${sku} 店铺销量`}>
      <h3>店铺销量</h3>
      {sales.length > 0 ? <table aria-label={`${sku} 店铺销量明细`}>
        <thead><tr>
          <th scope="col">平台</th><th scope="col">店铺</th><th scope="col">核实销量</th>
          <th scope="col">其他销量</th><th scope="col">核实天数</th><th scope="col">日均销量</th>
        </tr></thead>
        <tbody>{sales.map((row, index) => <tr key={`${row.platform}-${row.store}-${index}`}>
          <td>{row.platform}</td><td>{row.store}</td><td><Quantity value={row.verifiedSales} /></td>
          <td><Quantity value={row.otherSales} /></td><td><Quantity value={row.trustedDays} /></td>
          <td><Quantity value={row.averagePerDay} /></td>
        </tr>)}</tbody>
      </table> : <p>本次快照暂无店铺销量明细。</p>}
    </section>
    <section aria-label={`${sku} 在途明细`}>
      <h3>在途明细</h3>
      {shipments.length > 0 ? <table aria-label={`${sku} 在途批次`}>
        <thead><tr>
          <th scope="col">区域</th><th scope="col">预计到仓</th><th scope="col">数量 PCS</th>
          <th scope="col">批次</th><th scope="col">柜号</th>
        </tr></thead>
        <tbody>{shipments.map((row, index) => <tr key={`${row.arrivalDate}-${row.batch}-${index}`}>
          <td>{row.region}</td><td><time dateTime={row.arrivalDate}>{row.arrivalDate}</time></td><td><Quantity value={row.pcs} /></td>
          <td>{row.batch || '—'}</td><td>{row.container || '—'}</td>
        </tr>)}</tbody>
      </table> : <p>本次快照暂无符合口径的在途明细。</p>}
    </section>
  </div>;
}

function ReviewTable({ rows, offset, showEvidence }: { rows: ReviewRow[]; offset: number; showEvidence: boolean }) {
  return <div className="table-wrap module-table feishu-preview-review">
    <table aria-label="剔除待核明细">
      <thead><tr>
        <th scope="col">类别</th>{showEvidence && <th scope="col">来源</th>}<th scope="col">日期</th><th scope="col">SKU</th>
        <th scope="col">原数量</th><th scope="col">原因</th>{showEvidence && <th scope="col">核对依据</th>}
      </tr></thead>
      <tbody>{rows.map((row, index) => <tr key={offset + index}>
        <td>{row.category}</td>{showEvidence && <td>{row.source}</td>}
        <td>{row.date ? <time dateTime={row.date}>{row.date}</time> : '—'}</td><td>{row.sku || '—'}</td>
        <td><Quantity value={row.quantity} />{row.unit && ` ${row.unit}`}</td><td>{row.reason}</td>{showEvidence && <td>{row.evidence || '—'}</td>}
      </tr>)}</tbody>
    </table>
  </div>;
}
