'use client';

import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';

type ModuleKey = 'dashboard' | 'orders' | 'inventory' | 'purchase' | 'warehouse' | 'logistics' | 'finance' | 'reports';
type OrderStatus = 'pending_review' | 'reserved' | 'shipped' | 'cancelled';
type OrderAction = 'approve' | 'ship' | 'cancel';
type Permission = 'orders:read' | 'orders:create' | 'orders:approve' | 'orders:ship' | 'orders:cancel' | 'audit:read';

type ErpOrder = {
  id: string; orderNo: string; channel: string; destination: string; customerName: string;
  currency: string; amountMinor: number; status: OrderStatus; skuId: string; skuCode: string;
  skuName: string; warehouseId: string; warehouseName: string; quantity: number;
  version: number; createdAt: string; updatedAt: string;
};

type Inventory = {
  id: string; skuId: string; skuCode: string; skuName: string; warehouseId: string;
  warehouseName: string; onHandQty: number; reservedQty: number; availableQty: number;
  version: number; updatedAt: string;
};

type ErpPayload = {
  ok: true;
  user: { displayName: string; email: string; role: 'admin' | 'operator' | 'viewer'; permissions: Permission[]; tenantName: string };
  orders: ErpOrder[];
  inventory: Inventory[];
  audit: { action: string; entity_id: string; actor_email: string; before_json: string | null; after_json: string | null; created_at: string }[];
  summary: { totalOrders: number; pendingReview: number; readyToShip: number; shipped: number; lowStock: number; totalAvailable: number };
};

const nav: { key: ModuleKey; label: string; code: string }[] = [
  { key: 'dashboard', label: '工作台', code: '01' },
  { key: 'orders', label: '订单管理', code: '02' },
  { key: 'inventory', label: '商品库存', code: '03' },
  { key: 'purchase', label: '采购管理', code: '04' },
  { key: 'warehouse', label: '仓库作业', code: '05' },
  { key: 'logistics', label: '物流管理', code: '06' },
  { key: 'finance', label: '财务管理', code: '07' },
  { key: 'reports', label: '数据报表', code: '08' },
];

const statusLabel: Record<OrderStatus, string> = {
  pending_review: '待审核', reserved: '待发货', shipped: '已发货', cancelled: '已取消',
};

const actionLabel: Record<string, string> = {
  CREATE_ORDER: '创建订单', APPROVE_ORDER: '审核并预占', SHIP_ORDER: '确认发货', CANCEL_ORDER: '取消订单',
};

const demoModules: Record<Exclude<ModuleKey, 'dashboard' | 'orders' | 'inventory'>, {
  title: string; desc: string; stats: string[][]; columns: string[]; rows: string[][];
}> = {
  purchase: { title: '采购管理', desc: '下一闭环：采购计划、供应商下单与到货入库', stats: [['本月采购额','¥1,862,400','演示口径'],['待审核','14','演示数据'],['在途采购','36','演示数据'],['准时交付率','94.6%','演示数据']], columns: ['采购单号','供应商','数量','预计到货','状态'], rows: [['PO260901-0288','安吉森木家居','240','2026-09-08','待审核'],['PO260831-0279','佛山众创建材','680','2026-09-05','生产中']] },
  warehouse: { title: '仓库作业', desc: '下一闭环：入库、拣货、复核、装箱与盘点', stats: [['今日出库','1,526 单','演示口径'],['待拣货','286 单','演示数据'],['待入库','8,642 件','演示数据'],['准确率','99.72%','演示数据']], columns: ['作业单号','作业类型','仓库','数量','状态'], rows: [['WH260901-1068','订单出库','美西仓','624 件','拣货中'],['WH260901-1054','采购入库','美东仓','1,860 件','质检中']] },
  logistics: { title: '物流管理', desc: '下一闭环：面单、承运商、物流轨迹与异常处理', stats: [['在途包裹','4,286','演示口径'],['今日揽收','1,204','演示数据'],['物流异常','38','演示数据'],['平均妥投','4.8 天','演示数据']], columns: ['运单号','承运商','线路','发货仓','状态'], rows: [['YT260901882146','燕文物流','美国专线','深圳仓','运输中'],['DHL-9836254108','DHL','德国特快','德国仓','派送中']] },
  finance: { title: '财务管理', desc: '下一闭环：平台结算、多币种、费用与对账', stats: [['本月收入','¥8,624,300','演示口径'],['本月支出','¥5,148,600','演示数据'],['预估毛利','¥3,475,700','演示数据'],['待对账','¥286,420','演示数据']], columns: ['流水号','业务类型','关联单号','原币金额','状态'], rows: [['FN260901-6428','平台回款','AMZ-US-0831','USD 25,820.00','已入账'],['FN260901-6412','物流费用','LG-0831-882','CNY 28,640.00','待审核']] },
  reports: { title: '数据报表', desc: '下一闭环：基于可信业务明细生成统一口径报表', stats: [['销售额','¥8,624,300','演示口径'],['订单量','48,216','演示数据'],['客单价','¥178.86','演示数据'],['净利润率','18.4%','演示数据']], columns: ['报表名称','类型','周期','范围','状态'], rows: [['8 月全渠道经营月报','经营分析','月度','全部渠道','已生成'],['海外仓库存健康度','库存分析','每周','5 个海外仓','已生成']] },
};

