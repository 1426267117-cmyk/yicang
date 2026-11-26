'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';

export type HandoffInventory = { skuId: string; skuCode: string; skuName: string; warehouseId: string; warehouseName: string; availableQty: number };
export type HandoffOrder = { id: string; orderNo: string; status: 'pending_review' | 'reserved' | 'shipped' | 'cancelled'; trackedPackages?: number };
export type HandoffSelection = { storeKey: string; storeName: string; orderNo: string; historical: boolean };

type Eligibility = 'ready' | 'source_stale' | 'not_pending' | 'awaiting_sku' | 'ambiguous' | 'refunded' | 'already_linked';
type Trace = {
  source: { storeKey: string; orderNo: string; sku: string | null; observedAt: string; fulfillment: string | null };
  eligibility: Eligibility; matchedSkuId: string | null; linkedOrder: HandoffOrder | null;
};

const eligibilityLabel: Record<Eligibility, string> = {
  ready: '可生成运营订单。请先核对渠道原单和发货数量。',
  source_stale: '来源数据超过 15 分钟。同步后请重新核对。',
  not_pending: '渠道尚未确认待发货。请先核对履约状态。',
  awaiting_sku: '未匹配到唯一 ERP SKU。请先核对商品档案。',
  ambiguous: '渠道订单包含多条明细或缺少唯一 SKU，请逐行核对。',
  refunded: '订单存在退款，请先核对剩余发货数量。',
  already_linked: '已关联运营订单。',
};
const orderStatusLabel: Record<HandoffOrder['status'], string> = {
  pending_review: '待审核', reserved: '待仓库发货', shipped: 'ERP 已发货', cancelled: 'ERP 已取消',
};
const sourceStatusLabel: Record<string, string> = {
  pending: '待发货', shipped: '已发货', delivered: '已签收', cancelled: '已取消', exception: '异常',
};
const reportTime = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'short' });

