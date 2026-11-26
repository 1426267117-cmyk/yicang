'use client';

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type {
  PaymentRequestAction, PaymentRequestCapacity, PaymentRequestDetails, PaymentRequestFilter, PaymentRequestList, PaymentRequestOrderList, RequestStatus,
} from '../lib/purchase-payment-requests';
import styles from './erp-purchase-payment-requests.module.css';

type ReviewAction = 'approve' | 'reject' | 'withdraw' | 'cancel';
type DetailAction = { type: ReviewAction | 'link' } | { type: 'unlink'; linkId: string };
const endpoint = '/api/finance/payment-requests';
const statusText: Record<RequestStatus, string> = { pending: '待审批', approved: '已审批', rejected: '已驳回', withdrawn: '已撤回', cancelled: '已取消' };
const filters: [PaymentRequestFilter, string][] = [
  ['all', '全部'], ['pending', '待审批'], ['outstanding', '已审批待结清'], ['settled', '已结清'],
  ['approved', '全部已审批'], ['rejected', '已驳回'], ['withdrawn', '已撤回'], ['cancelled', '已取消'],
];
const paymentStatusText = { unpaid: '未关联付款', partial: '部分结清', settled: '已结清' };
const typeText = { prepayment: '预付款', balance: '尾款' };
const actionText = { approve: '通过审批', reject: '驳回', withdraw: '撤回', cancel: '取消审批', link: '关联既有付款', unlink: '解除付款关联' };
const decimal = new Intl.NumberFormat('zh-CN');
const timestamp = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'medium', timeStyle: 'short' });

function money(value: string | null | undefined, currency: string | null | undefined) {
  if (value == null || !currency) return '待核';
  const negative = value.startsWith('-');
  const parts = value.replace(/^-/, '').padStart(3, '0');
  return `${currency} ${negative ? '−' : ''}${decimal.format(BigInt(parts.slice(0, -2)))}.${parts.slice(-2)}`;
}

function date(value: string | null | undefined) {
  if (!value) return '—';
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? '—' : timestamp.format(parsed);
}

function url(parameters: Record<string, string>) {
  return `${endpoint}?${new URLSearchParams(parameters)}`;
}

async function read<T>(target: string, options: RequestInit = {}) {
  const response = await fetch(target, { cache: 'no-store', ...options });
  const payload = await response.json().catch(() => null) as (T & { ok?: boolean; message?: string }) | null;
  if (!response.ok || !payload?.ok) throw new Error(payload?.message || '暂时无法处理请款数据。');
  return payload;
}

function useRead<T>(target: string | null, refresh = 0) {
  const key = `${target}#${refresh}`;
  const [result, setResult] = useState<{ key: string; data?: T; error?: string }>();
  useEffect(() => {
    if (!target) return;
    const abort = new AbortController();
    void read<T>(target, { signal: abort.signal }).then((data) => {
      if (!abort.signal.aborted) setResult({ key, data });
    }).catch((cause: unknown) => {
      if (!abort.signal.aborted) setResult({ key, error: cause instanceof Error ? cause.message : '读取失败。' });
    });
    return () => abort.abort();
  }, [key, target]);
  return result?.key === key ? result : undefined;
}

function useMutation() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const attempt = useRef<{ body: string; key: string } | null>(null);
  const active = useRef(false);
  async function submit(input: PaymentRequestAction) {
    if (active.current) return false;
    const body = JSON.stringify(input);
    if (attempt.current?.body !== body) attempt.current = { body, key: crypto.randomUUID() };
    active.current = true;
    setBusy(true);
    setError('');
    try {
      await read(endpoint, { method: 'POST', body, headers: {
        'Content-Type': 'application/json', 'Idempotency-Key': attempt.current.key,
      } });
      attempt.current = null;
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '结果未确认，请保留表单内容重试。');
      return false;
    } finally {
      active.current = false;
      setBusy(false);
    }
  }
  return { submit, busy, error, setError };
}