export default function ErpClient() {
  const [active, setActive] = useState<ModuleKey>('dashboard');
  const [payload, setPayload] = useState<ErpPayload | null>(null);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [authRequired, setAuthRequired] = useState(false);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [showOrder, setShowOrder] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [actionBusy, setActionBusy] = useState('');

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/erp', { cache: 'no-store' });
      const body = await response.json() as ErpPayload | { message?: string };
      if (response.status === 401) { setAuthRequired(true); return; }
      if (!response.ok || !('ok' in body) || body.ok !== true) throw new Error('message' in body ? body.message : '业务数据加载失败');
      setPayload(body);
      setAuthRequired(false);
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '业务数据加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => { void loadData(); }, 0);
    return () => window.clearTimeout(timer);
  }, [loadData]);

  const can = useCallback((permission: Permission) => payload?.user.permissions.includes(permission) ?? false, [payload]);
  const filteredOrders = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return payload?.orders ?? [];
    return (payload?.orders ?? []).filter((order) => [order.orderNo, order.channel, order.destination, order.customerName, order.skuCode, order.skuName, order.warehouseName, statusLabel[order.status]].some((value) => value.toLowerCase().includes(term)));
  }, [payload, query]);
  const filteredInventory = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return payload?.inventory ?? [];
    return (payload?.inventory ?? []).filter((item) => [item.skuCode, item.skuName, item.warehouseName].some((value) => value.toLowerCase().includes(term)));
  }, [payload, query]);

  function switchModule(key: ModuleKey) { setActive(key); setQuery(''); }
  function flash(message: string) { setToast(message); window.setTimeout(() => setToast(''), 2800); }

  async function submitOrder(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const inventory = payload?.inventory.find((item) => item.id === data.get('inventory'));
    if (!inventory) { setError('请选择有效的 SKU 和仓库'); return; }
    setSubmitting(true); setError('');
    try {
      const response = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({
          channel: data.get('channel'), destination: data.get('destination'), customerName: data.get('customer'),
          currency: data.get('currency'), amountMinor: Math.round(Number(data.get('amount')) * 100),
          skuId: inventory.skuId, warehouseId: inventory.warehouseId, quantity: Number(data.get('quantity')),
        }),
      });
      const body = await response.json() as { message?: string };
      if (!response.ok) throw new Error(body.message ?? '订单创建失败');
      form.reset(); setShowOrder(false); setActive('orders'); await loadData();
      flash('订单已持久化保存，并进入待审核队列');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '订单创建失败');
    } finally { setSubmitting(false); }
  }

  async function runAction(order: ErpOrder, action: OrderAction) {
    const message = action === 'approve'
      ? `将为 ${order.orderNo} 在${order.warehouseName}预占 ${order.quantity} 件 ${order.skuCode}，确认审核？`
      : action === 'ship'
        ? `将扣减 ${order.quantity} 件现存库存并写入不可变出库流水，确认发货？`
        : `将取消 ${order.orderNo} 并释放已预占库存（如有）。订单和历史不会被删除，确认继续？`;
    if (!window.confirm(message)) return;
    setActionBusy(`${order.id}:${action}`); setError('');
    try {
      const response = await fetch(`/api/orders/${order.id}/actions`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() },
        body: JSON.stringify({ action }),
      });
      const body = await response.json() as { message?: string };
      if (!response.ok) throw new Error(body.message ?? '订单操作失败');
      await loadData();
      flash(action === 'approve' ? '审核完成，库存已预占' : action === 'ship' ? '发货完成，库存流水已更新' : '订单已取消，历史记录已保留');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '订单操作失败');
    } finally { setActionBusy(''); }
  }

  const activeLabel = nav.find((item) => item.key === active)?.label ?? '工作台';
  const displayName = payload?.user.displayName || '未登录';
  const initials = displayName.slice(0, 2).toUpperCase();

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <button className="brand" onClick={() => switchModule('dashboard')}><span className="brand-mark">易</span><span>易仓 ERP</span></button>
        <div className="pilot-tag"><span />订单库存闭环 · 试点版</div>
        <p className="nav-label">业务中心</p>
        <nav>{nav.map((item) => <button className={active === item.key ? 'nav-item active' : 'nav-item'} onClick={() => switchModule(item.key)} key={item.key}><span className="nav-icon">{item.code}</span>{item.label}{item.key === 'orders' && Boolean(payload?.summary.pendingReview) && <b>{payload?.summary.pendingReview}</b>}</button>)}</nav>
        <div className="sidebar-foot"><div className="help-icon">✓</div><div><strong>可信业务底座</strong><small>身份 · 幂等 · 审计 · 库存流水</small></div></div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div className="crumb"><span>{payload?.user.tenantName ?? '华东事业部'}</span><i>／</i><strong>{activeLabel}</strong></div>
          <div className="top-actions">
            <label className="search"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} aria-label="搜索当前模块" placeholder={active === 'dashboard' ? '切换模块后搜索业务数据' : `搜索${activeLabel}`} /></label>
            <div className="live-badge"><i />D1 持久化</div>
            <div className="avatar">{initials}</div><div className="user"><strong>{displayName}</strong><small>{payload?.user.role === 'admin' ? '系统管理员' : payload?.user.role === 'operator' ? '业务操作员' : '只读成员'}</small></div>
          </div>
        </header>

        {authRequired ? <AuthRequired /> : loading && !payload ? <LoadingState /> : payload ? (
          <>
            {error && <div className="inline-alert" role="alert"><span>!</span><p>{error}</p><button onClick={() => { setError(''); void loadData(); }}>重试</button></div>}
            {active === 'dashboard' && <Dashboard payload={payload} openOrder={() => setShowOrder(true)} go={switchModule} />}
            {active === 'orders' && <OrdersView orders={filteredOrders} summary={payload.summary} can={can} busy={actionBusy} openOrder={() => setShowOrder(true)} runAction={runAction} />}
            {active === 'inventory' && <InventoryView inventory={filteredInventory} summary={payload.summary} />}
            {!['dashboard','orders','inventory'].includes(active) && <DemoModule module={demoModules[active as keyof typeof demoModules]} />}
          </>
        ) : <LoadingState message={error || '暂时无法加载业务数据'} />}
      </section>

      {showOrder && payload && <OrderModal inventory={payload.inventory} submitting={submitting} error={error} onClose={() => { if (!submitting) { setShowOrder(false); setError(''); } }} onSubmit={submitOrder} />}
      {toast && <div className="toast"><span>✓</span>{toast}</div>}
    </main>
  );
}

