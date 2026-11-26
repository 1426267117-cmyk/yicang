'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { FinanceLedger, FinanceLedgerKind, FinanceScope, FinanceWorkspace, NewInvoice, NewPayment } from '../lib/finance';
import styles from './erp-finance.module.css';

const scopeLabels: Record<FinanceScope, string> = {
  committed: '已下单', draft: '采购草稿', cancelled: '已取消', all: '全部采购单',
};
const statusLabels: Record<FinanceWorkspace['orders'][number]['status'], string> = {
  draft: '草稿', issued: '已下单', partially_received: '部分到货', received: '全部到货',
  closed_short: '短到关闭', cancelled: '已取消',
};
const quantity = new Intl.NumberFormat('zh-CN');
const dateTime = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', dateStyle: 'medium', timeStyle: 'short',
});
type LedgerEntry = FinanceLedger['entries'][number];
type LedgerAction = { kind: 'record' } | { kind: 'reversal'; original: LedgerEntry };

function financeAmount(minor: string | null, currency: string | null) {
  if (minor === null || !currency) return '未知';
  const negative = minor.startsWith('-');
  const digits = minor.replace(/^-/, '').padStart(3, '0');
  return `${currency} ${negative ? '−' : ''}${quantity.format(BigInt(digits.slice(0, -2)))}.${digits.slice(-2)}`;
}

function readDate(value: string | null) {
  if (!value) return '—';
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? '—' : dateTime.format(parsed);
}

function useFinanceRead<T>(query: string | null, version: number) {
  const key = `${query}#${version}`;
  const [state, setState] = useState<{ key: string; data?: T; error?: string }>();
  useEffect(() => {
    if (query === null) return;
    const controller = new AbortController();
    async function read() {
      try {
        const response = await fetch(`/api/finance?${query}`, { cache: 'no-store', signal: controller.signal });
        const payload = await response.json().catch(() => null) as (T & { ok?: boolean; message?: string }) | null;
        if (!response.ok || !payload?.ok) throw new Error(payload?.message || '暂时无法读取财务数据');
        if (!controller.signal.aborted) setState({ key, data: payload });
      } catch (cause) {
        if (!controller.signal.aborted) setState({ key, error: cause instanceof Error ? cause.message : '财务数据读取失败' });
      }
    }
    void read();
    return () => controller.abort();
  }, [key, query]);

  return state?.key === key ? state : undefined;
}