export default function ErpPurchasePaymentRequests({ canRead, canRequest, canReview }: {
  canRead: boolean; canRequest: boolean; canReview: boolean;
}) {
  const [filter, setFilter] = useState<PaymentRequestFilter>('pending');
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [page, setPage] = useState(1);
  const [refresh, setRefresh] = useState(0);
  const [dialog, setDialog] = useState<{ kind: 'create' } | { kind: 'detail'; id: string } | null>(null);
  const [notice, setNotice] = useState('');
  const list = useRead<PaymentRequestList>(canRead ? url({ view: 'requests', status: filter, q: search, page: String(page) }) : null, refresh);
  const data = list?.data;

  function reload(message?: string) {
    if (message) setNotice(message);
    setRefresh((value) => value + 1);
  }

  return <section className={`card data-card ${styles.workspace}`} aria-label="采购请款">
    <header className={styles.toolbar}>
      <h2>{canReview ? '采购请款' : '我的请款'}</h2>
      {canRead && <form className={styles.controls} onSubmit={(event) => {
        event.preventDefault(); setSearch(searchInput.trim()); setPage(1);
      }}>
        <label className={styles.statusFilter}>状态<select value={filter} onChange={(event) => { setFilter(event.target.value as PaymentRequestFilter); setPage(1); }}>
          {filters.map(([value, label]) => <option value={value} key={value}>{label}</option>)}
        </select></label>
        <input type="search" aria-label="采购单号或供应商" placeholder="采购单号或供应商" value={searchInput} maxLength={120}
          onChange={(event) => setSearchInput(event.target.value)} />
        <button className="secondary-button" type="submit">查询</button>
        <button className="secondary-button" type="button" onClick={() => reload()} disabled={!list}>刷新</button>
        {canRequest && <button className="primary-button" type="button" onClick={() => setDialog({ kind: 'create' })}>发起请款</button>}
      </form>}
    </header>
    {!canRead ? <p className={`${styles.notice} ${styles.message}`}>当前账号无采购请款权限。</p> : <>
      {notice && <p className={`${styles.notice} ${styles.message}`} role="status">{notice}</p>}
      {!list && <p className={`${styles.notice} ${styles.message}`} role="status">正在读取请款…</p>}
      {list?.error && <p className={`${styles.error} ${styles.message}`} role="alert">{list.error}</p>}
      {data && <div className={`table-wrap module-table ${styles.table} ${styles.requestList}`}>
        <table aria-label="采购请款清单"><thead><tr>
          <th>采购单 / 供应商</th><th>申请人</th><th>类型</th><th>请款金额</th><th>计划付款日</th><th>审批状态</th><th>付款进度</th><th>操作</th>
        </tr></thead><tbody>{data.requests.length ? data.requests.map((request) => <tr key={request.id}>
          <td><strong>{request.orderNo}</strong><small className="cell-sub">{request.supplier}</small></td>
          <td>{request.requestedBy}</td><td>{typeText[request.businessType]}</td><td>{money(request.amountMinor, request.currency)}</td><td>{request.dueOn}</td>
          <td><span className={styles.status} data-state={request.status}>{statusText[request.status]}</span></td>
          <td>{request.paymentStatus ? <>
            <span className={styles.status} data-state={request.paymentStatus}>{paymentStatusText[request.paymentStatus]}</span>
            {request.paymentStatus !== 'settled' && <small className="cell-sub">待结清 {money(request.outstandingMinor, request.currency)}</small>}
            {request.paymentStatus !== 'unpaid' && <small className="cell-sub">已关联 {money(request.linkedMinor, request.currency)}</small>}
          </> : '—'}</td>
          <td><div className="row-actions"><button type="button" onClick={() => setDialog({ kind: 'detail', id: request.id })}>查看请款</button></div></td>
        </tr>) : <tr><td className="empty-cell" colSpan={8}>当前筛选下暂无请款</td></tr>}</tbody></table>
      </div>}
      {data && (page > 1 || data.hasNext) && <Pagination page={page} hasNext={data.hasNext} setPage={setPage} />}
      {dialog?.kind === 'create' && <CreateDialog close={() => setDialog(null)} created={() => {
        setDialog(null); setPage(1); setFilter('pending'); setSearch(''); setSearchInput(''); reload('请款已提交，待审批。');
      }} />}
      {dialog?.kind === 'detail' && <DetailsDialog key={dialog.id} requestId={dialog.id} close={() => setDialog(null)} changed={reload} />}
    </>}
  </section>;
}

