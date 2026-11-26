'use client';

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { WarehouseMovement, WarehouseMovementType, WarehouseOutboundOrder, WarehousePage, WarehouseStockCount } from '../lib/warehouse-service';
import ErpPurchaseQuality from './erp-purchase-quality';
import WarehouseOutboundOperation from './warehouse-outbound-operation';
import styles from './erp-warehouse.module.css';

type Warehouse = { id: string; code: string; name: string };
type Sku = { id: string; code: string; name: string };
type SkuLine = { skuCode: string; skuName: string };
type PurchaseArrival = {
  id: string; orderNo: string; status: string;
  deliveryWarehouse: { id: string; code: string | null; name: string | null } | null;
  supplier: { name: string } | null;
  expectedDeliveryAt: string | null; orderedQuantity: number; receivedQuantity: number;
  lines: (SkuLine & { remainingQuantity: number })[];
};
type PurchaseReceipt = {
  id: string; receiptNo: string; purchaseOrderNo: string; warehouse: Warehouse; receivedAt: string;
  totalQuantity: number; originalQuantity?: number; correctedQuantity?: number; netQuantity?: number;
  lines: SkuLine[];
};
type Balance = SkuLine & {
  id: string; skuId: string; warehouseId: string; warehouseName: string;
  onHandQty: number; reservedQty: number; availableQty: number; version: number; updatedAt: string;
};
type WarehouseProps<Arrival extends PurchaseArrival, Receipt extends PurchaseReceipt> = {
  workspace: {
    readOnly?: boolean; warehouses: Warehouse[]; purchaseOrders: Arrival[]; purchaseReceipts: Receipt[];
    procurementSummary: { receiptCount: number };
  } | null;
  inventory: Balance[];
  query: string;
  initialTab: 'inbound' | 'outbound';
  canReceive: boolean;
  canRequireQuality?: boolean;
  canManage: boolean;
  canShip: boolean;
  canReadMovements?: boolean;
  busy: string;
  onCreateWarehouse: () => void;
  onReceive: (order: Arrival) => void;
  onCorrect: (receipt: Receipt) => void | Promise<void>;
  onShip: (order: WarehouseOutboundOrder) => Promise<boolean>;
  onOpenLogistics?: (orderNo: string) => void;
  onRefresh: () => Promise<void>;
};
type CountTarget = { warehouseId: string; sku: Sku | null };
type Tab = 'inbound' | 'outbound' | 'receipts' | 'stock' | 'counts' | 'movements';
type ReadState<T> = { url: string; data: T | null; error: string };
type MovementFilters = { sku: { id: string; code: string } | null; type: WarehouseMovementType | ''; from: string; through: string };
const emptyMovementFilters: MovementFilters = { sku: null, type: '', from: '', through: '' };

const tabs: { id: Tab; label: string }[] = [
  { id: 'inbound', label: '待收货' }, { id: 'outbound', label: '待出库' }, { id: 'receipts', label: '入库流水' },
  { id: 'stock', label: 'ERP 仓存' }, { id: 'movements', label: '库存流水' }, { id: 'counts', label: '盘点记录' },
];
const outboundStages = ['待拣货', '待复核', '待打包', '待确认发货'] as const;
const movementLabels: Record<WarehouseMovementType, string> = {
  reserve: '订单预占', release: '取消释放', ship: '销售出库', receipt: '采购入库',
  receipt_correction: '到货冲正', opening: '期初建账', count: '仓库盘点',
};
const pageSize = 25;
const beijingTime = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Shanghai' });
const movementTime = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'medium', timeZone: 'Asia/Shanghai' });
const formatAmount = new Intl.NumberFormat('zh-CN');
const amount = (value: number | null) => value === null ? '待核' : formatAmount.format(value);
const displayTime = (value: string) => Number.isFinite(Date.parse(value)) ? beijingTime.format(new Date(value)) : '时间待核';
const displayMovementTime = (value: string) => Number.isFinite(Date.parse(value)) ? movementTime.format(new Date(value)) : '时间待核';

