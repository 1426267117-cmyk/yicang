'use client';

import { useEffect, useId, useRef, useState } from 'react';
import type { PurchaseOrderPaymentOverview } from '../lib/purchase-payment-requests';
import styles from './erp-purchase-payment-overview.module.css';

type OrderLabel = { id: string; orderNo: string };
type PaymentOverviewResponse = { ok?: boolean; overview?: PurchaseOrderPaymentOverview; message?: string };
const digits = new Intl.NumberFormat('zh-CN');

export function formatPurchaseMinor(value: string | null, currency: string | null) {
  if (value === null || !currency) return '待核';
  // The purchase and finance ledgers store hundredths, including when the order uses another currency.
  const sign = value.startsWith('-') ? '−' : '';
  const minor = value.replace(/^-/, '').padStart(3, '0');
  return `${currency} ${sign}${digits.format(BigInt(minor.slice(0, -2)))}.${minor.slice(-2)}`;
}

export default function ErpPurchasePaymentOverview({ order }: { order: OrderLabel }) {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" className={`procurement-text-button ${styles.trigger}`} onClick={() => setOpen(true)}
      aria-label={`查看 ${order.orderNo} 付款进度`} aria-haspopup="dialog">付款进度</button>
    {open && <PaymentOverviewDialog key={order.id} order={order} onClose={() => setOpen(false)} />}
  </>;
}

function PaymentOverviewDialog({ order, onClose }: { order: OrderLabel; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{ revision: number; overview?: PurchaseOrderPaymentOverview; error?: string }>();
  const current = result?.revision === revision ? result : null;

  useEffect(() => {
    const dialog = dialogRef.current;
    const opener = document.activeElement;
    if (dialog && !dialog.open) dialog.showModal();
    return () => {
      if (dialog?.open) dialog.close();
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`/api/purchase/orders/${encodeURIComponent(order.id)}/payment-overview`, {
          cache: 'no-store', signal: controller.signal,
        });
        const body = await response.json().catch(() => null) as PaymentOverviewResponse | null;
        if (!response.ok || !body?.ok || body.overview?.orderId !== order.id) throw new Error(body?.message || '暂时无法读取采购付款进度');
        if (!controller.signal.aborted) setResult({ revision, overview: body.overview });
      } catch (error) {
        if (!controller.signal.aborted) setResult({ revision, error: error instanceof Error ? error.message : '暂时无法读取采购付款进度' });
      }
    })();
    return () => controller.abort();
  }, [order.id, revision]);

  return <dialog className={`modal ${styles.dialog}`} ref={dialogRef} aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); onClose(); }}>
    <header className="modal-head">
      <div><h2 id={titleId}>付款进度</h2><p>{order.orderNo}</p></div>
      <button type="button" aria-label="关闭付款进度" onClick={onClose}>×</button>
    </header>
    <div className={styles.body} aria-busy={!current}>
      {!current && <p role="status">正在读取付款进度…</p>}
      {current?.error && <p role="alert" className={styles.error}>{current.error}</p>}
      {current?.overview && <OverviewAmounts overview={current.overview} />}
    </div>
    <footer className={styles.actions}>
      <button className="secondary-button" type="button" disabled={!current} onClick={() => setRevision(value => value + 1)}>{current?.error ? '重试' : '刷新'}</button>
      <button className="primary-button" type="button" onClick={onClose}>关闭</button>
    </footer>
  </dialog>;
}

function OverviewAmounts({ overview }: { overview: PurchaseOrderPaymentOverview }) {
  const {
    status, committed, currency, paymentTerms, orderMinor, payableMinor, paidMinor, unpaidMinor, overpaidMinor,
    pendingApprovalMinor, approvedOutstandingMinor,
  } = overview;
  const amount = (value: string | null) => formatPurchaseMinor(value, currency);
  const paymentState = status === 'draft' ? '草稿待确认下单' : status === 'cancelled' ? '采购单已取消' : '采购单未生效';

  return <>
    {!committed && <p className={styles.notice}>{paymentState}。{orderMinor !== null ? `单据金额 ${amount(orderMinor)}。` : ''}</p>}
    {committed && payableMinor === null && <p className={styles.notice}>币种或采购明细金额待核对，应付和未付金额暂无法计算。</p>}
    <dl className={styles.totals}>
      <div><dt>应付金额</dt><dd>{committed ? amount(payableMinor) : '—'}</dd></div>
      <div><dt>已付净额</dt><dd>{amount(paidMinor)}</dd></div>
      <div><dt>未付金额</dt><dd>{committed ? amount(unpaidMinor) : '—'}</dd></div>
      <div><dt>待审批请款</dt><dd>{amount(pendingApprovalMinor)}</dd></div>
      <div><dt>已审批待结清</dt><dd>{amount(approvedOutstandingMinor)}</dd></div>
      {overpaidMinor !== null && <div><dt>超付金额</dt><dd>{amount(overpaidMinor)}</dd></div>}
    </dl>
    <p className={styles.terms}><strong>付款条款</strong><span>{paymentTerms?.trim() || '未填写'}</span></p>
    <p className={styles.legend}>未付金额按应付金额减去已付净额计算。已付净额扣除冲销，关联实付后会抵扣请款的待结清金额。</p>
  </>;
}