export default function ErpFinance({ canRead, canWrite = false }: { canRead: boolean; canWrite?: boolean }) {
  const [scope, setScope] = useState<FinanceScope>('committed');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [version, setVersion] = useState(0);
  const [orderId, setOrderId] = useState<string | null>(null);
  const query = new URLSearchParams({ scope, search, page: String(page) }).toString();
  const workspace = useFinanceRead<FinanceWorkspace>(canRead ? query : null, version);
  const data = workspace?.data;
  const reload = () => setVersion((value) => value + 1);

  function applySearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSearch(String(new FormData(event.currentTarget).get('search') ?? '').trim());
    setPage(1);
  }

  return <div className={`content ${styles.content}`}>
    <header className={`module-head ${styles.pageHeader}`}>
      <h1>采购对账</h1>
      {canRead && <button className="secondary-button" type="button" onClick={reload} disabled={!workspace}>刷新</button>}
    </header>
    {!canRead ? <section className="card"><p className={styles.empty}>当前账号没有财务台账权限。</p></section> : <>
      <section className={`card data-card ${styles.reconciliation}`} aria-label="采购对账" aria-busy={!workspace}>
        <form className={styles.filters} aria-label="采购对账筛选" onSubmit={applySearch}>
          <label>采购状态<select value={scope} onChange={(event) => {
            setScope(event.target.value as FinanceScope);
            setPage(1);
          }}>
            {Object.entries(scopeLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
          </select></label>
          <label>单号或供应商<input name="search" type="search" maxLength={120} placeholder="输入采购单号或供应商" /></label>
          <button className="secondary-button" type="submit">查询</button>
          <details className={styles.accountingBasis}>
            <summary>核算口径</summary>
            <p>采购货值按单价、订购和净收货数量计算，金额按原币汇总。应付余额为采购单金额扣除实付净额，实际付款以核对后的凭证登记，冲正保留原记录。</p>
          </details>
        </form>

        {workspace?.error && <p className={styles.error} role="alert">{workspace.error}</p>}
        {!workspace && <p className={styles.empty} role="status">正在读取采购对账…</p>}
        {data && <>
          {data.currencies.length > 0 && <section aria-labelledby="currency-totals">
            <h2 className={styles.sectionTitle} id="currency-totals">按币种汇总</h2>
            <div className={`table-wrap module-table ${styles.summary}`}>
            <table aria-label="按币种汇总"><thead><tr>
              <th>币种</th><th>有效计价单数</th><th>采购金额</th><th>净收货货值</th><th>发票净额</th><th>实付净额</th>
            </tr></thead><tbody>{data.currencies.map((row) => <tr key={row.currency ?? ''}>
              <th scope="row">{row.currency ?? '币种待补'}</th>
              <td>{row.valuedOrderCount} / {row.orderCount}</td>
              <td>{financeAmount(row.orderedMinor, row.currency)}{row.valuedOrderCount < row.orderCount && row.orderedMinor !== null && '（部分）'}</td>
              <td>{financeAmount(row.receivedMinor, row.currency)}{row.valuedOrderCount < row.orderCount && row.receivedMinor !== null && '（部分）'}</td>
              <td>{row.invoiceCount > 0 ? financeAmount(row.invoicedMinor, row.currency) : '暂无登记'}</td>
              <td>{row.paymentCount > 0 ? financeAmount(row.paidMinor, row.currency) : '暂无登记'}</td>
            </tr>)}</tbody></table>
            </div>
          </section>}
          <div className={styles.detailHeading}><h2>采购单明细</h2><span>共 {quantity.format(data.total)} 张</span></div>
          <div className={`table-wrap module-table ${styles.orders}`}>
            <table aria-label="采购单对账明细"><thead><tr>
              <th>采购单</th><th>供应商</th><th>采购状态</th><th>采购单金额</th><th>净收货货值</th>
              <th>发票净额</th><th>实付净额</th><th>应付余额</th><th>操作</th>
            </tr></thead><tbody>{data.orders.length > 0 ? data.orders.map((order) => <tr key={order.id}>
              <td><strong>{order.orderNo}</strong><small className="cell-sub">{readDate(order.issuedAt)}</small></td>
              <td>{order.supplierName}</td><td><span className={`status-pill purchase-order-status-${order.status}`}>{statusLabels[order.status]}</span></td>
              <td>{financeAmount(order.orderedMinor, order.currency)}</td><td>{financeAmount(order.receivedMinor, order.currency)}</td>
              <td>{order.invoiceCount ? financeAmount(order.invoicedMinor, order.currency) : '暂无登记'}</td>
              <td>{order.paymentCount ? financeAmount(order.paidMinor, order.currency) : '暂无登记'}</td>
              <td className={order.differenceMinor?.startsWith('-') ? styles.overpaid : undefined}>
                {order.differenceMinor?.startsWith('-') && '超付 '}
                {order.differenceMinor?.startsWith('-') ? financeAmount(order.differenceMinor.slice(1), order.currency)
                  : financeAmount(order.differenceMinor, order.currency)}
              </td>
              <td><div className="row-actions"><button type="button" onClick={() => setOrderId(order.id)}>查看台账</button></div></td>
            </tr>) : <tr><td colSpan={9} className="empty-cell">{data.total ? '当前页没有采购单' : '没有符合条件的采购单'}</td></tr>}</tbody></table>
          </div>
          {data.total > data.pageSize && <PageButtons page={page} size={data.pageSize} total={data.total} change={setPage} />}
        </>}
      </section>
    </>}
    {canRead && orderId && <LedgerDialog key={orderId} orderId={orderId} canWrite={canWrite} onClose={() => setOrderId(null)} onChange={reload} />}
  </div>;
}

function PageButtons({ page, size, total, change }: { page: number; size: number; total: number; change: (page: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / size));
  return <div className={styles.pages}>
    <span>第 {page} / {pages} 页</span>
    <button className="secondary-button" type="button" disabled={page <= 1} onClick={() => change(page - 1)}>上一页</button>
    <button className="secondary-button" type="button" disabled={page >= pages} onClick={() => change(page + 1)}>下一页</button>
  </div>;
}

function LedgerDialog({ orderId, canWrite, onClose, onChange }: { orderId: string; canWrite: boolean; onClose: () => void; onChange: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const pending = useRef<{ key: string; body: string } | null>(null);
  const submitting = useRef(false);
  const [ledgerKind, setLedgerKind] = useState<FinanceLedgerKind>('payment');
  const [page, setPage] = useState(1);
  const [version, setVersion] = useState(0);
  const [action, setAction] = useState<LedgerAction | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const query = new URLSearchParams({ orderId, page: String(page), ledger: ledgerKind }).toString();
  const ledger = useFinanceRead<FinanceLedger>(query, version);
  const data = ledger?.data;
  const order = data?.order;
  const isInvoice = ledgerKind === 'invoice';
  const canRecord = isInvoice ? order?.canRecordInvoice : order?.canRecordPayment;
  const ledgerLabel = isInvoice ? '发票' : '付款';
  const entryCount = order ? (isInvoice ? order.invoiceCount : order.paymentCount) : 0;
  const reload = () => setVersion((value) => value + 1);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog?.open) dialog?.showModal();
    return () => dialog?.close();
  }, []);

  function showLedger(next: FinanceLedgerKind) {
    setLedgerKind(next);
    setPage(1);
    setAction(null);
    setError('');
    setNotice('');
  }

  function begin(next: LedgerAction) {
    setError('');
    setNotice('');
    setAction(next);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!order?.currency || !action || submitting.current) return;
    const form = new FormData(event.currentTarget);
    const amount = /^\s*(\d{1,11})(?:\.(\d{1,2}))?\s*$/u.exec(String(form.get('amount') ?? ''));
    const amountMinor = amount ? Number(amount[1]) * 100 + Number((amount[2] ?? '').padEnd(2, '0')) : 0;
    const occurredAt = String(form.get('occurredAt') ?? '');
    const paidAt = new Date(`${occurredAt}:00+08:00`);
    const hasDate = isInvoice ? /^\d{4}-\d{2}-\d{2}$/u.test(occurredAt) : Number.isFinite(paidAt.valueOf());
    if (amountMinor <= 0 || amountMinor > 1_000_000_000_000 || !hasDate) {
      setError('请填写大于零且最多两位小数的金额，并核对实际发生时间。');
      return;
    }
    if (action.kind === 'reversal' && BigInt(amountMinor) > BigInt(action.original.reversibleMinor ?? '0')) {
      setError('冲正金额超过原付款的可冲正余额。');
      return;
    }
    if (action.kind === 'record' && !isInvoice && BigInt(amountMinor) > BigInt(order.differenceMinor ?? '0')) {
      setError('登记金额超过采购单当前应付余额。');
      return;
    }

    const fields = {
      purchaseOrderId: order.id, amountMinor, currency: order.currency,
      reference: String(form.get('reference') ?? '').trim(), note: String(form.get('note') ?? '').trim(),
    };
    const payload: NewPayment | NewInvoice = isInvoice
      ? action.kind === 'reversal'
        ? { ...fields, kind: 'reversal', invoiceOn: occurredAt, originalInvoiceId: action.original.id }
        : { ...fields, kind: 'invoice', invoiceOn: occurredAt }
      : action.kind === 'reversal'
        ? { ...fields, kind: 'reversal', paidAt: paidAt.toISOString(), originalPaymentId: action.original.id }
        : { ...fields, kind: 'payment', paidAt: paidAt.toISOString() };
    const body = JSON.stringify(payload);
    if (pending.current?.body !== body) pending.current = { key: crypto.randomUUID(), body };
    submitting.current = true;
    setBusy(true);
    setError('');
    try {
      const response = await fetch(isInvoice ? '/api/finance/invoices' : '/api/finance', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': pending.current.key }, body,
      });
      const result = await response.json().catch(() => null) as { ok?: boolean; message?: string } | null;
      if (!response.ok || !result?.ok) throw new Error(result?.message || '登记未能确认，请保持表单内容重试');
      setNotice(action.kind === 'record' ? `${ledgerLabel}已登记。` : `${ledgerLabel}冲正已登记。`);
      pending.current = null;
      setAction(null);
      setPage(1);
      reload();
      onChange();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '登记未能确认，请保持表单内容重试');
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  return <dialog ref={dialogRef} className={`modal ${styles.dialog}`} aria-labelledby="finance-ledger-title" onCancel={(event) => {
    event.preventDefault();
    if (!busy) onClose();
  }}>
    <header className="modal-head">
      <div><h2 id="finance-ledger-title">采购财务台账</h2><p>{order ? `${order.orderNo} · ${order.supplierName}` : '读取采购单财务记录'}</p></div>
      <button type="button" aria-label="关闭采购财务台账" onClick={onClose} disabled={busy}>×</button>
    </header>
    {ledger?.error && <div className={styles.problem} role="alert"><span>{ledger.error}</span><button type="button" className="secondary-button" onClick={reload}>重试</button></div>}
    {!ledger && <p className={styles.empty} role="status">正在读取财务台账…</p>}
    {notice && <p className={styles.notice} role="status">{notice}</p>}
    <nav className={styles.ledgerTabs} aria-label="台账类型">
      <button type="button" aria-pressed={!isInvoice} disabled={busy} onClick={() => showLedger('payment')}>付款记录</button>
      <button type="button" aria-pressed={isInvoice} disabled={busy} onClick={() => showLedger('invoice')}>发票记录</button>
    </nav>
    {data && order && <div className={styles.ledgerBody}>
      <div className={styles.ledgerAmounts}>
        <div><span>采购单金额</span><strong>{financeAmount(order.orderedMinor, order.currency)}</strong></div>
        <div><span>净收货货值</span><strong>{financeAmount(order.receivedMinor, order.currency)}</strong></div>
        <div><span>登记发票净额</span><strong>{order.invoiceCount ? financeAmount(order.invoicedMinor, order.currency) : '暂无登记'}</strong></div>
        <div><span>登记净付款</span><strong>{order.paymentCount ? financeAmount(order.paidMinor, order.currency) : '暂无登记'}</strong></div>
        <div><span>应付余额</span><strong className={order.differenceMinor?.startsWith('-') ? styles.overpaid : undefined}>{financeAmount(order.differenceMinor, order.currency)}</strong></div>
      </div>
      {order.invoiceCount > 0 && <div className={styles.ledgerAmounts} aria-label="按原币核对发票差额">
        {([
          ['发票净额减采购单金额', order.invoiceOrderDifferenceMinor],
          ['发票净额减净收货货值', order.invoiceReceiptDifferenceMinor],
          ['发票净额减登记净付款', order.invoicePaymentDifferenceMinor],
        ] as const).map(([label, amount]) => <div key={label}><span>{label}</span><strong>{financeAmount(amount, order.currency)}</strong></div>)}
      </div>}
      <div className={styles.ledgerToolbar}>
        <div><strong>{statusLabels[order.status]}</strong><span>付款条款 {order.paymentTerms || '未填写'}</span></div>
        {canWrite && canRecord && <button className="primary-button" type="button" onClick={() => begin({ kind: 'record' })} disabled={busy}>{isInvoice ? '登记供应商发票' : '登记实际付款'}</button>}
      </div>

      {action && <form className={styles.paymentForm} onSubmit={submit} key={action.kind === 'record' ? ledgerKind : action.original.id}>
        <h3>{action.kind === 'reversal' ? `登记${ledgerLabel}冲正` : isInvoice ? '登记供应商发票' : '登记实际付款'}</h3>
        {action.kind === 'reversal' && <p>原单据 {action.original.reference}，可冲正 {financeAmount(action.original.reversibleMinor, order.currency)}</p>}
        <div className="form-grid">
          <label>金额（{order.currency}）<input name="amount" inputMode="decimal" required maxLength={14} placeholder="0.00" disabled={busy} /></label>
          <label>{isInvoice ? '单据日期' : '实际发生时间（北京时间）'}<input type={isInvoice ? 'date' : 'datetime-local'} name="occurredAt" required disabled={busy} /></label>
          <label>{isInvoice ? '发票或冲正单据编号' : '付款或冲正凭证编号'}<input name="reference" required maxLength={120} disabled={busy} /></label>
          <label>备注<input name="note" maxLength={500} disabled={busy} /></label>
        </div>
        <p>{action.kind === 'reversal' ? '请按已核对的冲正凭证填写，原单据会保留。' : `请按已核对的${isInvoice ? '供应商发票' : '实际付款凭证'}填写。`}</p>
        {error && <p className={styles.error} role="alert">{error}</p>}
        <div className={styles.formActions}>
          <button className="secondary-button" type="button" disabled={busy} onClick={() => { setAction(null); setError(''); }}>收起</button>
          <button className="primary-button" type="submit" disabled={busy}>{busy ? '登记中…' : action.kind === 'reversal' ? '确认冲正' : '确认登记'}</button>
        </div>
      </form>}

      <div className="table-wrap module-table">
        <table aria-label={`${ledgerLabel}与冲正记录`}><thead><tr>
          <th>{isInvoice ? '单据日期' : '发生时间（北京时间）'}</th><th>类型</th><th>金额</th><th>单据编号</th><th>登记人</th><th>操作</th>
        </tr></thead><tbody>{data.entries.length ? data.entries.map((entry) => <tr key={entry.id}>
          <td>{isInvoice ? entry.occurredAt : readDate(entry.occurredAt)}</td><td>{entry.kind === 'reversal' ? '冲正' : ledgerLabel}</td>
          <td>{financeAmount(entry.kind === 'reversal' ? `-${entry.amountMinor}` : entry.amountMinor, entry.currency)}</td>
          <td><strong>{entry.reference}</strong>{entry.originalReference && <small className="cell-sub">原凭证 {entry.originalReference}</small>}
            {entry.note && <small className="cell-sub" title={entry.note}>{entry.note}</small>}</td>
          <td>{entry.recordedBy}<small className="cell-sub">{readDate(entry.createdAt)}</small></td>
          <td>{canWrite && entry.reversibleMinor && entry.reversibleMinor !== '0' && <div className="row-actions">
            <button type="button" onClick={() => begin({ kind: 'reversal', original: entry })} disabled={busy}>冲正</button>
          </div>}</td>
        </tr>) : <tr><td colSpan={6} className="empty-cell">{page === 1 ? `暂无已登记${ledgerLabel}` : '当前页没有记录'}</td></tr>}</tbody></table>
      </div>
      {entryCount > data.pageSize && <PageButtons page={page} size={data.pageSize} total={entryCount} change={setPage} />}
    </div>}
  </dialog>;
}
