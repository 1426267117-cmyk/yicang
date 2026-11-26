'use client';

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { QuoteSku, QuoteSupplier, SupplierQuote, SupplierQuoteBook, SupplierQuoteWrite } from '../lib/supplier-quotes';
import styles from './erp-supplier-quotes.module.css';

const statusLabels: Record<SupplierQuote['status'], string> = {
  available: '可采用', scheduled: '待生效', expired: '已过期', archived: '已停用', inactive: '商品或供应商停用', below_minimum: '未达起订量',
};
const dateTime = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'medium', timeStyle: 'short' });
const number = new Intl.NumberFormat('zh-CN');
type Overlay = { kind: 'publish'; quote?: SupplierQuote } | { kind: 'archive' | 'history'; quote: SupplierQuote };

function formattedMoney(value: string | number, currency: string) {
  const digits = String(value).padStart(3, '0');
  return `${currency} ${number.format(BigInt(digits.slice(0, -2)))}.${digits.slice(-2)}`;
}

function priceField(value: number) {
  const digits = String(value).padStart(3, '0');
  return `${digits.slice(0, -2)}.${digits.slice(-2)}`;
}

async function readResponse<T>(url: string, options: RequestInit = {}) {
  const response = await fetch(url, { cache: 'no-store', ...options });
  const data = await response.json().catch(() => null) as (T & { ok?: boolean; message?: string }) | null;
  if (!response.ok || !data?.ok) throw new Error(data?.message || '暂时无法读取报价');
  return data;
}

function useRead<T>(url: string | null, revision = 0) {
  const key = `${url}#${revision}`;
  const [state, setState] = useState<{ key: string; data?: T; error?: string }>();
  useEffect(() => {
    if (!url) return;
    const abort = new AbortController();
    void readResponse<T>(url, { signal: abort.signal }).then((data) => {
      if (!abort.signal.aborted) setState({ key, data });
    }).catch((cause: unknown) => {
      if (!abort.signal.aborted) setState({ key, error: cause instanceof Error ? cause.message : '读取报价失败' });
    });
    return () => abort.abort();
  }, [key, url]);
  return state?.key === key ? state : undefined;
}

function quoteUrl(params: Record<string, string>) {
  return `/api/purchase/quotes?${new URLSearchParams(params)}`;
}