function useWarehouseRead<T>(url: string | null, refresh = 0) {
  const [state, setState] = useState<ReadState<T> | null>(null);
  useEffect(() => {
    if (!url) return;
    const controller = new AbortController();
    const readUrl = url;
    async function read() {
      try {
        const response = await fetch(readUrl, { cache: 'no-store', signal: controller.signal });
        const body = await response.json() as T & { ok?: boolean; message?: string };
        if (!response.ok || body.ok !== true) throw new Error(body.message || '暂时无法读取数据');
        if (!controller.signal.aborted) setState({ url: readUrl, data: body, error: '' });
      } catch (error) {
        if (!controller.signal.aborted) setState((previous) => ({ url: readUrl,
          data: previous?.url === readUrl ? previous.data : null,
          error: error instanceof Error ? error.message : '暂时无法读取数据' }));
      }
    }
    const timer = setTimeout(() => { void read(); }, 150);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [url, refresh]);
  return state?.url === url ? state : null;
}

export default function ErpWarehouse<Arrival extends PurchaseArrival, Receipt extends PurchaseReceipt>({
  workspace, inventory, query, initialTab, canReceive, canRequireQuality = false, canManage, canShip, canReadMovements = false,
  busy, onCreateWarehouse, onReceive, onCorrect, onShip, onOpenLogistics, onRefresh,
}: WarehouseProps<Arrival, Receipt>) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [warehouseId, setWarehouseId] = useState('');
  const [cursor, setCursor] = useState({ key: '', page: 1 });
  const [refresh, setRefresh] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [countTarget, setCountTarget] = useState<CountTarget | null>(null);
  const [outboundTarget, setOutboundTarget] = useState<WarehouseOutboundOrder | null>(null);
  const [outboundStage, setOutboundStage] = useState('');
  const [lastShipment, setLastShipment] = useState<string | null>(null);
  const [movement, setMovement] = useState<MovementFilters>(emptyMovementFilters);
  const search = query.trim().slice(0, 160).toLocaleLowerCase();
  const showingMovements = tab === 'movements' && canReadMovements;
  const serverPages = tab === 'outbound' || tab === 'counts' || showingMovements;
  const badMovementRange = showingMovements && Boolean(movement.from && movement.through && movement.from > movement.through);
  const pageKey = JSON.stringify([tab, warehouseId, search, tab === 'outbound' ? outboundStage : '', showingMovements ? movement : null]);
  const page = cursor.key === pageKey ? cursor.page : 1;
  const params = new URLSearchParams({ kind: tab, page: String(page) });
  if (warehouseId) params.set('warehouse', warehouseId);
  if (search) params.set('q', search);
  if (tab === 'outbound' && outboundStage) params.set('stage', outboundStage);
  if (showingMovements) {
    if (movement.sku) params.set('sku', movement.sku.id);
    if (movement.type) params.set('movement', movement.type);
    if (movement.from) params.set('from', movement.from);
    if (movement.through) params.set('through', movement.through);
  }
  const ops = useWarehouseRead<WarehousePage>(serverPages && !badMovementRange ? `/api/warehouse?${params}` : null, refresh);
  const warehouses = workspace?.warehouses ?? [];
  const awaiting = (workspace?.purchaseOrders ?? []).filter((order) => (
    (order.status === 'issued' || order.status === 'partially_received') && order.orderedQuantity > order.receivedQuantity
  ));
  const pendingQty = awaiting.reduce((sum, order) => sum + order.orderedQuantity - order.receivedQuantity, 0);
  const matches = (...values: Array<string | undefined | null>) => !search || values.some((value) => value?.toLocaleLowerCase().includes(search));
  const includesWarehouse = (id: string | undefined) => !warehouseId || warehouseId === id;
  const visibleInbound = awaiting.filter((order) => includesWarehouse(order.deliveryWarehouse?.id) && matches(
    order.orderNo, order.deliveryWarehouse?.name, order.deliveryWarehouse?.code, order.supplier?.name,
    ...order.lines.flatMap((line) => [line.skuCode, line.skuName]),
  ));
  const visibleReceipts = (workspace?.purchaseReceipts ?? []).filter((receipt) => includesWarehouse(receipt.warehouse.id) && matches(
    receipt.receiptNo, receipt.purchaseOrderNo, receipt.warehouse.name, receipt.warehouse.code,
    ...receipt.lines.flatMap((line) => [line.skuCode, line.skuName]),
  ));
  const visibleStock = inventory.filter((balance) => includesWarehouse(balance.warehouseId)
    && matches(balance.skuCode, balance.skuName, balance.warehouseName));
  const localRows = tab === 'inbound' ? visibleInbound.length : tab === 'receipts' ? visibleReceipts.length
    : tab === 'stock' ? visibleStock.length : 0;
  const lastLocalPage = Math.max(1, Math.ceil(localRows / pageSize));
  const shownPage = serverPages ? page : Math.min(page, lastLocalPage);
  const start = (shownPage - 1) * pageSize;
  const pageRows = <T,>(rows: T[]) => rows.slice(start, start + pageSize);
  const empty = search || warehouseId ? '没有符合条件的记录' : null;
  const sourceLabel = workspace && !workspace.readOnly ? null : '仓库和收货数据暂未读取成功。';

  async function refreshWorkspace() {
    setRefreshing(true);
    try { await onRefresh(); } finally {
      setRefresh((current) => current + 1);
      setRefreshing(false);
    }
  }

  return <div className={`content module-content ${styles.workbench}`}>
    <header className={`module-head ${styles.heading}`}>
      <h1>仓库作业</h1>
      <div className={styles.actions}>
        <button type="button" className="secondary-button" onClick={() => { void refreshWorkspace(); }} disabled={Boolean(busy) || refreshing}>{refreshing ? '刷新中…' : '刷新数据'}</button>
        {canManage && <button type="button" className="secondary-button" disabled={Boolean(busy)} onClick={onCreateWarehouse}>新增仓库</button>}
        {canManage && <button type="button" className="primary-button" disabled={Boolean(busy) || !warehouses.length} onClick={() => setCountTarget({ warehouseId, sku: null })}>登记盘点</button>}
      </div>
    </header>
    {tab === 'outbound' && lastShipment && <div className={styles.shipmentNotice} role="status">
      <span>{lastShipment} 已确认发货。</span>
      {onOpenLogistics && <button type="button" className="link-button" onClick={() => onOpenLogistics(lastShipment)}>去登记运单</button>}
    </div>}
    <dl className={styles.metrics} aria-label="仓库汇总">
      <div><dt>待收采购单</dt><dd>{sourceLabel ? '待核' : amount(awaiting.length)}</dd></div>
      <div><dt>剩余待收件数</dt><dd>{sourceLabel ? '待核' : amount(pendingQty)}</dd></div>
      <div><dt>已登记入库批次</dt><dd>{sourceLabel ? '待核' : amount(workspace?.procurementSummary.receiptCount ?? null)}</dd></div>
      <div><dt>ERP 仓库</dt><dd>{sourceLabel ? '待核' : amount(warehouses.length)}</dd></div>
    </dl>
    <section className="card data-card" aria-label="仓库明细">
      <nav className={styles.tabs} aria-label="仓库作业项目">
        {tabs.filter((item) => item.id !== 'movements' || canReadMovements).map((item) =>
          <button key={item.id} type="button" aria-pressed={tab === item.id} onClick={() => { setTab(item.id); setCursor({ key: '', page: 1 }); }}>{item.label}</button>)}
      </nav>
      <div className={styles.filters}>
        <label>仓库<select value={warehouseId} onChange={(event) => { setWarehouseId(event.target.value); setCursor({ key: '', page: 1 }); }}>
          <option value="">全部 ERP 仓库</option>
          {warehouses.map((warehouse) => <option key={warehouse.id} value={warehouse.id}>{warehouse.code} · {warehouse.name}</option>)}
        </select></label>
        {tab === 'outbound' && <label>作业阶段<select value={outboundStage} onChange={(event) => setOutboundStage(event.target.value)}>
          <option value="">全部阶段</option>{outboundStages.map((label, version) => <option key={label} value={version}>{label}</option>)}
        </select></label>}
        {showingMovements && <>
          <label>变动类型<select value={movement.type} onChange={(event) => setMovement({ ...movement, type: event.target.value as MovementFilters['type'] })}>
            <option value="">全部类型</option>{Object.entries(movementLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
          </select></label>
          <label>开始日期<input type="date" value={movement.from} max={movement.through || undefined}
            onChange={(event) => setMovement({ ...movement, from: event.target.value })} /></label>
          <label>结束日期<input type="date" value={movement.through} min={movement.from || undefined}
            onChange={(event) => setMovement({ ...movement, through: event.target.value })} /></label>
          {movement.sku && <button type="button" className="secondary-button" aria-label={`清除 SKU ${movement.sku.code} 筛选`}
            onClick={() => setMovement({ ...movement, sku: null })}>{movement.sku.code} ×</button>}
        </>}
        {tab === 'receipts' && workspace && workspace.procurementSummary.receiptCount > workspace.purchaseReceipts.length && <span>显示最近载入的 {workspace.purchaseReceipts.length} 批</span>}
      </div>
      {['inbound', 'receipts'].includes(tab) && sourceLabel && <p className={styles.feedback} role="status">{sourceLabel}</p>}
      {serverPages && ops?.error && <p className={styles.feedback} role="alert">{ops.error}</p>}
      {badMovementRange && <p className={styles.feedback} role="alert">结束日期不能早于开始日期。</p>}

      {tab === 'inbound' && <WarehouseTable columns={['采购单', '供应商', '收货仓', '预计到货', '采购 / 已到 / 待收', '状态', '操作']} numericColumns={[5]} count={visibleInbound.length} empty={empty ?? sourceLabel ?? '暂无待收采购单'}>
        {pageRows(visibleInbound).map((order) => <tr key={order.id}>
          <td><strong>{order.orderNo}</strong></td><td>{order.supplier?.name ?? '—'}</td>
          <td>{order.deliveryWarehouse?.name ?? '未设收货仓'}</td><td>{order.expectedDeliveryAt ?? '待确认'}</td>
          <td className={styles.quantity}>{amount(order.orderedQuantity)} / {amount(order.receivedQuantity)} / <strong>{amount(order.orderedQuantity - order.receivedQuantity)}</strong></td>
          <td><span className={`status-pill purchase-order-status-${order.status}`}>{order.status === 'issued' ? '待收货' : '部分到货'}</span></td>
          <td><div className="row-actions">
            {order.deliveryWarehouse && (canReceive || canRequireQuality) && <ErpPurchaseQuality order={order}
              canRequire={canRequireQuality} canInspect={canReceive} disabled={Boolean(busy)} />}
            {canReceive && order.deliveryWarehouse && order.lines.some((line) => line.remainingQuantity > 0)
              ? <button type="button" className="action-primary" disabled={Boolean(busy)} onClick={() => onReceive(order)}>登记到货</button>
              : <span className="terminal-label">{order.deliveryWarehouse ? '—' : '需核对采购单收货仓'}</span>}
          </div></td>
        </tr>)}
      </WarehouseTable>}

      {tab === 'outbound' && <OutboundTable rows={ops?.data?.kind === 'outbound' ? ops.data.rows : []} canShip={canShip} busy={busy}
        empty={ops?.error ? '请刷新后重试' : !ops?.data ? '正在读取待出库订单…' : empty ?? (outboundStage ? '当前阶段暂无待出库订单' : '暂无已预占的待出库订单')}
        onOpen={setOutboundTarget} />}

      {tab === 'receipts' && <WarehouseTable columns={['入库单', '采购单', '仓库 / SKU', '原收', '已冲正', '净入库', '收货时间', '操作']} numericColumns={[4, 5, 6]} count={visibleReceipts.length} empty={empty ?? sourceLabel ?? '暂无入库流水'}>
        {pageRows(visibleReceipts).map((receipt) => {
          const original = receipt.originalQuantity ?? receipt.totalQuantity;
          const corrected = receipt.correctedQuantity ?? 0;
          const net = receipt.netQuantity ?? (original - corrected);
          return <tr key={receipt.id}>
            <td><strong>{receipt.receiptNo}</strong></td><td>{receipt.purchaseOrderNo}</td>
            <td>{receipt.warehouse.name}<small className="cell-sub">{receipt.lines.slice(0, 2).map((line) => line.skuCode).join('、')}{receipt.lines.length > 2 && ` 等 ${receipt.lines.length} 项`}</small></td>
            <td className={styles.quantity}>{amount(original)}</td><td className={styles.quantity}>{amount(corrected)}</td>
            <td className={styles.quantity}><strong>{amount(net)}</strong></td><td>{displayTime(receipt.receivedAt)}</td>
            <td>{canReceive && net > 0 ? <div className="row-actions"><button type="button" disabled={Boolean(busy)} onClick={() => { void onCorrect(receipt); }}>冲正错录</button></div> : '—'}</td>
          </tr>;
        })}
      </WarehouseTable>}

      {tab === 'stock' && <WarehouseTable columns={['SKU / 商品', 'ERP 仓库', '现存', '预占', '可用', '更新时间', '操作']} numericColumns={[3, 4, 5]} count={visibleStock.length} empty={empty ?? '当前工作区没有库存余额，可通过采购入库或实盘登记建立库存'}>
        {pageRows(visibleStock).map((balance) => <tr key={balance.id}>
          <td><strong>{balance.skuCode}</strong><small className="cell-sub">{balance.skuName}</small></td><td>{balance.warehouseName}</td>
          <td className={styles.quantity}>{amount(balance.onHandQty)}</td><td className={styles.quantity}>{amount(balance.reservedQty)}</td>
          <td className={styles.quantity}><strong>{amount(balance.availableQty)}</strong></td><td>{displayTime(balance.updatedAt)}</td>
          <td>{canManage || canReadMovements ? <div className="row-actions">
            {canReadMovements && <button type="button" onClick={() => {
              setWarehouseId(balance.warehouseId);
              setMovement({ ...emptyMovementFilters, sku: { id: balance.skuId, code: balance.skuCode } });
              setTab('movements');
              setCursor({ key: '', page: 1 });
            }}>查看流水</button>}
            {canManage && <button type="button" disabled={Boolean(busy)} onClick={() => setCountTarget({ warehouseId: balance.warehouseId, sku: { id: balance.skuId, code: balance.skuCode, name: balance.skuName } })}>盘点此 SKU</button>}
          </div> : '—'}</td>
        </tr>)}
      </WarehouseTable>}

      {tab === 'counts' && <StockCountTable rows={ops?.data?.kind === 'counts' ? ops.data.rows : []}
        empty={ops?.error ? '请刷新后重试' : !ops?.data ? '正在读取盘点记录…' : empty ?? '暂无实盘记录'} />}

      {showingMovements && <StockMovementTable rows={ops?.data?.kind === 'movements' ? ops.data.rows : []}
        empty={badMovementRange ? '请核对日期范围' : ops?.error ? '请刷新后重试' : !ops?.data ? '正在读取库存流水…'
          : empty ?? (movement.sku || movement.type || movement.from || movement.through ? '没有符合条件的库存流水' : '暂无库存流水')} />}

      <div className={`pagination ${styles.pagination}`}>
        <span>{serverPages ? `第 ${shownPage} 页` : `第 ${shownPage} / ${lastLocalPage} 页 · ${amount(localRows)} 条记录`}</span>
        <div><button type="button" aria-label="上一页" disabled={shownPage === 1} onClick={() => setCursor({ key: pageKey, page: shownPage - 1 })}>‹</button>
          <button type="button" aria-label="下一页" disabled={serverPages ? !ops?.data?.hasNext : shownPage >= lastLocalPage} onClick={() => setCursor({ key: pageKey, page: shownPage + 1 })}>›</button></div>
      </div>
    </section>
    {countTarget && <StockCountDialog target={countTarget} warehouses={warehouses} inventory={inventory}
      onClose={() => setCountTarget(null)} onRefresh={refreshWorkspace} onRecorded={async (recordedWarehouseId) => {
        setCountTarget(null); setWarehouseId(recordedWarehouseId); setTab('counts'); setCursor({ key: '', page: 1 }); await refreshWorkspace();
      }} />}
    {outboundTarget && <WarehouseOutboundOperation key={outboundTarget.id} order={outboundTarget}
      onClose={() => setOutboundTarget(null)} onChanged={() => setRefresh((current) => current + 1)}
      onShip={async (order) => {
        const shipped = await onShip(order);
        if (shipped) {
          setLastShipment(order.orderNo);
          setRefresh((current) => current + 1);
        }
        return shipped;
      }} />}
  </div>;
}

function WarehouseTable({ columns, numericColumns, count, empty, children }: {
  columns: string[]; numericColumns: number[]; count: number; empty: string; children: ReactNode;
}) {
  return <div className={`table-wrap module-table ${styles.table}`}><table>
    <thead><tr>{columns.map((column, index) => <th key={column} scope="col" className={numericColumns.includes(index + 1) ? styles.quantity : undefined}>{column}</th>)}</tr></thead>
    <tbody>{count ? children : <tr><td className="empty-cell" colSpan={columns.length}>{empty}</td></tr>}</tbody>
  </table></div>;
}

function OutboundTable({ rows, canShip, busy, empty, onOpen }: {
  rows: WarehouseOutboundOrder[]; canShip: boolean; busy: string; empty: string;
  onOpen: (row: WarehouseOutboundOrder) => void;
}) {
  return <WarehouseTable columns={['运营订单', 'SKU / 商品', '出库仓', '预占件数', '作业阶段', '预占时间', '操作']} numericColumns={[4]} count={rows.length} empty={empty}>
    {rows.map((row) => <tr key={row.id}>
      <td><strong>{row.orderNo}</strong></td><td>{row.skuCode}<small className="cell-sub">{row.skuName}</small></td>
      <td>{row.warehouseName}</td><td className={styles.quantity}>{amount(row.quantity)}</td>
      <td><span className={`ops-state${row.outboundVersion === 3 ? ' ops-state-info' : ''}`}>{outboundStages[row.outboundVersion]}</span>
        {row.packedPackageCount !== null && <small className="cell-sub">{amount(row.packedPackageCount)} 箱</small>}</td><td>{displayTime(row.reservedAt)}</td>
      <td>{canShip ? <div className="row-actions"><button type="button" className="action-primary" disabled={Boolean(busy)} onClick={() => onOpen(row)}>出库作业</button></div> : '—'}</td>
    </tr>)}
  </WarehouseTable>;
}

function StockCountTable({ rows, empty }: { rows: WarehouseStockCount[]; empty: string }) {
  return <WarehouseTable columns={['SKU / 商品', 'ERP 仓库', '原现存', '实盘', '差异', '预占', '盘点原因', '登记时间']} numericColumns={[3, 4, 5, 6]} count={rows.length} empty={empty}>
    {rows.map((row) => <tr key={row.id}>
      <td><strong>{row.skuCode}</strong><small className="cell-sub">{row.skuName}</small></td><td>{row.warehouseName}</td>
      <td className={styles.quantity}>{amount(row.beforeOnHandQty)}</td><td className={styles.quantity}><strong>{amount(row.countedQty)}</strong></td>
      <td className={styles.quantity}>{row.countedQty > row.beforeOnHandQty && '+'}{amount(row.countedQty - row.beforeOnHandQty)}</td>
      <td className={styles.quantity}>{amount(row.reservedQty)}</td>
      <td>{row.reason}</td><td>{displayTime(row.createdAt)}</td>
    </tr>)}
  </WarehouseTable>;
}

function StockMovementTable({ rows, empty }: { rows: WarehouseMovement[]; empty: string }) {
  const signed = (value: number) => `${value > 0 ? '+' : ''}${amount(value)}`;
  return <WarehouseTable columns={['时间（北京时间）', '变动类型', 'SKU / 商品', '仓库', '现存变动', '预占变动', '可用变动', '业务凭证', '经办人 / 原因']}
    numericColumns={[5, 6, 7]} count={rows.length} empty={empty}>
    {rows.map((row) => <tr key={`${row.type}:${row.id}`}>
      <td><time dateTime={row.createdAt}>{displayMovementTime(row.createdAt)}</time></td>
      <td><span className="ops-state">{movementLabels[row.type]}</span></td>
      <td><strong>{row.skuCode}</strong><small className="cell-sub">{row.skuName}</small></td><td>{row.warehouseName}</td>
      <td className={styles.quantity}>{signed(row.onHandDelta)}
        {row.beforeOnHandQty !== null && <small className="cell-sub">{amount(row.beforeOnHandQty)} → {amount(row.afterOnHandQty)}</small>}</td>
      <td className={styles.quantity}>{signed(row.reservedDelta)}</td><td className={styles.quantity}>{signed(row.onHandDelta - row.reservedDelta)}</td>
      <td className={styles.movementProof}><strong>{row.reference}</strong>
        {row.purchaseOrderNo && <small className="cell-sub">采购单 {row.purchaseOrderNo}</small>}
        {row.originalReceiptNo && <small className="cell-sub">原入库单 {row.originalReceiptNo}</small>}</td>
      <td className={styles.movementProof}>{row.actor ?? '—'}{row.reason && <small className="cell-sub">{row.reason}</small>}</td>
    </tr>)}
  </WarehouseTable>;
}

type CountAttempt = {
  key: string;
  body: { warehouseId: string; skuId: string; countedQty: number; reason: string; expectedVersion: number };
};

function StockCountDialog({ target, warehouses, inventory, onClose, onRefresh, onRecorded }: {
  target: CountTarget; warehouses: Warehouse[]; inventory: Balance[];
  onClose: () => void; onRefresh: () => Promise<void>; onRecorded: (warehouseId: string) => Promise<void>;
}) {
  const [warehouseId, setWarehouseId] = useState(target.warehouseId);
  const [sku, setSku] = useState(target.sku);
  const [skuQuery, setSkuQuery] = useState('');
  const [rawQty, setRawQty] = useState('');
  const [reason, setReason] = useState('');
  const [attempt, setAttempt] = useState<CountAttempt | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState('');
  const submitLock = useRef(false);
  const search = skuQuery.trim();
  const options = useWarehouseRead<{ ok: true; skus: Sku[] }>(search ? `/api/warehouse/skus?${new URLSearchParams({ q: search })}` : null);
  const selectedBalance = inventory.find((balance) => balance.skuId === sku?.id && balance.warehouseId === warehouseId);
  const reserved = selectedBalance?.reservedQty ?? 0;
  const onHand = selectedBalance?.onHandQty ?? 0;
  const counted = rawQty === '' ? null : Number(rawQty);
  const formReady = Boolean(sku && warehouseId && counted !== null && Number.isInteger(counted)
    && counted >= reserved && counted <= 2_147_483_647 && reason.trim() && !stale);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitLock.current) return;
    let current = attempt;
    if (!current) {
      if (!formReady || !sku || counted === null) return;
      current = { key: crypto.randomUUID(), body: {
        warehouseId, skuId: sku.id, countedQty: counted, reason: reason.trim(), expectedVersion: selectedBalance?.version ?? 0,
      } };
    }
    submitLock.current = true;
    setSubmitting(true);
    setAttempt(current);
    setError('');
    try {
      const response = await fetch('/api/warehouse', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': current.key },
        body: JSON.stringify(current.body),
      });
      const result = await response.json().catch(() => null) as { ok?: boolean; code?: string; message?: string } | null;
      if (!response.ok && response.status < 500 && result?.code) {
        setStale(result.code === 'WAREHOUSE_STOCK_COUNT_VERSION_CONFLICT');
        setAttempt(null);
        setError(result.message ?? '盘点登记失败');
        return;
      }
      if (!response.ok || result?.ok !== true) throw new Error('盘点提交结果待确认');
      await onRecorded(current.body.warehouseId);
    } catch {
      setError('盘点提交结果待确认，请重试原提交以核对，系统会按同一操作去重。');
    } finally {
      submitLock.current = false;
      setSubmitting(false);
    }
  }

  async function refreshBalance() {
    setRefreshing(true);
    try {
      await onRefresh();
      setRawQty('');
      setStale(false);
      setError('');
    } finally {
      setRefreshing(false);
    }
  }

  return <div className="modal-backdrop"><form className={`modal ${styles.countDialog}`} onSubmit={submit}
    role="dialog" aria-modal="true" aria-labelledby="warehouse-count-title" onKeyDown={(event) => {
      if (event.key === 'Escape' && !submitting) onClose();
    }}>
    <header className="modal-head">
      <div><h2 id="warehouse-count-title">登记库存盘点</h2><p>按单个仓库与 SKU 填写实际清点数量</p></div>
      <button type="button" disabled={submitting} onClick={onClose} aria-label="关闭盘点表单">×</button>
    </header>
    <fieldset className={`form-grid ${styles.countFields}`} disabled={submitting || Boolean(attempt) || refreshing}>
      <label>仓库<select required value={warehouseId} onChange={(event) => { setWarehouseId(event.target.value); setRawQty(''); }}>
        <option value="">请选择仓库</option>{warehouses.map((warehouse) => <option key={warehouse.id} value={warehouse.id}>{warehouse.code} · {warehouse.name}</option>)}
      </select></label>
      <label>搜索 ERP SKU<input value={skuQuery} onChange={(event) => setSkuQuery(event.target.value)} maxLength={160} placeholder="输入编码或商品名" /></label>
      {(search || sku) && <div className={styles.skuOptions} aria-label="ERP SKU 候选">
        {sku && <span>已选 {sku.code} · {sku.name}</span>}
        {search && <>
          {!options && <span>正在搜索 SKU…</span>}
          {options?.error && <span role="alert">{options.error}</span>}
          {options?.data?.skus.length === 0 && <span>未找到现有 SKU，请先在采购管理建档。</span>}
          {options?.data?.skus.map((item) => <button type="button" key={item.id} onClick={() => { setSku(item); setSkuQuery(''); setRawQty(''); }}>{item.code} · {item.name}</button>)}
        </>}
      </div>}
      <label>实际清点件数<input type="number" inputMode="numeric" min={reserved} max={2_147_483_647} step="1" required value={rawQty} onChange={(event) => setRawQty(event.target.value)} /></label>
      <div className={styles.countSummary} aria-live="polite">
        {warehouseId && sku ? <>
          <span>{selectedBalance ? `ERP 现存 ${amount(onHand)} · 预占 ${amount(reserved)}` : '首次盘点将建立此仓的 ERP 库存记录'}</span>
          {counted !== null && Number.isInteger(counted) && <span>实盘差异 {counted > onHand && '+'}{amount(counted - onHand)} 件</span>}
        </> : <span>先选择仓库和 SKU</span>}
      </div>
      <label className="full">盘点原因<textarea value={reason} onChange={(event) => setReason(event.target.value)} required rows={3} maxLength={500} /></label>
    </fieldset>
    {error && <p className={styles.feedback} role="alert">{error}</p>}
    <div className="modal-actions">
      <button type="button" onClick={onClose} disabled={submitting}>关闭</button>
      {stale && <button type="button" disabled={refreshing} onClick={() => { void refreshBalance(); }}>{refreshing ? '刷新中…' : '刷新后重盘'}</button>}
      <button className="primary-button" type="submit" disabled={submitting || refreshing || (!attempt && !formReady)}>
        {submitting ? '正在登记…' : attempt ? '重试原提交' : '确认登记并更新库存'}
      </button>
    </div>
  </form></div>;
}
