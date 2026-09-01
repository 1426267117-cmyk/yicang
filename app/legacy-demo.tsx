'use client';

// 保留的初版界面原型；正式入口已切换到持久化业务客户端。
/* eslint-disable react-hooks/exhaustive-deps */

import { FormEvent, useMemo, useState } from 'react';

type ModuleKey = 'dashboard' | 'orders' | 'inventory' | 'purchase' | 'warehouse' | 'logistics' | 'finance' | 'reports';
type Row = Record<string, string>;

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

const baseOrders: Row[] = [
  { '订单号':'EC240901-3862','销售渠道':'Amazon US','目的地':'美国','客户':'Olivia Wilson','订单金额':'¥1,286.00','订单状态':'待审核','下单时间':'09-01 11:42' },
  { '订单号':'EC240901-3859','销售渠道':'Shopify','目的地':'英国','客户':'Arthur Hall','订单金额':'¥764.50','订单状态':'待发货','下单时间':'09-01 11:26' },
  { '订单号':'EC240901-3851','销售渠道':'eBay DE','目的地':'德国','客户':'Lena Weber','订单金额':'¥2,104.00','订单状态':'配货中','下单时间':'09-01 10:58' },
  { '订单号':'EC240901-3844','销售渠道':'Temu','目的地':'加拿大','客户':'Emma Brown','订单金额':'¥438.80','订单状态':'已发货','下单时间':'09-01 10:31' },
  { '订单号':'EC240901-3837','销售渠道':'TikTok Shop','目的地':'法国','客户':'Lucas Martin','订单金额':'¥986.00','订单状态':'异常','下单时间':'09-01 09:54' },
];

