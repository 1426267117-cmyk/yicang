'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ChannelOrder } from '../lib/channel-orders';
import type { getNativeChannelHandoff } from '../lib/native-channel-handoff';
import type { HandoffOrder } from './erp-nine-store-handoff';
import type { NineStoreWorkflow } from './erp-nine-store-orders';

type HandoffView = Awaited<ReturnType<typeof getNativeChannelHandoff>>;

const fulfillmentState: Record<HandoffOrder['status'], string> = {
  pending_review: '待审核', reserved: '待仓库发货', shipped: '已发货', cancelled: '已取消',
};

export default function ErpChannelOrderHandoff({ order, workflow, canRefreshSource, onChanged }: {
  order: ChannelOrder; workflow: NineStoreWorkflow; canRefreshSource: boolean; onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<HandoffView | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [refreshingSource, setRefreshingSource] = useState(false);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const savingRef = useRef(false);
  const endpoint = `/api/channel-orders/${encodeURIComponent(order.id)}/handoff`;

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    async function read() {
      try {
        const response = await fetch(endpoint, { cache: 'no-store', signal: controller.signal });
        const body = await response.json() as HandoffView & { ok?: boolean; message?: string };
        if (!response.ok || body.ok !== true || !body.source) throw new Error(body.message ?? '暂时无法核对订单流转');
        if (!controller.signal.aborted) setView(body);
      } catch (cause) {
        if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '暂时无法核对订单流转');
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void read();
    return () => controller.abort();
  }, [endpoint, open, reload]);

  function refresh() {
    setOpen(true);
    setError('');
    setLoading(true);
    setReload((value) => value + 1);
  }

  async function refreshSource() {
    setRefreshingSource(true);
    setError('');
    try {
      const response = await fetch(`/api/channel-orders/${encodeURIComponent(order.id)}/refresh`, { method: 'POST' });
      const result = await response.json() as { ok?: boolean; message?: string; refreshedAt?: string };
      if (!response.ok || result.ok !== true || !result.refreshedAt) throw new Error(result.message ?? '暂时无法刷新平台来源');
      refresh();
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '暂时无法刷新平台来源');
    } finally {
      setRefreshingSource(false);
    }
  }

  const quantity = view?.source.quantity ?? 0;
  const warehouses = workflow.inventory.filter((item) => item.skuId === view?.matchedSkuId && item.availableQty >= quantity);
  const canSubmit = view?.eligibility === 'ready' && view.canCreate && workflow.canCreate && warehouses.length > 0;
  const linked = view?.linkedOrder;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!view || !view.matchedSkuId || !canSubmit || loading || savingRef.current) return;
    const form = new FormData(event.currentTarget);
    const warehouseId = String(form.get('warehouseId') ?? '');
    if (!warehouses.some((warehouse) => warehouse.warehouseId === warehouseId)) return;
    if (!form.has('confirmedMerchantFulfillment') || !form.has('confirmedUnrefunded') || !form.has('confirmedPayment')) return;
    const body = {
      storeKey: view.source.storeKey, sourceVersion: view.source.sourceVersion,
      skuId: view.matchedSkuId, warehouseId,
      customerName: String(form.get('customerName') ?? '').trim(),
      destination: String(form.get('destination') ?? '').trim(),
      confirmedMerchantFulfillment: true, confirmedUnrefunded: true, confirmedPayment: true,
    };
    savingRef.current = true;
    setSaving(true);
    setError('');
    try {
      const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const result = await response.json() as { ok?: boolean; order?: HandoffView['linkedOrder']; message?: string };
      if (!response.ok || result.ok !== true || !result.order) {
        if (response.status === 409) setView(null);
        throw new Error(result.message ?? '转单结果待确认，请重新核对。');
      }
      setView({ ...view, eligibility: 'already_linked', reason: '这笔店铺订单已有 ERP 单据。', linkedOrder: result.order });
      onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '转单结果待确认，请重新核对。');
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  return <section className="erp-native-handoff" aria-label="运营订单流转">
    <div className="erp-native-handoff-heading"><h3>运营订单流转</h3>
      {!linked && <button type="button" className="link-button" disabled={loading || saving || refreshingSource} onClick={refresh}>
        {open ? '重新核对来源' : '核对并转单'}
      </button>}
    </div>
    {loading && <p role="status">正在核对平台订单和 ERP 库存…</p>}
    {error && <p className="erp-handoff-error" role="alert">{error}</p>}
    {linked ? <div className="erp-handoff-status erp-handoff-linked">
      <div><strong>{linked.orderNo}</strong><span>{fulfillmentState[linked.status]}</span></div>
      <div className="erp-native-handoff-links">
        <button type="button" className="link-button" onClick={() => workflow.onOpenOrder(linked.orderNo)}>打开运营订单</button>
        {linked.status === 'reserved' && <button type="button" className="link-button" onClick={() => workflow.onOpenWarehouse(linked.orderNo)}>查看仓库任务</button>}
        {linked.status === 'shipped' && <button type="button" className="link-button" onClick={() => workflow.onOpenLogistics(linked.orderNo)}>查看物流</button>}
      </div>
    </div> : view && <>
      {view.reason && <p>{view.reason}</p>}
      {['source_stale', 'shipping_unverified'].includes(view.eligibility) && canRefreshSource &&
        <button type="button" className="secondary-button" disabled={refreshingSource} onClick={() => { void refreshSource(); }}>
          {refreshingSource ? '刷新中…' : '从平台刷新这一单'}
        </button>}
      <dl className="erp-handoff-facts">
        <div><dt>平台 SKU</dt><dd>{view.source.sku ?? '—'}</dd></div>
        <div><dt>本单数量</dt><dd>{view.source.quantity ?? '—'}</dd></div>
        <div><dt>订单原币金额</dt><dd>{view.source.amountMinor === null ? '—' : `${view.source.currency ?? ''} ${(view.source.amountMinor / 100).toFixed(2)}`}</dd></div>
      </dl>
      {view.eligibility === 'ready' && !warehouses.length && <p>该 SKU 的各仓可售数量不足。<button type="button" className="link-button" onClick={() => workflow.onOpenInventory(view.source.sku ?? '')}>查看库存</button></p>}
      {canSubmit && <form onSubmit={(event) => { void submit(event); }}>
        <fieldset className="form-grid erp-native-handoff-form" disabled={saving || loading}>
          <legend>发货资料</legend>
          <label>发货仓<select name="warehouseId" defaultValue="" required>
            <option value="">选择仓库</option>{warehouses.map((warehouse) => <option key={warehouse.warehouseId} value={warehouse.warehouseId}>
              {warehouse.warehouseName} · 可用 {warehouse.availableQty} 件
            </option>)}
          </select></label>
          <label>发货目的地<input name="destination" maxLength={40} required /></label>
          <label className="full">原单客户<input name="customerName" minLength={2} maxLength={80} required /></label>
          <label className="full nine-store-confirm"><input name="confirmedMerchantFulfillment" type="checkbox" required />已核对由本公司仓库发货，平台尚未发货。</label>
          <label className="full nine-store-confirm"><input name="confirmedPayment" type="checkbox" required />已核对渠道的付款或可履约凭证。</label>
          <label className="full nine-store-confirm"><input name="confirmedUnrefunded" type="checkbox" required />已核对该订单未取消、未退款。</label>
        </fieldset>
        <div className="erp-native-handoff-links"><button className="primary-button" type="submit" disabled={saving || loading}>
          {saving ? '转单中…' : '生成待审核运营单'}
        </button></div>
      </form>}
    </>}
  </section>;
}
