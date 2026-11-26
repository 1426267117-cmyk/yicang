'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { PurchaseQualityState } from '../lib/purchase-quality-service';
import styles from './erp-purchase-quality.module.css';

type QualityOrder = { id: string; orderNo: string };
type QualityRead = { request: string; state: PurchaseQualityState | null; error: string };
type QualityResponse = { ok?: boolean; state?: PurchaseQualityState; message?: string; code?: string };
type Submission = { body: string; key: string };

const timeFormat = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'short', hourCycle: 'h23',
});

export function usePurchaseQuality(orderId: string, view: 'limits' | 'history' = 'limits') {
  const [revision, setRevision] = useState(0);
  const [read, setRead] = useState<QualityRead | null>(null);
  const url = `/api/purchase/orders/${encodeURIComponent(orderId)}/quality${view === 'limits' ? '?view=limits' : ''}`;
  const request = `${url}|${revision}`;
  const current = read?.request === request ? read : null;
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch(url, { cache: 'no-store', signal: controller.signal });
        const body = await response.json().catch(() => null) as QualityResponse | null;
        if (!response.ok || !body?.ok || body.state?.orderId !== orderId) {
          throw new Error(body?.message || '暂时无法读取采购质检状态');
        }
        if (!controller.signal.aborted) setRead({ request, state: body.state, error: '' });
      } catch (error) {
        if (!controller.signal.aborted) setRead({ request, state: null,
          error: error instanceof Error ? error.message : '暂时无法读取采购质检状态' });
      }
    }
    void load();
    return () => controller.abort();
  }, [url, request, orderId]);
  return { state: current?.state ?? null, error: current?.error ?? '', loading: !current,
    refresh: () => setRevision((value) => value + 1) };
}