const moduleData: Record<Exclude<ModuleKey, 'dashboard'>, { title: string; desc: string; action: string; stats: string[][]; columns: string[]; rows: Row[] }> = {
  orders: { title:'订单管理', desc:'统一处理全渠道订单、审核、配货与售后', action:'新建订单', stats:[['今日订单','1,842','+12.6%'],['待审核','248','需及时处理'],['待发货','516','履约率 96.8%'],['异常订单','23','较昨日 -6']], columns:['订单号','销售渠道','目的地','客户','订单金额','订单状态','下单时间'], rows:baseOrders },
  inventory: { title:'商品库存', desc:'管理多仓 SKU 库存、调拨与补货预警', action:'新增商品', stats:[['在售 SKU','8,624','+126'],['可售库存','126,842','周转 6.8 次'],['库存预警','32','需立即补货'],['库存货值','¥4,286,400','环比 +3.2%']], columns:['SKU','商品名称','仓库','可售库存','在途库存','库存状态','更新时间'], rows:[
    {'SKU':'BF-CH-8821','商品名称':'北欧实木餐椅 · 胡桃色','仓库':'美西仓','可售库存':'18','在途库存':'120','库存状态':'库存偏低','更新时间':'11:36'},
    {'SKU':'BF-TB-2046','商品名称':'可升降电脑桌 120cm','仓库':'美东仓','可售库存':'364','在途库存':'0','库存状态':'库存充足','更新时间':'11:28'},
    {'SKU':'BF-SF-7135','商品名称':'模块化三人布艺沙发','仓库':'英国仓','可售库存':'6','在途库存':'48','库存状态':'紧急补货','更新时间':'11:15'},
    {'SKU':'BF-CB-1092','商品名称':'藤编双门储物柜','仓库':'德国仓','可售库存':'142','在途库存':'60','库存状态':'库存充足','更新时间':'10:54'},
    {'SKU':'BF-LT-5520','商品名称':'极简落地灯 · 米白','仓库':'加拿大仓','可售库存':'0','在途库存':'80','库存状态':'已售罄','更新时间':'10:42'},
  ]},
  purchase: { title:'采购管理', desc:'从采购计划、供应商下单到到货入库的全流程协同', action:'新建采购单', stats:[['本月采购额','¥1,862,400','预算使用 68%'],['待审核','14','¥82,640'],['在途采购','36','预计到货 8 批'],['准时交付率','94.6%','提升 1.8%']], columns:['采购单号','供应商','采购数量','采购金额','预计到货','采购状态','负责人'], rows:[
    {'采购单号':'PO260901-0288','供应商':'安吉森木家居','采购数量':'240','采购金额':'¥86,400','预计到货':'2026-09-08','采购状态':'待审核','负责人':'陈佳'},
    {'采购单号':'PO260831-0279','供应商':'佛山众创建材','采购数量':'680','采购金额':'¥142,800','预计到货':'2026-09-05','采购状态':'生产中','负责人':'徐宁'},
    {'采购单号':'PO260829-0261','供应商':'东莞新艺灯饰','采购数量':'1,200','采购金额':'¥96,000','预计到货':'2026-09-03','采购状态':'待收货','负责人':'林墨'},
    {'采购单号':'PO260826-0248','供应商':'宁波博达五金','采购数量':'3,600','采购金额':'¥58,320','预计到货':'2026-09-02','采购状态':'部分到货','负责人':'周宇'},
  ]},
  warehouse: { title:'仓库作业', desc:'监控入库、出库、盘点与各仓作业效能', action:'创建作业单', stats:[['今日出库','1,526 单','已完成 82%'],['待拣货','286 单','高峰波次 3 个'],['待入库','8,642 件','7 个到货批次'],['作业准确率','99.72%','本月目标 99.5%']], columns:['作业单号','作业类型','仓库','商品数量','完成进度','作业状态','负责人'], rows:[
    {'作业单号':'WH260901-1068','作业类型':'订单出库','仓库':'美西仓','商品数量':'624 件','完成进度':'78%','作业状态':'拣货中','负责人':'West-A'},
    {'作业单号':'WH260901-1054','作业类型':'采购入库','仓库':'美东仓','商品数量':'1,860 件','完成进度':'42%','作业状态':'质检中','负责人':'East-B'},
    {'作业单号':'WH260901-1029','作业类型':'库存盘点','仓库':'英国仓','商品数量':'328 SKU','完成进度':'96%','作业状态':'盘点中','负责人':'UK-01'},
    {'作业单号':'WH260831-0998','作业类型':'仓间调拨','仓库':'德国仓','商品数量':'480 件','完成进度':'100%','作业状态':'已完成','负责人':'DE-02'},
  ]},
  logistics: { title:'物流管理', desc:'跟踪跨境包裹、承运商时效与物流异常', action:'创建物流单', stats:[['在途包裹','4,286','覆盖 26 国'],['今日揽收','1,204','揽收率 98.2%'],['物流异常','38','需处理 12'],['平均妥投时效','4.8 天','缩短 0.3 天']], columns:['运单号','承运商','线路','发货仓','物流状态','预计送达','更新时间'], rows:[
    {'运单号':'YT260901882146','承运商':'燕文物流','线路':'美国专线','发货仓':'深圳仓','物流状态':'运输中','预计送达':'09-06','更新时间':'11:38'},
    {'运单号':'4PX26090171350','承运商':'递四方','线路':'英国经济线','发货仓':'东莞仓','物流状态':'已揽收','预计送达':'09-07','更新时间':'11:21'},
    {'运单号':'DHL-9836254108','承运商':'DHL','线路':'德国特快','发货仓':'德国仓','物流状态':'派送中','预计送达':'09-01','更新时间':'10:56'},
    {'运单号':'UPS-1Z89402E03','承运商':'UPS','线路':'美国本土','发货仓':'美西仓','物流状态':'物流异常','预计送达':'待确认','更新时间':'10:14'},
  ]},
  finance: { title:'财务管理', desc:'对账、收付款、费用与渠道利润统一核算', action:'登记收支', stats:[['本月收入','¥8,624,300','环比 +14.2%'],['本月支出','¥5,148,600','环比 +8.1%'],['预估毛利','¥3,475,700','毛利率 40.3%'],['待对账','¥286,420','16 个账单']], columns:['流水号','业务类型','关联单号','收支金额','币种','结算状态','记账时间'], rows:[
    {'流水号':'FN260901-6428','业务类型':'平台回款','关联单号':'AMZ-US-0831','收支金额':'+ ¥186,420','币种':'USD','结算状态':'已入账','记账时间':'11:18'},
    {'流水号':'FN260901-6412','业务类型':'物流费用','关联单号':'LG-0831-882','收支金额':'- ¥28,640','币种':'CNY','结算状态':'待审核','记账时间':'10:46'},
    {'流水号':'FN260901-6389','业务类型':'采购付款','关联单号':'PO260829-0261','收支金额':'- ¥48,000','币种':'CNY','结算状态':'部分付款','记账时间':'09:35'},
    {'流水号':'FN260831-6348','业务类型':'Shopify 回款','关联单号':'SHP-0831-21','收支金额':'+ ¥76,840','币种':'GBP','结算状态':'已入账','记账时间':'08-31 18:22'},
  ]},
  reports: { title:'数据报表', desc:'聚合经营、商品、渠道与仓储指标，辅助业务决策', action:'生成报表', stats:[['销售额','¥8,624,300','同比 +24.8%'],['订单量','48,216','同比 +18.6%'],['客单价','¥178.86','提升 ¥9.20'],['净利润率','18.4%','提升 2.1%']], columns:['报表名称','报表类型','统计周期','数据范围','生成状态','最近生成','创建人'], rows:[
    {'报表名称':'8 月全渠道经营月报','报表类型':'经营分析','统计周期':'月度','数据范围':'全部渠道','生成状态':'已生成','最近生成':'09-01 09:00','创建人':'系统'},
    {'报表名称':'海外仓库存健康度','报表类型':'库存分析','统计周期':'每周','数据范围':'5 个海外仓','生成状态':'已生成','最近生成':'08-31 23:30','创建人':'系统'},
    {'报表名称':'Amazon US 商品利润','报表类型':'利润分析','统计周期':'自定义','数据范围':'Amazon US','生成状态':'生成中','最近生成':'09-01 11:26','创建人':'林墨'},
    {'报表名称':'承运商妥投时效分析','报表类型':'物流分析','统计周期':'月度','数据范围':'全部承运商','生成状态':'待更新','最近生成':'08-01 09:00','创建人':'周宇'},
  ]},
};

