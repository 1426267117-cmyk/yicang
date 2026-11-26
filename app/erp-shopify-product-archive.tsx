'use client';

import { useState, type FormEvent } from 'react';
import type { ShopifyProductArchive } from '../lib/connectors/shopify/product-archive-read';
import type { StoreConnection } from './erp-operations';
import styles from './erp-shopify-product-archive.module.css';

type ArchiveLookup = {
  ok: true;
  readOnly: true;
  queriedAt: string;
  store: { key: StoreConnection['key']; name: string; domain: string };
  sku: string;
  product: ShopifyProductArchive | null;
};

const statusNames: Record<string, string> = { ACTIVE: '上架', ARCHIVED: '已归档', DRAFT: '草稿', UNLISTED: '未公开列出' };
const timeFormat = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'short' });

export default function ErpShopifyProductArchive({ stores, canSync }: { stores: StoreConnection[] | null; canSync: boolean }) {
  const [store, setStore] = useState('');
  const [sku, setSku] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copyNotice, setCopyNotice] = useState('');
  const [result, setResult] = useState<ArchiveLookup | null>(null);
  const connected = stores?.filter(({ credentialsConfigured, identityVerified, verifiedDomain, accessCapabilities }) =>
    credentialsConfigured && (identityVerified || verifiedDomain != null) && accessCapabilities?.products !== 'missing') ?? [];
  const selected = connected.find(({ key }) => key === store) ?? connected[0];

  function clearResult() {
    setError('');
    setCopyNotice('');
    setResult(null);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const exactSku = sku.trim();
    if (!canSync || !selected || !exactSku || busy) return;
    setBusy(true);
    clearResult();
    try {
      const response = await fetch('/api/connectors/shopify/product-archive', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store',
        body: JSON.stringify({ storeKey: selected.key, sku: exactSku }), signal: AbortSignal.timeout(30_000),
      });
      const body = await response.json().catch(() => null) as ArchiveLookup | { ok: false; message?: string } | null;
      if (!response.ok || !body?.ok || body.readOnly !== true || body.store.key !== selected.key || body.sku !== exactSku) {
        throw new Error(body && !body.ok ? body.message || '暂时无法读取 Shopify 商品资料' : '暂时无法读取 Shopify 商品资料');
      }
      setResult(body);
    } catch (failure) {
      setError(failure instanceof Error && failure.name !== 'TimeoutError' ? failure.message : '读取 Shopify 商品资料超时，请重试');
    } finally {
      setBusy(false);
    }
  }

  async function copyArchive(entry: ArchiveLookup, product: ShopifyProductArchive) {
    const pieces = [
      `${entry.store.name} · ${product.sku}`, product.productTitle, product.variantTitle,
      ...product.options.map(({ name, value }) => `${name} ${value}`), product.description, product.image?.url,
    ];
    try {
      await navigator.clipboard.writeText(pieces.filter(Boolean).join('\n'));
      setCopyNotice('商品资料已复制。');
    } catch {
      setCopyNotice('无法访问剪贴板，可选中资料复制。');
    }
  }

  const product = result?.product;
  const queriedAt = result ? Date.parse(result.queriedAt) : NaN;

  return <article className="ops-panel ops-list" aria-label="Shopify 商品资料查询">
    <div className="ops-panel-head"><h2>Shopify 商品资料</h2><span>只读查询</span></div>
    {!canSync ? <p className="ops-empty">有接入操作权限的管理员可查询店铺商品资料。</p> :
      <form className={`ops-filterline ${styles.form}`} onSubmit={(event) => { void submit(event); }}>
        <label>店铺 <select value={selected?.key ?? ''} disabled={!selected || busy} onChange={(event) => {
          setStore(event.target.value); clearResult();
        }}>
          {selected ? connected.map(({ key, displayName }) => <option key={key} value={key}>{displayName}</option>)
            : <option value="">{stores ? '暂无商品读取授权' : '正在读取接入状态'}</option>}
        </select></label>
        <label>店铺 SKU <input type="search" value={sku} maxLength={160} autoComplete="off" placeholder="输入完整 SKU"
          required disabled={!selected || busy} onChange={(event) => { setSku(event.target.value); clearResult(); }} /></label>
        <button className="secondary-button" type="submit" disabled={!selected || !sku.trim() || busy}>{busy ? '查询中…' : '查询商品资料'}</button>
      </form>}
    {error && <p className={styles.error} role="alert">{error}</p>}
    {result && !product && <p className="ops-empty" role="status">{result.store.name} 未找到完全匹配的 SKU。</p>}
    {result && product && <section className={styles.result} aria-label={`${product.sku} 商品资料`}>
      <header className={styles.productHead}>
        <div><h3>{product.productTitle || '商品名称待核'}</h3>
          <p>{result.store.name} · {product.sku} · {statusNames[product.productStatus] ?? product.productStatus}
            {Number.isFinite(queriedAt) && ` · ${timeFormat.format(queriedAt)}`}</p></div>
        <button className="secondary-button" type="button" onClick={() => { void copyArchive(result, product); }}>复制商品资料</button>
      </header>
      <dl className={styles.facts}>
        <div><dt>变体</dt><dd>{product.variantTitle || '—'}</dd></div>
        {product.options.map(({ name, value }, index) => <div key={`${name}-${index}`}><dt>{name}</dt><dd>{value}</dd></div>)}
        <div><dt>图片</dt><dd>{product.image
          ? <a className="link-button" href={product.image.url} target="_blank" rel="noopener noreferrer">
            {product.image.source === 'variant' ? '打开变体图片' : '打开商品图片'}</a> : '暂无可用链接'}</dd></div>
      </dl>
      {product.description && <details className={styles.description}><summary>商品描述</summary><p>{product.description}</p></details>}
      {copyNotice && <p className={styles.copyNotice} role="status">{copyNotice}</p>}
    </section>}
  </article>;
}