export default function ErpSupplierQuotes({ suppliers, canRead, canManage }: {
  suppliers: readonly QuoteSupplier[];
  canRead: boolean;
  canManage: boolean;
}) {
  const [search, setSearch] = useState('');
  const [sku, setSku] = useState<QuoteSku | null>(null);
  const [quantity, setQuantity] = useState(1);
  const [revision, setRevision] = useState(0);
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const [notice, setNotice] = useState('');
  const skuResults = useRead<{ skus: QuoteSku[] }>(canRead ? `/api/purchase/skus?${new URLSearchParams({ q: search })}` : null);
  const book = useRead<SupplierQuoteBook>(canRead && sku ? quoteUrl({ skuId: sku.id, quantity: String(quantity) }) : null, revision);
  const data = book?.data;
  function reload(message?: string) {
    if (message) setNotice(message);
    setRevision((current) => current + 1);
    setOverlay(null);
  }

  return <section className={`card ${styles.book}`} aria-label="供应商报价">
    <header className="card-head">
      <div><h3>供应商报价</h3><p>按同一商品、采购量和原币比较报价。</p></div>
      {canRead && canManage && <button className="primary-button" type="button" disabled={!sku || !data || !suppliers.some((supplier) => supplier.active)}
        onClick={() => setOverlay({ kind: 'publish' })}>登记报价</button>}
    </header>
    {!canRead ? <p className={styles.notice}>当前账号无权查看采购报价。</p> : <>
      <div className={styles.filters}>
        <form className={styles.filterForm} onSubmit={(event) => {
          event.preventDefault();
          setSearch(String(new FormData(event.currentTarget).get('q') ?? '').trim());
        }}>
          <label>搜索商品<input name="q" type="search" placeholder="SKU 或商品名称" maxLength={160} /></label>
          <button className="secondary-button" type="submit">查找</button>
        </form>
        <label>选择 ERP 商品<select value={sku?.id ?? ''} onChange={(event) => {
          const next = skuResults?.data?.skus.find((item) => item.id === event.target.value);
          setSku(next ?? null);
          setNotice('');
        }}>
          <option value="">选择 SKU</option>
          {sku && !skuResults?.data?.skus.some((item) => item.id === sku.id) && <option value={sku.id}>{sku.code} · {sku.name}</option>}
          {skuResults?.data?.skus.map((item) => <option value={item.id} key={item.id}>{item.code} · {item.name}</option>)}
        </select></label>
        <form className={styles.filterForm} onSubmit={(event) => {
          event.preventDefault();
          const value = Number(new FormData(event.currentTarget).get('quantity'));
          if (Number.isSafeInteger(value) && value >= 1) setQuantity(value);
        }}>
          <label>比价数量<input name="quantity" type="number" min={1} max={Number.MAX_SAFE_INTEGER} defaultValue={1} step={1} required /></label>
          <button className="secondary-button" type="submit" disabled={!sku}>比价</button>
        </form>
      </div>
      {!skuResults && <p className={styles.notice} role="status">正在读取商品…</p>}
      {skuResults?.error && <p className={styles.error} role="alert">{skuResults.error}</p>}
      {skuResults?.data?.skus.length === 0 && <p className={styles.notice}>未找到匹配商品。</p>}
      {sku && !book && <p className={styles.notice} role="status">正在读取报价…</p>}
      {book?.error && <div className={styles.controls}><p className={styles.error} role="alert">{book.error}</p>
        <button className="secondary-button" type="button" onClick={() => reload()}>重试</button></div>}
      {notice && <p className={styles.notice} role="status">{notice}</p>}
      {data && <>
        <p className={styles.notice}>{data.sku.code} · {number.format(data.quantity)} 件 · 报价日期 {data.today}</p>
        <div className={`table-wrap ${styles.table}`}>
          <table aria-label="供应商报价比较"><thead><tr>
            <th>供应商</th><th>原币</th><th>适用单价</th><th>货值小计</th><th>数量阶梯</th><th>有效期</th><th>状态</th><th>操作</th>
          </tr></thead><tbody>{data.quotes.length ? data.quotes.map((row) => <tr key={row.id}>
            <td><strong>{row.supplier.name}</strong><small className="cell-sub">{row.supplier.code}{row.reference ? ` · ${row.reference}` : ''}</small></td>
            <td>{row.currency}</td><td>{row.matchedTier ? formattedMoney(row.matchedTier.unitCostMinor, row.currency) : '—'}
              {row.matchedVersion && row.matchedVersion !== row.version && <small className="cell-sub">现行版本 {row.matchedVersion}</small>}</td>
            <td>{row.totalMinor === null ? '—' : formattedMoney(row.totalMinor, row.currency)}</td>
            <td><TierList quote={row} /></td><td>{row.validFrom} 至 {row.validThrough || '长期'}</td>
            <td>{statusLabels[row.status]}<small className="cell-sub">版本 {row.version}</small></td>
            <td><div className="row-actions">
              <button type="button" onClick={() => setOverlay({ kind: 'history', quote: row })}>历史</button>
              {canManage && row.supplier.active && row.status !== 'inactive' && <button type="button" onClick={() => setOverlay({ kind: 'publish', quote: row })}>
                {row.status === 'archived' ? '重新启用' : '更新'}
              </button>}
              {canManage && row.status !== 'archived' && <button type="button" onClick={() => setOverlay({ kind: 'archive', quote: row })}>停用</button>}
            </div></td>
          </tr>) : <tr><td colSpan={8} className="empty-cell">该商品暂无已登记报价</td></tr>}</tbody></table>
        </div>
        {data.more && <p className={styles.notice}>当前显示前 200 组报价。</p>}
      </>}
      {sku && overlay && <QuoteDialog key={`${sku.id}:${overlay.kind}:${overlay.quote?.id ?? ''}`} overlay={overlay}
        sku={sku} today={data?.today ?? ''} suppliers={suppliers} close={() => setOverlay(null)} saved={reload} />}
    </>}
  </section>;
}

function TierList({ quote }: { quote: SupplierQuote }) {
  return <details><summary>{quote.tiers.length} 档，起订 {number.format(quote.tiers[0].minimumQuantity)} 件</summary>
    <ul className={styles.tiers}>{quote.tiers.map((tier) => <li key={tier.minimumQuantity}>
      {number.format(tier.minimumQuantity)} 件起 · {formattedMoney(tier.unitCostMinor, quote.currency)}
    </li>)}</ul>
  </details>;
}

function Modal({ title, description, close, busy, children }: {
  title: string; description: string; close: () => void; busy: boolean; children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog?.open) dialog?.showModal();
    return () => dialog?.close();
  }, []);
  return <dialog ref={ref} className={`modal ${styles.dialog}`} aria-labelledby="quote-dialog-title" onCancel={(event) => {
    event.preventDefault();
    if (!busy) close();
  }}>
    <header className="modal-head"><div><h2 id="quote-dialog-title">{title}</h2><p>{description}</p></div>
      <button type="button" aria-label="关闭报价窗口" disabled={busy} onClick={close}>×</button>
    </header>
    {children}
  </dialog>;
}