function Dashboard({ payload, openOrder, go }: { payload: ErpPayload; openOrder: () => void; go: (key: ModuleKey) => void }) {
  const metrics = [
    ['系统订单', String(payload.summary.totalOrders), '已持久化保存', 'green'],
    ['待审核', String(payload.summary.pendingReview), '需审核后预占库存', 'orange'],
    ['待发货', String(payload.summary.readyToShip), '库存已锁定', 'blue'],
    ['低库存 SKU', String(payload.summary.lowStock), '可售量 ≤ 10', 'red'],
  ];
  return <div className="content"><div className="page-head"><div><p>{new Intl.DateTimeFormat('zh-CN', { dateStyle: 'full' }).format(new Date())}</p><h1>早上好，{payload.user.displayName}</h1><span>订单与库存已进入真实持久化闭环，关键动作由服务端校验。</span></div>{payload.user.permissions.includes('orders:create') && <button className="primary-button" onClick={openOrder}><span>＋</span> 新建订单</button>}</div>
    <section className="metrics" aria-label="核心业务指标">{metrics.map((metric) => <article className="metric-card" key={metric[0]}><div className={`metric-symbol ${metric[3]}`}>{metric[0].slice(0,1)}</div><p>{metric[0]}</p><h2>{metric[1]}</h2><span className={metric[3] === 'red' ? 'negative' : ''}>{metric[2]}</span></article>)}</section>
    <div className="dashboard-grid"><article className="card workflow-card"><div className="card-head"><div><h3>首个可信业务闭环</h3><p>所有状态变化均经过权限、状态机与数据库约束</p></div><button className="link-button" onClick={() => go('orders')}>进入订单中心 →</button></div><div className="workflow-line"><div className="flow-step active"><b>01</b><span><strong>创建订单</strong><small>幂等保存</small></span></div><i>→</i><div className="flow-step"><b>02</b><span><strong>审核预占</strong><small>校验可售库存</small></span></div><i>→</i><div className="flow-step"><b>03</b><span><strong>确认发货</strong><small>扣减现存与预占</small></span></div><i>→</i><div className="flow-step"><b>04</b><span><strong>审计追溯</strong><small>保留前后状态</small></span></div></div><div className="guardrails"><span>服务端身份</span><span>乐观锁</span><span>库存触发器</span><span>不可变流水</span><span>无物理删除</span></div></article>
      <article className="card audit-card"><div className="card-head"><div><h3>最近审计</h3><p>创建、审核、发货与取消均自动留痕</p></div><span className="audit-lock">追加写</span></div><div className="audit-list">{payload.audit.slice(0, 4).map((item, index) => <div className="audit-item" key={`${item.entity_id}-${item.created_at}-${index}`}><span className="audit-dot" /><div><strong>{actionLabel[item.action] ?? item.action}</strong><small>{item.actor_email} · {formatTime(item.created_at)}</small></div></div>)}{!payload.audit.length && <p className="empty-note">当前账号无审计查看权限</p>}</div></article></div>
    <article className="card orders-card"><div className="card-head"><div><h3>最新系统订单</h3><p>来自持久化业务数据库，不再使用浏览器内存</p></div><button className="link-button" onClick={() => go('orders')}>查看全部 →</button></div><OrderTable orders={payload.orders.slice(0, 4)} compact /></article>
  </div>;
}