function Status({ value }: { value: string }) {
  const danger = /异常|售罄|紧急/.test(value);
  const done = /完成|生成|入账|发货|充足/.test(value);
  return <span className={`status-pill ${danger ? 'danger' : done ? 'success' : ''}`}>{value}</span>;
}

export default function Home() {
  const [active, setActive] = useState<ModuleKey>('dashboard');
  const [query, setQuery] = useState('');
  const [orders, setOrders] = useState<Row[]>(baseOrders);
  const [showOrder, setShowOrder] = useState(false);
  const [showNotices, setShowNotices] = useState(false);
  const [toast, setToast] = useState('');
  const [period, setPeriod] = useState<'近 7 天' | '近 30 天'>('近 7 天');

  const current = active === 'dashboard' ? null : { ...moduleData[active], rows: active === 'orders' ? orders : moduleData[active].rows };
  const filteredRows = useMemo(() => {
    if (!current) return [];
    if (!query.trim()) return current.rows;
    const term = query.toLowerCase();
    return current.rows.filter(row => Object.values(row).some(value => value.toLowerCase().includes(term)));
  }, [current, query]);

  function switchModule(key: ModuleKey) { setActive(key); setQuery(''); setShowNotices(false); }
  function flash(message: string) { setToast(message); window.setTimeout(() => setToast(''), 2600); }
  function createAction() { if (active === 'orders' || active === 'dashboard') setShowOrder(true); else flash(`${current?.action}功能已进入下一开发阶段`); }
  function submitOrder(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const next: Row = { '订单号':`EC260901-${3900 + orders.length}`,'销售渠道':String(data.get('channel')),'目的地':String(data.get('country')),'客户':String(data.get('customer')),'订单金额':`¥${Number(data.get('amount')).toLocaleString('zh-CN',{minimumFractionDigits:2})}`,'订单状态':'待审核','下单时间':'刚刚' };
    setOrders([next, ...orders]); setShowOrder(false); setActive('orders'); flash('订单创建成功，已进入待审核队列');
  }
  function exportData() {
    if (!current) return;
    const csv = [current.columns.join(','), ...filteredRows.map(row => current.columns.map(col => `"${row[col] ?? ''}"`).join(','))].join('\n');
    const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob(['\ufeff' + csv], { type:'text/csv;charset=utf-8' })); link.download = `${current.title}-${new Date().toISOString().slice(0,10)}.csv`; link.click(); URL.revokeObjectURL(link.href); flash('数据导出完成');
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <button className="brand" onClick={() => switchModule('dashboard')}><span className="brand-mark">易</span><span>易仓 ERP</span></button>
        <p className="nav-label">业务中心</p>
        <nav>{nav.map(item => <button className={active === item.key ? 'nav-item active' : 'nav-item'} onClick={() => switchModule(item.key)} key={item.key}><span className="nav-icon">{item.code}</span>{item.label}{item.key === 'orders' && <b>24</b>}</button>)}</nav>
        <div className="sidebar-foot"><div className="help-icon">?</div><div><strong>需要帮助？</strong><small>查看操作指南</small></div></div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div className="crumb"><span>华东事业部</span><i>／</i><strong>{nav.find(item => item.key === active)?.label}</strong></div>
          <div className="top-actions">
            <label className="search"><span>⌕</span><input value={query} onChange={e => setQuery(e.target.value)} aria-label="全局搜索" placeholder={active === 'dashboard' ? '切换模块后搜索业务数据' : `搜索${current?.title}数据`} /></label>
            <button className="icon-button" onClick={() => setShowNotices(!showNotices)} aria-label="消息">◦<span className="notice-dot" /></button>
            <div className="avatar">LM</div><div className="user"><strong>林墨</strong><small>超级管理员</small></div>
          </div>
          {showNotices && <div className="notice-panel"><div className="notice-title"><strong>消息中心</strong><span>3 条未读</span></div><button onClick={() => { switchModule('inventory'); }}>美西仓 8 个 SKU 即将售罄<small>2 分钟前</small></button><button onClick={() => switchModule('purchase')}>采购单 PO260901-0288 等待审核<small>18 分钟前</small></button><button onClick={() => switchModule('logistics')}>UPS 运单发生地址异常<small>36 分钟前</small></button></div>}
        </header>

        {active === 'dashboard' ? <Dashboard period={period} setPeriod={setPeriod} openOrder={() => setShowOrder(true)} go={switchModule} orders={orders} /> : current && <ModuleView data={current} rows={filteredRows} query={query} action={createAction} exportData={exportData} detail={value => flash(`已选择 ${value}，详情面板即将开放`)} />}
      </section>

      {showOrder && <div className="modal-backdrop" onMouseDown={() => setShowOrder(false)}><form className="modal" onSubmit={submitOrder} onMouseDown={e => e.stopPropagation()}><div className="modal-head"><div><h2>新建销售订单</h2><p>订单创建后将进入审核队列</p></div><button type="button" onClick={() => setShowOrder(false)}>×</button></div><div className="form-grid"><label>销售渠道<select name="channel" required><option>Amazon US</option><option>Shopify</option><option>eBay DE</option><option>TikTok Shop</option></select></label><label>目的国家<select name="country" required><option>美国</option><option>英国</option><option>德国</option><option>法国</option></select></label><label className="full">客户名称<input name="customer" placeholder="请输入客户名称" required /></label><label>订单金额<input name="amount" type="number" min="0.01" step="0.01" placeholder="0.00" required /></label><label>币种<select><option>CNY 人民币</option><option>USD 美元</option><option>EUR 欧元</option></select></label></div><div className="modal-actions"><button type="button" onClick={() => setShowOrder(false)}>取消</button><button className="primary-button" type="submit">创建订单</button></div></form></div>}
      {toast && <div className="toast"><span>✓</span>{toast}</div>}
    </main>
  );
}