function Pagination({ page, hasNext, setPage }: { page: number; hasNext: boolean; setPage: (page: number) => void }) {
  return <div className={styles.pagination}>
    <small>第 {page} 页</small>
    <button className="secondary-button" type="button" disabled={page === 1} onClick={() => setPage(page - 1)}>上一页</button>
    <button className="secondary-button" type="button" disabled={!hasNext} onClick={() => setPage(page + 1)}>下一页</button>
  </div>;
}

function Dialog({ title, subtitle, busy, close, children }: { title: string; subtitle?: string; busy: boolean; close: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog?.open) dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return <dialog ref={ref} className={`modal ${styles.dialog}`} aria-labelledby="payment-request-title" onCancel={(event) => {
    event.preventDefault();
    if (!busy) close();
  }}>
    <header className="modal-head"><div><h2 id="payment-request-title">{title}</h2>{subtitle && <p>{subtitle}</p>}</div>
      <button type="button" aria-label="关闭请款窗口" onClick={close} disabled={busy}>×</button></header>
    {children}
  </dialog>;
}

function CreateDialog({ close, created }: { close: () => void; created: () => void }) {
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [selection, setSelection] = useState<PaymentRequestOrderList['orders'][number] | null>(null);
  const [refresh, setRefresh] = useState(0);
  const ledger = useMutation();
  const orders = useRead<PaymentRequestOrderList>(url({ view: 'orders', q: search, page: String(page) }));
  const capacity = useRead<PaymentRequestCapacity>(selection ? url({ view: 'capacity', orderId: selection.id }) : null, refresh);
  const current = capacity?.data;
  const data = orders?.data;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selection || !current?.canRequest || !current.order.currency) return;
    const form = new FormData(event.currentTarget);
    const text = (name: string) => String(form.get(name) ?? '').trim();
    const value = /^(\d{1,11})(?:\.(\d{1,2}))?$/u.exec(text('amount'));
    const amountMinor = value ? Number(value[1]) * 100 + Number((value[2] ?? '').padEnd(2, '0')) : 0;
    if (amountMinor <= 0 || amountMinor > 1_000_000_000_000 || BigInt(amountMinor) > BigInt(current.availableMinor ?? '0')) {
      ledger.setError('请核对可请款额度，金额须大于零且最多两位小数。');
      return;
    }
    if (await ledger.submit({ action: 'create', orderId: selection.id, amountMinor, currency: current.order.currency,
      dueOn: text('dueOn'), reason: text('reason'), reference: text('reference'), businessType: text('businessType') === 'balance' ? 'balance' : 'prepayment' })) {
      created();
    }
  }

  return <Dialog title="发起采购请款" subtitle="仅限已下单且有完整原币金额的采购单。" busy={ledger.busy} close={close}>
    <div className={styles.body}>
      <form className={styles.controls} onSubmit={(event) => {
        event.preventDefault();
        setSearch(String(new FormData(event.currentTarget).get('q') ?? '').trim());
        setPage(1);
      }}>
        <label>查找采购单<input name="q" type="search" placeholder="单号或供应商" maxLength={120} disabled={ledger.busy} /></label>
        <button className="secondary-button" type="submit" disabled={ledger.busy}>查找</button>
      </form>
      {!orders && <p className={styles.notice} role="status">正在读取采购单…</p>}
      {orders?.error && <p className={styles.error} role="alert">{orders.error}</p>}
      {data && <label className={styles.orderSelect}>采购单<select value={selection?.id ?? ''} disabled={ledger.busy} onChange={(event) => {
        setSelection(data.orders.find((order) => order.id === event.target.value) ?? null);
        ledger.setError('');
      }}>
        <option value="">选择采购单</option>
        {selection && !data.orders.some((order) => order.id === selection.id) && <option value={selection.id}>{selection.orderNo} · {selection.supplier}</option>}
        {data.orders.map((order) => <option value={order.id} key={order.id}>{order.orderNo} · {order.supplier} · {order.currency}</option>)}
      </select></label>}
      {data && (page > 1 || data.hasNext) && <Pagination page={page} hasNext={data.hasNext} setPage={setPage} />}
      {data?.orders.length === 0 && <p className={styles.notice}>未找到符合条件的采购单。</p>}
      {selection && !capacity && <p className={styles.notice} role="status">正在核对请款额度…</p>}
      {capacity?.error && <p className={styles.error} role="alert">{capacity.error}</p>}
      {selection && capacity && <div className={styles.controls}>
        {current && <span>采购单金额 {money(current.orderMinor, current.order.currency)} · 可请款 {money(current.availableMinor, current.order.currency)}</span>}
        <button className="secondary-button" type="button" disabled={ledger.busy} onClick={() => setRefresh((value) => value + 1)}>刷新额度</button>
      </div>}
      {current && !current.canRequest && <p className={styles.notice}>当前采购单无可用额度，或原币金额待核。</p>}
    </div>
    {selection && <form onSubmit={submit} key={selection.id}>
      <div className="form-grid">
        <label>款项类型<select name="businessType" required disabled={ledger.busy}><option value="prepayment">预付款</option><option value="balance">尾款</option></select></label>
        <label>请款金额（{selection.currency}）<input name="amount" inputMode="decimal" maxLength={14} placeholder="0.00" required disabled={ledger.busy} /></label>
        <label>计划付款日<input name="dueOn" type="date" required disabled={ledger.busy} /></label>
        <label>依据编号<input name="reference" maxLength={120} placeholder="合同或账单编号" disabled={ledger.busy} /></label>
        <label className="full">用途<input name="reason" required maxLength={500} disabled={ledger.busy} /></label>
      </div>
      {ledger.error && <p className={`${styles.error} ${styles.formError}`} role="alert">{ledger.error}</p>}
      <div className="modal-actions"><button type="button" onClick={close} disabled={ledger.busy}>取消</button>
        <button className="primary-button" type="submit" disabled={ledger.busy || !current?.canRequest}>{ledger.busy ? '正在提交…' : '提交审批'}</button></div>
    </form>}
  </Dialog>;
}