function OrdersView({ orders, summary, can, busy, openOrder, runAction }: { orders: ErpOrder[]; summary: ErpPayload['summary']; can: (permission: Permission) => boolean; busy: string; openOrder: () => void; runAction: (order: ErpOrder, action: OrderAction) => void }) {
  const stats = [['全部订单', String(summary.totalOrders), '持久化记录'],['待审核', String(summary.pendingReview), '审核后锁定库存'],['待发货', String(summary.readyToShip), '已完成库存预占'],['已发货', String(summary.shipped), '已写出库流水']];
  return <div className="content module-content"><div className="module-head"><div><p>可信业务闭环 / 订单</p><h1>订单管理</h1><span>创建、审核、预占、发货、取消均由服务端状态机控制</span></div>{can('orders:create') && <button className="primary-button" onClick={openOrder}><span>＋</span> 新建订单</button>}</div><StatCards stats={stats} />
    <article className="card data-card"><div className="data-toolbar"><div><button className="tab-active">全部</button><button>待审核</button><button>待发货</button><button>已完成</button></div><span>共 {orders.length} 条当前权限范围记录</span></div><OrderTable orders={orders} can={can} busy={busy} runAction={runAction} /><div className="pagination"><span>数据刷新后仍会保留</span><div><button disabled>‹</button><button className="current">1</button><button disabled>›</button></div></div></article>
  </div>;
}