function Dashboard({ period, setPeriod, openOrder, go, orders }: { period:'近 7 天'|'近 30 天'; setPeriod:(value:'近 7 天'|'近 30 天')=>void; openOrder:()=>void; go:(key:ModuleKey)=>void; orders:Row[] }) {
  const heights = period === '近 7 天' ? [58,72,62,86,74,94,78] : [48,61,70,55,84,76,92];
  const metrics = [['今日销售额','¥ 286,430','12.6%','green'],['待处理订单','1,248','较昨日 +86','orange'],['库存周转率','6.8 次','提升 0.4','blue'],['预警商品','32','需立即补货','red']];
  return <div className="content"><div className="page-head"><div><p>2026年9月1日 · 星期二</p><h1>早上好，林墨</h1><span>这是你今天的业务概况，关键事项已为你整理。</span></div><button className="primary-button" onClick={openOrder}><span>＋</span> 新建订单</button></div>
    <section className="metrics" aria-label="核心业务指标">{metrics.map(metric => <article className="metric-card" key={metric[0]}><div className={`metric-symbol ${metric[3]}`}>{metric[0].slice(0,1)}</div><p>{metric[0]}</p><h2>{metric[1]}</h2><span className={metric[3] === 'red' ? 'negative' : ''}>{metric[2]}</span></article>)}</section>
    <div className="dashboard-grid"><article className="card trend-card"><div className="card-head"><div><h3>订单趋势</h3><p>{period}全渠道订单量</p></div><button className="select-button" onClick={() => setPeriod(period === '近 7 天' ? '近 30 天' : '近 7 天')}>{period}⌄</button></div><div className="chart-area"><div className="y-axis"><span>2k</span><span>1.5k</span><span>1k</span><span>500</span><span>0</span></div><div className="bars">{heights.map((height,index) => <div className="bar-col" key={index}><div className={index === 5 ? 'bar peak' : 'bar'} style={{height:`${height}%`}}><span>{index === 5 ? '1,864' : ''}</span></div><small>{['08/26','08/27','08/28','08/29','08/30','08/31','09/01'][index]}</small></div>)}</div></div><div className="chart-summary"><span><i className="legend green" />已付款 <b>8,642</b></span><span><i className="legend gray" />已取消 <b>316</b></span><strong>环比增长 14.2% ↑</strong></div></article>
      <article className="card alert-card"><div className="card-head"><div><h3>待办提醒</h3><p>需要你关注的业务事项</p></div><button className="link-button" onClick={() => go('inventory')}>查看全部</button></div><div className="alert-list"><button className="alert-item" onClick={() => go('inventory')}><span className="alert-symbol red">!</span><span><strong>32 个 SKU 库存不足</strong><small>其中 8 个预计 3 天内售罄</small></span><b>立即处理</b></button><button className="alert-item" onClick={() => go('purchase')}><span className="alert-symbol orange">↗</span><span><strong>14 个采购单待审核</strong><small>合计金额 ¥82,640.00</small></span><b>去审核</b></button><button className="alert-item" onClick={() => go('orders')}><span className="alert-symbol blue">◷</span><span><strong>186 个订单即将超时</strong><small>最早截止时间 14:30</small></span><b>去处理</b></button></div></article></div>
    <article className="card orders-card"><div className="card-head"><div><h3>最新订单</h3><p>实时同步自各销售渠道</p></div><button className="link-button" onClick={() => go('orders')}>进入订单中心 →</button></div><div className="table-wrap"><table><thead><tr><th>订单号</th><th>销售渠道</th><th>目的地</th><th>订单金额</th><th>订单状态</th><th>操作</th></tr></thead><tbody>{orders.slice(0,3).map(order => <tr key={order['订单号']}><td><strong>{order['订单号']}</strong></td><td>{order['销售渠道']}</td><td>{order['目的地']}</td><td>{order['订单金额']}</td><td><Status value={order['订单状态']} /></td><td><button className="table-action" onClick={() => go('orders')}>查看</button></td></tr>)}</tbody></table></div></article>
  </div>;
}