function DetailsDialog({ requestId, close, changed }: { requestId: string; close: () => void; changed: () => void }) {
  const [refresh, setRefresh] = useState(0);
  const result = useRead<PaymentRequestDetails>(url({ view: 'detail', requestId }), refresh);
  const detail = result?.data;
  const request = detail?.request;
  const [action, setAction] = useState<DetailAction | null>(null);
  const [notice, setNotice] = useState('');
  const ledger = useMutation();

  function choose(next: DetailAction) {
    setAction(next);
    setNotice('');
    ledger.setError('');
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!request || !action) return;
    const form = new FormData(event.currentTarget);
    const expected = { requestId, expectedVersion: request.version };
    const note = String(form.get('note') ?? '').trim();
    const input: PaymentRequestAction = action.type === 'link' ? { ...expected, action: 'link', paymentId: String(form.get('paymentId') ?? '') }
      : action.type === 'unlink' ? { ...expected, action: 'unlink', linkId: action.linkId, note } : { ...expected, action: action.type, note };
    if (await ledger.submit(input)) {
      setAction(null);
      setNotice(`${actionText[action.type]}已记录。`);
      setRefresh((value) => value + 1);
      changed();
    }
  }

  return <Dialog title="采购请款详情" subtitle={request ? `${request.orderNo} · ${request.supplier}` : undefined} busy={ledger.busy} close={close}>
    <div className={styles.body}>
      {!result && <p className={styles.notice} role="status">正在读取请款详情…</p>}
      {result?.error && <p className={styles.error} role="alert">{result.error}</p>}
      {notice && <p className={styles.notice} role="status">{notice}</p>}
      {detail && request && <>
        <dl className={styles.facts}>
          <div><dt>请款金额</dt><dd>{money(request.amountMinor, request.currency)}</dd></div>
          <div><dt>类型 / 计划付款日</dt><dd>{typeText[request.businessType]} · {request.dueOn}</dd></div>
          <div><dt>审批状态</dt><dd>{statusText[request.status]}</dd></div>
          {request.paymentStatus && <>
            <div><dt>付款进度</dt><dd>{paymentStatusText[request.paymentStatus]}</dd></div>
            <div><dt>已关联净付款</dt><dd>{money(request.linkedMinor, request.currency)}</dd></div>
            <div><dt>待结清金额</dt><dd>{money(request.outstandingMinor, request.currency)}</dd></div>
          </>}
        </dl>
        <div className={styles.summary}>用途 {request.reason}{request.reference && ` · 依据 ${request.reference}`}</div>
        <p className={styles.notice}>提交 {request.requestedBy} · {date(request.createdAt)}</p>
        {request.reviewedBy && <p className={styles.notice}>审批 {request.reviewedBy} · {date(request.reviewedAt)}{request.reviewNote && ` · ${request.reviewNote}`}</p>}
        {request.closedBy && <p className={styles.notice}>处理 {request.closedBy} · {date(request.closedAt)}{request.closeNote && ` · ${request.closeNote}`}</p>}
      <div className={styles.controls}>
          {request.canReview && <><button className="primary-button" type="button" disabled={ledger.busy} onClick={() => choose({ type: 'approve' })}>通过审批</button>
            <button className="secondary-button" type="button" disabled={ledger.busy} onClick={() => choose({ type: 'reject' })}>驳回</button></>}
          {request.canWithdraw && <button className="secondary-button" type="button" disabled={ledger.busy} onClick={() => choose({ type: 'withdraw' })}>撤回</button>}
          {request.canCancel && <button className="secondary-button" type="button" disabled={ledger.busy} onClick={() => choose({ type: 'cancel' })}>取消审批</button>}
          {request.canLink && detail.candidates.length > 0 && <button className="secondary-button" type="button" disabled={ledger.busy}
            onClick={() => choose({ type: 'link' })}>关联既有付款</button>}
        </div>
        {request.canLink && <p className={styles.notice}>实际付款在财务台账登记。{detail.candidates.length === 0 ? '当前没有符合关联条件的付款。' : '可选择同一采购单的已登记付款关联。'}</p>}
        {action && <form className={styles.operation} onSubmit={submit} key={action.type === 'unlink' ? action.linkId : action.type}>
          <strong>{actionText[action.type]}</strong>
          {action.type === 'approve' && <p className={styles.notice}>审批通过后保留请款额度。实际付款由财务核对后登记。</p>}
          <div className="form-grid">
            {action.type === 'link' ? <label className="full">实际付款<select name="paymentId" disabled={ledger.busy} required>
              <option value="">选择已有付款</option>{detail.candidates.map((payment) => <option key={payment.id} value={payment.id}>
                {payment.reference} · {money(payment.netMinor, request.currency)} · {date(payment.paidAt)}
              </option>)}
            </select></label> : <label className="full">{action.type === 'approve' ? '审批意见' : '原因'}
              <input name="note" maxLength={500} required={action.type !== 'approve'} disabled={ledger.busy} /></label>}
          </div>
          {ledger.error && <p className={styles.error} role="alert">{ledger.error}</p>}
          <div className={styles.controls}><button className="secondary-button" type="button" disabled={ledger.busy} onClick={() => setAction(null)}>返回</button>
            <button className="primary-button" type="submit" disabled={ledger.busy}>{ledger.busy ? '正在保存…' : `确认${actionText[action.type]}`}</button></div>
        </form>}
        {detail.linked.length > 0 && <div className={`table-wrap ${styles.table}`}><table aria-label="付款关联记录"><thead><tr>
          <th>付款凭证</th><th>净付款</th><th>关联时间</th><th>状态</th><th>操作</th>
        </tr></thead><tbody>{detail.linked.map((link) => <tr key={link.id}><td>{link.reference || '—'}</td>
          <td>{money(link.netMinor, request.currency)}</td><td>{date(link.linkedAt)}</td><td>{link.detachedAt ? '已解除' : '已关联'}</td>
          <td>{request.canLink && !link.detachedAt && <div className="row-actions"><button type="button" disabled={ledger.busy}
            onClick={() => choose({ type: 'unlink', linkId: link.id })}>解除关联</button></div>}</td></tr>)}</tbody></table></div>}
      </>}
    </div>
  </Dialog>;
}