function OrderTable({ orders, compact = false, can, busy = '', runAction }: { orders: ErpOrder[]; compact?: boolean; can?: (permission: Permission) => boolean; busy?: string; runAction?: (order: ErpOrder, action: OrderAction) => void }) {
  return <div className="table-wrap module-table"><table><thead><tr><th>订单号</th><th>渠道 / 目的地</th><th>商品</th><th>仓库</th><th>数量</th><th>原币金额</th><th>状态</th>{!compact && <th>受控操作</th>}</tr></thead><tbody>{orders.length ? orders.map((order) => <tr key={order.id}><td><strong>{order.orderNo}</strong><small className="cell-sub">{order.customerName}</small></td><td>{order.channel}<small className="cell-sub">{order.destination}</small></td><td>{order.skuCode}<small className="cell-sub">{order.skuName}</small></td><td>{order.warehouseName}</td><td>{order.quantity}</td><td>{formatMoney(order.amountMinor, order.currency)}</td><td><Status status={order.status} /></td>{!compact && <td><div className="row-actions">{order.status === 'pending_review' && can?.('orders:approve') && <button disabled={Boolean(busy)} onClick={() => runAction?.(order, 'approve')}>{busy === `${order.id}:approve` ? '处理中…' : '审核预占'}</button>}{order.status === 'reserved' && can?.('orders:ship') && <button className="action-primary" disabled={Boolean(busy)} onClick={() => runAction?.(order, 'ship')}>{busy === `${order.id}:ship` ? '处理中…' : '确认发货'}</button>}{['pending_review','reserved'].includes(order.status) && can?.('orders:cancel') && <button className="action-muted" disabled={Boolean(busy)} onClick={() => runAction?.(order, 'cancel')}>取消</button>}{['shipped','cancelled'].includes(order.status) && <span className="terminal-label">终态已锁定</span>}</div></td>}</tr>) : <tr><td className="empty-cell" colSpan={compact ? 7 : 8}>当前没有匹配的订单</td></tr>}</tbody></table></div>;
}

function InventoryView({ inventory, summary }: { inventory: Inventory[]; summary: ErpPayload['summary'] }) {
  const totalOnHand = inventory.reduce((sum, item) => sum + item.onHandQty, 0);
  const totalReserved = inventory.reduce((sum, item) => sum + item.reservedQty, 0);
  const stats = [['库存记录', String(inventory.length), 'SKU × 仓库'],['现存数量', String(totalOnHand), '不可由页面直接修改'],['预占数量', String(totalReserved), '由订单状态机维护'],['可售数量', String(summary.totalAvailable), '现存－预占']];
  return <div className="content module-content"><div className="module-head"><div><p>可信业务闭环 / 库存</p><h1>商品库存</h1><span>余额由不可变流水和订单动作驱动，页面不提供直接改数入口</span></div><div className="ledger-chip">库存账本已启用</div></div><StatCards stats={stats} />
    <article className="card data-card"><div className="data-toolbar"><div><button className="tab-active">全部库存</button><button>库存预警</button></div><span>可售量 = 现存 − 预占</span></div><div className="table-wrap module-table"><table><thead><tr><th>SKU</th><th>商品名称</th><th>仓库</th><th>现存</th><th>预占</th><th>可售</th><th>库存状态</th><th>版本</th></tr></thead><tbody>{inventory.map((item) => <tr key={item.id}><td><strong>{item.skuCode}</strong></td><td>{item.skuName}</td><td>{item.warehouseName}</td><td>{item.onHandQty}</td><td>{item.reservedQty}</td><td><strong>{item.availableQty}</strong></td><td><InventoryStatus available={item.availableQty} /></td><td>v{item.version}</td></tr>)}</tbody></table></div><div className="pagination"><span>订单审核、取消和发货后自动更新</span><div><button disabled>‹</button><button className="current">1</button><button disabled>›</button></div></div></article>
  </div>;
}