function ModuleView({ data, rows, query, action, exportData, detail }: { data:{title:string;desc:string;action:string;stats:string[][];columns:string[]}; rows:Row[]; query:string; action:()=>void; exportData:()=>void; detail:(value:string)=>void }) {
  return <div className="content module-content"><div className="module-head"><div><p>业务中心 / {data.title}</p><h1>{data.title}</h1><span>{data.desc}</span></div><div className="module-actions"><button className="secondary-button" onClick={exportData}>⇩ 导出数据</button><button className="primary-button" onClick={action}><span>＋</span> {data.action}</button></div></div>
    <section className="module-stats">{data.stats.map((stat,index) => <article key={stat[0]}><div className={`stat-dot tone-${index}`} /> <p>{stat[0]}</p><h2>{stat[1]}</h2><span>{stat[2]}</span></article>)}</section>
    <article className="card data-card"><div className="data-toolbar"><div><button className="tab-active">全部</button><button>待处理</button><button>进行中</button><button>已完成</button></div><span>{query ? `找到 ${rows.length} 条匹配数据` : `共 ${rows.length} 条记录`}</span></div><div className="table-wrap module-table"><table><thead><tr>{data.columns.map(col => <th key={col}>{col}</th>)}<th>操作</th></tr></thead><tbody>{rows.length ? rows.map((row,index) => <tr key={Object.values(row)[0] + String(index)}>{data.columns.map(col => <td key={col}>{/状态/.test(col) ? <Status value={row[col]} /> : col === data.columns[0] ? <strong>{row[col]}</strong> : row[col]}</td>)}<td><button className="table-action" onClick={() => detail(Object.values(row)[0])}>查看详情</button></td></tr>) : <tr><td className="empty-cell" colSpan={data.columns.length + 1}>没有找到与“{query}”匹配的数据</td></tr>}</tbody></table></div><div className="pagination"><span>显示 1–{rows.length} 条</span><div><button disabled>‹</button><button className="current">1</button><button disabled>›</button></div></div></article>
  </div>;
}