function QuoteDialog({ overlay, sku, today, suppliers, close, saved }: {
  overlay: Overlay; sku: QuoteSku; today: string; suppliers: readonly QuoteSupplier[]; close: () => void; saved: (message: string) => void;
}) {
  const quote = overlay.quote;
  const initialTiers = quote?.tiers.map((entry, index) => ({ id: index, qty: String(entry.minimumQuantity), price: priceField(entry.unitCostMinor) }))
    ?? [{ id: 0, qty: '1', price: '' }];
  const [rows, setRows] = useState(initialTiers);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const nextTier = useRef(initialTiers.length);
  const pending = useRef<{ key: string; body: string } | null>(null);
  const isHistory = overlay.kind === 'history';
  const isArchive = overlay.kind === 'archive';
  const history = useRead<SupplierQuoteBook>(isHistory && quote ? quoteUrl({ skuId: sku.id, supplierId: quote.supplier.id,
    currency: quote.currency, history: '1' }) : null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isHistory || submitting.current) return;
    const fields = new FormData(event.currentTarget);
    const text = (name: string) => String(fields.get(name) ?? '').trim();
    const base = { skuId: sku.id, supplierId: quote?.supplier.id ?? text('supplierId'),
      currency: quote?.currency ?? text('currency').toUpperCase(), expectedVersion: quote?.version ?? 0 };
    const tiers = rows.map((row) => {
      const rawPrice = /^(\d{1,9})(?:\.(\d{1,2}))?$/u.exec(text(`price:${row.id}`));
      return { minimumQuantity: Number(text(`qty:${row.id}`)),
        unitCostMinor: rawPrice ? Number(rawPrice[1]) * 100 + Number((rawPrice[2] ?? '').padEnd(2, '0')) : -1 };
    });
    if (!isArchive && tiers.some((entry, index) => !Number.isSafeInteger(entry.minimumQuantity) || entry.minimumQuantity < 1
      || entry.unitCostMinor < 0 || entry.unitCostMinor > 10_000_000_000
      || (index > 0 && entry.minimumQuantity <= tiers[index - 1].minimumQuantity))) {
      setError('请按从小到大的顺序填写起订量，单价最多两位小数。');
      return;
    }
    const input: SupplierQuoteWrite = isArchive ? { ...base, action: 'archive', reason: text('reason') }
      : { ...base, action: 'publish', validFrom: text('validFrom'), validThrough: text('validThrough') || null,
        tiers, reference: text('reference'), note: text('note') };
    const body = JSON.stringify(input);
    if (submitting.current) return;
    if (pending.current?.body !== body) pending.current = { key: crypto.randomUUID(), body };
    submitting.current = true;
    setBusy(true);
    setError('');
    try {
      await readResponse('/api/purchase/quotes', { method: 'POST', body, headers: {
        'Content-Type': 'application/json', 'Idempotency-Key': pending.current.key,
      } });
      saved(isArchive ? '报价已停用。' : '报价已保存。');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存结果未确认，请保持原填写内容重试。');
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  const title = isHistory ? '报价历史' : isArchive ? '停用报价' : quote ? '更新报价' : '登记报价';
  return <Modal title={title} description={`${sku.code} · ${sku.name}${quote ? ` · ${quote.supplier.name}` : ''}`} close={close} busy={busy}>
    {isHistory ? <div className={`${styles.dialogBody} table-wrap`}>
      {!history && <p role="status">正在读取历史版本…</p>}
      {history?.error && <p className={styles.error} role="alert">{history.error}</p>}
      {history?.data && <table aria-label="供应商报价历史"><thead><tr><th>版本</th><th>记录类型</th><th>币种与阶梯</th><th>有效期</th><th>登记</th><th>依据和备注</th></tr></thead>
        <tbody>{history.data.quotes.map((row) => <tr key={row.id}><td>{row.version}</td><td>{row.status === 'archived' ? '停用' : '发布'}</td>
          <td><TierList quote={row} /></td><td>{row.validFrom} 至 {row.validThrough ?? '长期'}</td>
          <td>{row.recordedBy}<small className="cell-sub">{dateTime.format(new Date(row.createdAt))}</small></td>
          <td>{row.reference || '—'}{row.note && <small className="cell-sub" title={row.note}>{row.note}</small>}</td></tr>)}</tbody></table>}
      {history?.data?.more && <p>当前显示最近 50 个版本。</p>}
    </div> : <form onSubmit={submit}>
      {isArchive ? <div className="form-grid"><label className="full">停用原因<input name="reason" maxLength={500} required disabled={busy} /></label></div> : <>
        <div className="form-grid">
          <label>供应商{quote ? <input value={quote.supplier.name} readOnly /> : <select name="supplierId" required disabled={busy}>
            <option value="">选择供应商</option>{suppliers.filter((supplier) => supplier.active).map((supplier) =>
              <option value={supplier.id} key={supplier.id}>{supplier.code} · {supplier.name}</option>)}
          </select>}</label>
          <label>原币<input name="currency" defaultValue={quote?.currency ?? 'CNY'} readOnly={Boolean(quote)} maxLength={3} pattern="[A-Za-z]{3}" required disabled={busy} /></label>
          <label>生效日期<input name="validFrom" type="date" defaultValue={quote?.validFrom ?? today} required disabled={busy} /></label>
          <label>截止日期<input name="validThrough" type="date" defaultValue={quote?.validThrough ?? ''} disabled={busy} /></label>
          <label>供应商报价单号<input name="reference" maxLength={120} defaultValue={quote?.reference ?? ''} disabled={busy} /></label>
          <label>备注<input name="note" maxLength={500} defaultValue={quote?.status !== 'archived' ? quote?.note ?? '' : ''} disabled={busy} /></label>
        </div>
        <div className={styles.tierEditor}>
          <strong>数量阶梯</strong>
          {rows.map((row, index) => <div className={`form-grid ${styles.tierRow}`} key={row.id}>
            <label>第 {index + 1} 档起订量<input name={`qty:${row.id}`} type="number" min={1} max={Number.MAX_SAFE_INTEGER}
              defaultValue={row.qty} required disabled={busy} /></label>
            <label>单价<input name={`price:${row.id}`} inputMode="decimal" defaultValue={row.price} required maxLength={12} placeholder="0.00" disabled={busy} /></label>
            <button className="secondary-button" type="button" disabled={busy || rows.length === 1}
              onClick={() => setRows(rows.filter((item) => item.id !== row.id))}>移除</button>
          </div>)}
          <button className="secondary-button" type="button" disabled={busy || rows.length >= 20}
            onClick={() => setRows([...rows, { id: nextTier.current++, qty: '', price: '' }])}>添加阶梯</button>
        </div>
      </>}
      {error && <p className={styles.error} role="alert">{error}</p>}
      <div className="modal-actions"><button type="button" onClick={close} disabled={busy}>取消</button>
        <button className="primary-button" type="submit" disabled={busy}>{busy ? '保存中…' : isArchive ? '确认停用' : '保存报价'}</button></div>
    </form>}
  </Modal>;
}

type ApplyProps = {
  skuId: string | null | undefined;
  supplierId: string | null | undefined;
  quantity: number | null | undefined;
  currency: string | null | undefined;
  disabled?: boolean;
  onApply: (quote: { unitCostMinor: number; currency: string; version: number; reference: string | null }) => void;
};

export function PurchaseQuoteApply(props: ApplyProps) {
  return <ApplyButton key={`${props.skuId}:${props.supplierId}:${props.quantity}:${props.currency}`} {...props} />;
}

function ApplyButton({ skuId, supplierId, quantity, currency, disabled, onApply }: ApplyProps) {
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  async function apply() {
    if (!skuId || !supplierId || !quantity || abort.current) return;
    const code = currency?.trim().toUpperCase();
    if (code && !/^[A-Z]{3}$/u.test(code)) {
      setStatus('请先填写三位字母币种。');
      return;
    }
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true);
    setStatus('');
    try {
      const result = await readResponse<SupplierQuoteBook>(quoteUrl({ skuId, supplierId, quantity: String(quantity),
        ...(code ? { currency: code } : {}) }), { signal: controller.signal });
      if (controller.signal.aborted) return;
      const matches = result.quotes.filter((quote) => quote.supplier.id === supplierId
        && quote.matchedTier !== null && quote.matchedVersion !== null && (!code || quote.currency === code));
      if (result.sku.id !== skuId || result.quantity !== quantity || result.more || matches.length !== 1) {
        setStatus(matches.length > 1 ? '存在多个可用币种，请先填写采购单币种。' : '当前供应商、原币和数量暂无可带入的有效报价。');
        return;
      }
      const [chosen] = matches;
      if (chosen.matchedTier === null || chosen.matchedVersion === null) return;
      onApply({ unitCostMinor: chosen.matchedTier.unitCostMinor, currency: chosen.currency, version: chosen.matchedVersion, reference: chosen.matchedReference });
      setStatus(`已带入版本 ${chosen.matchedVersion}${chosen.matchedReference ? ` · ${chosen.matchedReference}` : ''}`);
    } catch (cause) {
      if (!controller.signal.aborted) setStatus(cause instanceof Error ? cause.message : '暂时无法获取报价。');
    } finally {
      abort.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return <div className={styles.apply}>
    <button className="secondary-button" type="button" disabled={disabled || busy || !skuId || !supplierId
      || !quantity || !Number.isSafeInteger(quantity) || quantity < 1} onClick={() => void apply()}>
      {busy ? '查询中…' : '带入报价'}
    </button>{status && <small role="status">{status}</small>}
  </div>;
}