function DemoModule({ module }: { module: (typeof demoModules)[keyof typeof demoModules] }) {
  return <div className="content module-content"><div className="module-head"><div><p>业务规划 / 下一开发阶段</p><h1>{module.title}</h1><span>{module.desc}</span></div><div className="demo-chip">演示数据 · 不参与业务记账</div></div><StatCards stats={module.stats} />
    <article className="card data-card"><div className="data-toolbar"><div><button className="tab-active">功能预览</button></div><span>该模块将在订单库存闭环验收后接入</span></div><div className="table-wrap module-table"><table><thead><tr>{module.columns.map((column) => <th key={column}>{column}</th>)}</tr></thead><tbody>{module.rows.map((row) => <tr key={row[0]}>{row.map((cell, index) => <td key={`${row[0]}-${index}`}>{index === 0 ? <strong>{cell}</strong> : /状态/.test(module.columns[index]) ? <span className="status-pill">{cell}</span> : cell}</td>)}</tr>)}</tbody></table></div><div className="planned-note"><b>开发闸门</b><span>当前真实数据只覆盖订单与库存；本模块不会误标为实时数据。</span></div></article>
  </div>;
}

function StatCards({ stats }: { stats: string[][] }) {
  return <section className="module-stats">{stats.map((stat, index) => <article key={stat[0]}><div className={`stat-dot tone-${index}`} /><p>{stat[0]}</p><h2>{stat[1]}</h2><span>{stat[2]}</span></article>)}</section>;
}

function OrderModal({ inventory, submitting, error, onClose, onSubmit }: { inventory: Inventory[]; submitting: boolean; error: string; onClose: () => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
  return <div className="modal-backdrop" onMouseDown={onClose}><form className="modal order-modal" onSubmit={onSubmit} onMouseDown={(event) => event.stopPropagation()}><div className="modal-head"><div><h2>新建销售订单</h2><p>订单先进入待审核；审核后才会预占库存</p></div><button type="button" onClick={onClose} disabled={submitting}>×</button></div><div className="form-grid"><label>销售渠道<select name="channel" required><option>Amazon US</option><option>Shopify</option><option>eBay DE</option><option>TikTok Shop</option></select></label><label>目的国家<select name="destination" required><option>美国</option><option>英国</option><option>德国</option><option>法国</option><option>加拿大</option></select></label><label className="full">客户名称<input name="customer" placeholder="请输入客户名称" required minLength={2} /></label><label className="full">SKU 与履约仓<select name="inventory" required>{inventory.map((item) => <option key={item.id} value={item.id}>{item.skuCode} · {item.skuName} · {item.warehouseName}（可售 {item.availableQty}）</option>)}</select></label><label>订购数量<input name="quantity" type="number" min="1" max="999" defaultValue="1" required /></label><label>币种<select name="currency" required><option value="USD">USD 美元</option><option value="EUR">EUR 欧元</option><option value="GBP">GBP 英镑</option><option value="CNY">CNY 人民币</option></select></label><label className="full">订单原币金额<input name="amount" type="number" min="0.01" step="0.01" placeholder="0.00" required /></label>{error && <div className="form-error full">{error}</div>}</div><div className="modal-safety"><span>安全规则</span>服务端生成订单号 · 重复提交不会重复建单 · 所有动作自动审计</div><div className="modal-actions"><button type="button" onClick={onClose} disabled={submitting}>取消</button><button className="primary-button" type="submit" disabled={submitting}>{submitting ? '正在安全写入…' : '创建待审核订单'}</button></div></form></div>;
}

function Status({ status }: { status: OrderStatus }) {
  return <span className={`status-pill status-${status}`}>{statusLabel[status]}</span>;
}

function InventoryStatus({ available }: { available: number }) {
  const label = available === 0 ? '已售罄' : available <= 10 ? '库存偏低' : '库存充足';
  return <span className={`status-pill ${available === 0 ? 'danger' : available <= 10 ? '' : 'success'}`}>{label}</span>;
}

function AuthRequired() {
  return <div className="content auth-state"><div className="auth-card"><div className="auth-mark">易</div><p>身份验证</p><h1>登录后进入易仓 ERP</h1><span>订单、库存和审计数据仅向已验证用户开放。</span><a className="primary-button auth-button" href="/signin-with-chatgpt?return_to=/">使用 ChatGPT 登录</a></div></div>;
}

function LoadingState({ message = '正在建立安全业务上下文…' }: { message?: string }) {
  return <div className="content loading-state"><span className="loader" /><p>{message}</p></div>;
}

function formatMoney(amountMinor: number, currency: string) {
  return new Intl.NumberFormat('zh-CN', { style: 'currency', currency }).format(amountMinor / 100);
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value));
}