export default function ErpPurchaseQuality({ order, canRequire, canInspect, disabled = false }: {
  order: QualityOrder; canRequire: boolean; canInspect: boolean; disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" className="action-muted" disabled={disabled} onClick={() => setOpen(true)}>到货质检</button>
    {open && <QualityDialog key={order.id} order={order} canRequire={canRequire} canInspect={canInspect} onClose={() => setOpen(false)} />}
  </>;
}

function QualityDialog({ order, canRequire, canInspect, onClose }: {
  order: QualityOrder; canRequire: boolean; canInspect: boolean; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const submitting = useRef(false);
  const [pending, setPending] = useState(false);
  const [attempt, setAttempt] = useState<Submission | null>(null);
  const [submitError, setSubmitError] = useState('');
  const [status, setStatus] = useState('');
  const { state, error, loading, refresh } = usePurchaseQuality(order.id, 'history');

  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    return () => { if (element?.open) element.close(); };
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>, action: 'require' | 'inspect') {
    event.preventDefault();
    if (submitting.current || !state) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    let current = attempt;
    if (!current) {
      const body = action === 'require'
        ? { action, reason: String(data.get('reason') ?? '').trim() }
        : buildInspection(data, state);
      if (typeof body === 'string') { setSubmitError(body); return; }
      current = { key: crypto.randomUUID(), body: JSON.stringify(body) };
    }
    submitting.current = true;
    setPending(true);
    setAttempt(current);
    setSubmitError('');
    setStatus('');
    try {
      const response = await fetch(`/api/purchase/orders/${encodeURIComponent(order.id)}/quality`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': current.key }, body: current.body,
      });
      const result = await response.json().catch(() => null) as QualityResponse | null;
      if (!response.ok && response.status < 500 && result?.code) {
        setAttempt(null);
        setSubmitError(result.message || '质检提交失败');
        if (response.status === 409) refresh();
        return;
      }
      if (!response.ok || !result?.ok || result.state?.orderId !== order.id) throw new Error('质检提交结果待确认');
      setAttempt(null);
      form.reset();
      setStatus(action === 'require' ? '此采购单已启用到货质检。' : '质检已登记。合格件数可在登记到货时入库。');
      refresh();
    } catch {
      setSubmitError('质检提交结果待确认。重试会按原操作去重。');
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }

  return <dialog className={`modal ${styles.dialog}`} ref={dialog} aria-labelledby="purchase-quality-title"
    onCancel={(event) => { event.preventDefault(); if (!pending) onClose(); }}>
    <header className="modal-head">
      <div><h2 id="purchase-quality-title">到货质检</h2><p>{order.orderNo}</p></div>
      <button type="button" aria-label="关闭到货质检" disabled={pending} onClick={onClose}>×</button>
    </header>
    <div className={styles.body}>
      {loading && <p role="status">正在读取质检记录…</p>}
      {error && <p role="alert" className={styles.error}>{error} <button type="button" onClick={refresh}>重试读取</button></p>}
      {submitError && <p role="alert" className={styles.error}>{submitError}</p>}
      {status && <p role="status" className={styles.success}>{status}</p>}
      {state && <>
        {state.requirement && <div className={styles.summary}>
          <strong>已启用到货质检</strong><span>{state.requirement.createdBy} · {formatTime(state.requirement.createdAt)}</span>
          <p>{state.requirement.reason}</p>
        </div>}
        {!state.required && <div className={styles.summary}>
          <strong>当前采购单未启用到货质检</strong>
          <p>{state.hasReceipt ? '该单已有入库历史，继续使用原收货流程。' : '启用后只允许合格放行件数入库，质检要求保留在采购单历史中。'}</p>
        </div>}
        {!state.required && canRequire && state.canEnable && <form onSubmit={(event) => { void submit(event, 'require'); }}>
          <fieldset disabled={pending || Boolean(attempt)} className={styles.fields}>
            <label>启用原因<textarea name="reason" required maxLength={500} rows={2} /></label>
          </fieldset>
          <div className={styles.buttons}><button className="primary-button" type="submit" disabled={pending}>{pending ? '正在登记…' : attempt ? '重试原提交' : '启用此单质检'}</button></div>
        </form>}

        {state.required && <>
          <QualitySummary state={state} />
          {canInspect && state.canInspect && <form onSubmit={(event) => { void submit(event, 'inspect'); }}>
            <fieldset disabled={pending || Boolean(attempt)} className={styles.fields}>
              <legend>登记本次实际质检</legend>
              <label>到货批次或送货单号<input name="batchReference" required maxLength={100} /></label>
              <label>质检备注<textarea name="note" maxLength={500} rows={2} /></label>
              <div className={styles.table}><table>
                <thead><tr><th scope="col">SKU</th><th scope="col">可检件数</th><th scope="col">合格</th><th scope="col">不合格</th><th scope="col">缺陷原因</th></tr></thead>
                <tbody>{state.lines.filter((line) => line.inspectableQty > 0).map((line) => <tr key={line.purchaseOrderLineId}>
                  <td>{line.skuCode}</td><td>{line.inspectableQty}</td>
                  <td><input type="number" aria-label={`${line.skuCode} 合格件数`} name={`passed:${line.purchaseOrderLineId}`} min={0} max={Math.min(line.inspectableQty, 1_000_000)} step={1} inputMode="numeric" /></td>
                  <td><input type="number" aria-label={`${line.skuCode} 不合格件数`} name={`rejected:${line.purchaseOrderLineId}`} min={0} max={Math.min(line.inspectableQty, 1_000_000)} step={1} inputMode="numeric" /></td>
                  <td><input aria-label={`${line.skuCode} 缺陷原因`} name={`defect:${line.purchaseOrderLineId}`} maxLength={500} placeholder="有不合格件时填写" /></td>
                </tr>)}</tbody>
              </table></div>
              <p className={styles.note}>不合格件保留检验记录，合格件由收货人员另行登记入库。</p>
            </fieldset>
            <div className={styles.buttons}><button className="primary-button" type="submit" disabled={pending}>{pending ? '正在登记…' : attempt ? '重试原提交' : '记录质检并放行合格件'}</button></div>
          </form>}
          <QualityHistory state={state} />
        </>}
      </>}
    </div>
  </dialog>;
}

function buildInspection(data: FormData, state: PurchaseQualityState) {
  const batchReference = String(data.get('batchReference') ?? '').trim();
  if (!batchReference) return '请填写该批次的到货批次或送货单号。';
  const lines = [];
  for (const line of state.lines) {
    const purchaseOrderLineId = line.purchaseOrderLineId;
    const passedQty = Number(data.get(`passed:${purchaseOrderLineId}`) ?? 0);
    const rejectedQty = Number(data.get(`rejected:${purchaseOrderLineId}`) ?? 0);
    const defectReason = String(data.get(`defect:${purchaseOrderLineId}`) ?? '').trim();
    if (!(passedQty || rejectedQty)) continue;
    if (!Number.isInteger(passedQty) || !Number.isInteger(rejectedQty) || passedQty < 0 || rejectedQty < 0
      || passedQty + rejectedQty > Math.min(line.inspectableQty, 1_000_000)) return `${line.skuCode} 本次质检件数超出可检范围。`;
    if (rejectedQty > 0 && !defectReason) return `请填写 ${line.skuCode} 的缺陷原因。`;
    lines.push({ purchaseOrderLineId, passedQty, rejectedQty, defectReason: rejectedQty > 0 ? defectReason : undefined });
  }
  if (!lines.length) return '请填写至少一个 SKU 的合格或不合格件数。';
  return { action: 'inspect', batchReference, note: String(data.get('note') ?? '').trim() || undefined, lines };
}

function QualitySummary({ state }: { state: PurchaseQualityState }) {
  return <section aria-label="采购单质检状态" className={styles.table}><table>
    <thead><tr><th scope="col">SKU</th><th scope="col">待收</th><th scope="col">累计合格</th><th scope="col">累计不合格</th><th scope="col">已放行待入库</th></tr></thead>
    <tbody>{state.lines.map((line) => <tr key={line.purchaseOrderLineId}>
      <td><strong>{line.skuCode}</strong><small className="cell-sub">{line.skuName}</small></td>
      <td>{line.remainingQty}</td><td>{line.passedQty}</td><td>{line.rejectedQty}</td><td><strong>{line.availableQty}</strong></td>
    </tr>)}</tbody>
  </table></section>;
}

function QualityHistory({ state }: { state: PurchaseQualityState }) {
  return <section className={styles.history} aria-label="质检历史">
    <h3>质检历史</h3>
    {state.inspections.map((inspection) => <details key={inspection.id}>
      <summary><strong>{inspection.batchReference}</strong><span>{inspection.inspectedBy} · {formatTime(inspection.createdAt)}</span></summary>
      {inspection.note && <p>{inspection.note}</p>}
      <ul>{inspection.lines.map((line) => <li key={line.purchaseOrderLineId}>
        {line.skuCode} · 合格 {line.passedQty} 件 · 不合格 {line.rejectedQty} 件{line.defectReason && ` · ${line.defectReason}`}
      </li>)}</ul>
    </details>)}
    {!state.inspections.length && <p>暂无已登记的质检批次。</p>}
    {state.hasMoreInspections && <p>当前显示最近 {state.inspections.length} 个批次。</p>}
  </section>;
}

function formatTime(timestamp: string) {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? '时间待核' : timeFormat.format(date);
}