export default function ErpNineStoreHandoff({ selection, inventory, canCreate, onClose, onOpenOrder, onOpenWarehouse, onOpenLogistics, onOpenInventory }: {
  selection: HandoffSelection; inventory: HandoffInventory[]; canCreate: boolean;
  onClose: () => void; onOpenOrder: (orderNo: string) => void; onOpenWarehouse: (orderNo: string) => void; onOpenLogistics: (orderNo: string) => void;
  onOpenInventory: (sku: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const inFlight = useRef(false);
  const [trace, setTrace] = useState<Trace | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => { if (element?.open) element.close(); };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({ store: selection.storeKey, orderNo: selection.orderNo });
    async function read() {
      try {
        const response = await fetch(`/api/nine-store-orders/handoff?${params}`, { cache: 'no-store', signal: controller.signal });
        const body = await response.json() as Trace & { ok?: boolean; message?: string };
        if (!response.ok || !body.ok) throw new Error(body.message || '读取订单流转失败');
        if (!controller.signal.aborted) setTrace(body);
      } catch (failure) {
        if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : '读取订单流转失败');
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void read();
    return () => controller.abort();
  }, [selection.storeKey, selection.orderNo, revision]);

  const warehouses = inventory.filter((item) => item.skuId === trace?.matchedSkuId && item.availableQty > 0);
  const linked = trace?.linkedOrder;
  const ready = trace?.eligibility === 'ready' && trace.source.sku && canCreate && !selection.historical;

  function refresh() {
    setError('');
    setLoading(true);
    setRevision((value) => value + 1);
  }

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!trace || !ready || !trace.matchedSkuId || inFlight.current || loading) return;
    const formData = new FormData(event.currentTarget);
    const get = (name: string) => String(formData.get(name) ?? '').trim();
    const quantity = Number(get('quantity'));
    const amount = get('amount');
    const warehouseId = get('warehouseId');
    const warehouse = warehouses.find((item) => item.warehouseId === warehouseId);
    if (!warehouse || !Number.isInteger(quantity) || quantity < 1 || quantity > Math.min(999, warehouse.availableQty)) {
      setError('请核对仓库和待发数量。数量须是可用库存范围内的整数。');
      return;
    }
    if (!/^\d{1,7}(?:\.\d{1,2})?$/u.test(amount) || Number(amount) <= 0 || Number(amount) > 1_000_000) {
      setError('请输入有效的原币订单金额，最多保留两位小数。');
      return;
    }
    if (!formData.has('confirmedPending')) {
      setError('请确认订单归属、ERP 录入情况、平台履约和发货信息。');
      return;
    }
    const body = JSON.stringify({ storeKey: selection.storeKey, orderNo: trace.source.orderNo,
      sourceSku: trace.source.sku, observedAt: trace.source.observedAt,
      skuId: trace.matchedSkuId, warehouseId, quantity, customerName: get('customerName'), destination: get('destination'),
      currency: get('currency'), amountMinor: Math.round(Number(amount) * 100), confirmedPending: true });
    inFlight.current = true;
    setPending(true);
    setError('');
    try {
      const response = await fetch('/api/nine-store-orders/handoff', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body });
      const result = await response.json() as { ok?: boolean; order?: HandoffOrder; message?: string };
      if (!response.ok && response.status < 500) {
        if (response.status === 409) refresh();
        setError(result.message || '请核对来源状态后重试');
        return;
      }
      if (!response.ok || !result.ok || !result.order) throw new Error('提交结果待确认');
      setTrace({ ...trace, linkedOrder: result.order, eligibility: 'already_linked' });
    } catch {
      setError('提交结果待确认。可以原样重试，或重新核对是否已生成订单。');
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  return <dialog ref={dialog} className="modal nine-store-handoff" aria-labelledby="nine-store-handoff-title" onCancel={(event) => {
    event.preventDefault();
    if (!inFlight.current) onClose();
  }}>
    <div className="modal-head"><div><h2 id="nine-store-handoff-title">订单流转</h2>
      <p>{selection.storeName} · {selection.orderNo}</p></div>
      <button type="button" aria-label="关闭订单流转" disabled={pending} onClick={onClose}>×</button></div>
    {loading && <p className="nine-store-message" role="status">正在核对订单来源…</p>}
    {error && <div className="nine-store-handoff-alert" role="alert">{error}</div>}
    {trace && <section className="nine-store-handoff-summary" aria-label="来源和流转状态">
      <dl className="erp-handoff-facts">
        <div><dt>来源 SKU</dt><dd>{trace.source.sku || '—'}</dd></div>
        <div><dt>渠道履约</dt><dd>{sourceStatusLabel[trace.source.fulfillment ?? ''] ?? '待核'}</dd></div>
        <div><dt>资料时间（北京时间）</dt><dd>{reportTime.format(new Date(trace.source.observedAt))}</dd></div>
      </dl>
      {linked ? <div className="erp-handoff-status erp-handoff-linked">
        <div><strong>{linked.orderNo}</strong><span>{orderStatusLabel[linked.status]}</span></div>
        {linked.status === 'shipped' && <small>{linked.trackedPackages ? `已登记 ${linked.trackedPackages} 个物流包裹。` : '待登记物流。'} 平台回传待授权核验。</small>}
      </div> : <div className="erp-handoff-status">
        {selection.historical ? '该历史记录暂无关联运营订单。' : !canCreate ? '暂无关联运营订单。' : ready && !warehouses.length ? '匹配 SKU 暂无可发库存。' : eligibilityLabel[trace.eligibility]}
      </div>}
    </section>}
    {ready && warehouses.length > 0 && <form onSubmit={(event) => void create(event)}>
      <fieldset className="form-grid nine-store-handoff-form" disabled={pending || loading}>
        <legend>运营订单资料</legend>
        <label>发货仓<select name="warehouseId" defaultValue="" required><option value="">选择仓库</option>{warehouses.map((item) =>
          <option key={item.warehouseId} value={item.warehouseId}>{item.warehouseName} · 可用 {item.availableQty} 件</option>)}</select></label>
        <label>核实待发数量<input name="quantity" type="number" min={1} max={999} required /></label>
        <label>原单客户<input name="customerName" minLength={2} maxLength={80} required /></label>
        <label>发货目的地<input name="destination" maxLength={40} required /></label>
        <label>原币<select name="currency" defaultValue="" required><option value="">选择币种</option>{['CNY', 'USD', 'EUR', 'GBP'].map((unit) => <option key={unit}>{unit}</option>)}</select></label>
        <label>原币订单金额<input name="amount" inputMode="decimal" maxLength={11} placeholder="0.00" required /></label>
        <label className="full nine-store-confirm"><input name="confirmedPending" type="checkbox" required />确认本公司订单、ERP 未录入、商家自发货且未发未退款，数量和仓库已核对。</label>
      </fieldset>
      <div className="modal-actions"><button type="button" disabled={pending || loading} onClick={refresh}>重新核对</button>
        <button className="primary-button" disabled={pending || loading}>{pending ? '提交中…' : '生成待审核运营单'}</button></div>
    </form>}
    {!linked && (!ready || !warehouses.length) && <div className="modal-actions"><button type="button" onClick={onClose}>关闭</button>
      {trace?.source.sku && (trace.eligibility === 'awaiting_sku' || (ready && !warehouses.length)) &&
        <button type="button" onClick={() => onOpenInventory(trace.source.sku!)}>查看 ERP 库存</button>}
      <button type="button" disabled={loading} onClick={refresh}>重新核对</button></div>}
    {linked && <div className="modal-actions">
      {linked.status === 'reserved' && <button type="button" onClick={() => onOpenWarehouse(linked.orderNo)}>查看仓库任务</button>}
      {linked.status === 'shipped' && <button type="button" onClick={() => onOpenLogistics(linked.orderNo)}>查看物流</button>}
      <button type="button" className="primary-button" onClick={() => onOpenOrder(linked.orderNo)}>打开运营订单</button>
    </div>}
  </dialog>;
}
