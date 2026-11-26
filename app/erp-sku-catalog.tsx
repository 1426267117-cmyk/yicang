'use client';

import { useEffect, useState } from 'react';
import { skuCatalogFieldKeys, skuCatalogFields, skuCatalogPageSize, type SkuCatalogEntry, type SkuCatalogFilter, type SkuCatalogPage } from '../lib/purchase-sku-catalog';
import { PurchaseProductImageLink } from './erp-purchase-product-fields';
import styles from './erp-sku-catalog.module.css';

type CatalogResponse = { ok: true } & SkuCatalogPage;

export default function ErpSkuCatalog({ canManage, busy, refreshVersion, onAdd, onEdit, onImport }: {
  canManage: boolean;
  busy: boolean;
  refreshVersion: number;
  onAdd: () => void;
  onEdit: (sku: SkuCatalogEntry) => void;
  onImport: () => void;
}) {
  const [term, setTerm] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<SkuCatalogFilter>('all');
  const [page, setPage] = useState(1);
  const [retry, setRetry] = useState(0);
  const [result, setResult] = useState<{ requestKey: string; url: string; data?: CatalogResponse; error?: string }>();
  const params = new URLSearchParams({ q: query, filter, page: String(page) });
  const url = `/api/purchase/skus/catalog?${params}`;
  const requestKey = `${url}:${refreshVersion}:${retry}`;
  const data = result?.url === url ? result.data : undefined;
  const error = result?.requestKey === requestKey ? result.error : undefined;
  const loading = result?.requestKey !== requestKey;
  const pageCount = Math.max(1, Math.ceil((data?.total ?? 0) / skuCatalogPageSize));

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(url, { cache: 'no-store', signal: controller.signal });
        const body = await response.json().catch(() => null) as CatalogResponse | { ok: false; message?: string } | null;
        if (!response.ok || !body?.ok) throw new Error(body && !body.ok && body.message || '无法加载商品档案');
        if (controller.signal.aborted) return;
        const lastPage = Math.max(1, Math.ceil(body.total / skuCatalogPageSize));
        if (page > lastPage) setPage(lastPage);
        else setResult({ requestKey, url, data: body });
      } catch (cause) {
        if (!controller.signal.aborted) {
          setResult({ requestKey, url, error: cause instanceof Error ? cause.message : '无法加载商品档案' });
        }
      }
    })();
    return () => controller.abort();
  }, [page, requestKey, url]);

  return <section aria-label="商品档案明细">
    <div className={styles.toolbar}>
      <form className={styles.filters} role="search" aria-label="筛选商品档案" onSubmit={event => {
        event.preventDefault();
        setPage(1);
        setQuery(term.trim());
      }}>
        <label className={styles.search}>
          <span className={styles.visuallyHidden}>SKU 或商品名称</span>
          <input type="search" value={term} onChange={event => setTerm(event.currentTarget.value)} maxLength={160} placeholder="SKU 或商品名称" />
        </label>
        <button type="submit" className="secondary-button">搜索</button>
        <label className={styles.statusFilter}>资料状态
          <select value={filter} onChange={event => {
            setFilter(event.currentTarget.value as SkuCatalogFilter);
            setPage(1);
          }}>
            <option value="all">全部</option>
            <option value="incomplete">资料待补</option>
            <option value="complete">资料齐全</option>
            {skuCatalogFieldKeys.map(field => <option key={field} value={field}>缺{skuCatalogFields[field]}</option>)}
          </select>
        </label>
        {(term || query || filter !== 'all') && <button type="button" className="procurement-text-button" onClick={() => {
          setTerm('');
          setQuery('');
          setFilter('all');
          setPage(1);
        }}>清除筛选</button>}
      </form>
      {canManage && <div className={styles.actions}>
        <button type="button" className="secondary-button" onClick={onImport} disabled={busy}>批量导入</button>
        <button type="button" className="primary-button" onClick={onAdd} disabled={busy}>新增 SKU</button>
      </div>}
    </div>
    {error ? <div className={styles.empty}>
      <p role="alert">{error}</p><button className="secondary-button" type="button" onClick={() => setRetry(value => value + 1)}>重试</button>
    </div> : <>
      <div className={styles.resultBar}>
        <span role="status">{loading ? '正在加载商品档案…' : `共 ${data?.total.toLocaleString('zh-CN') ?? 0} 个 SKU`}</span>
        {canManage && !loading && Boolean(data?.skus.length) &&
          <a className="secondary-button" href={`${url}&format=xlsx`} download title="补录表仅预填 SKU 编码和参考资料，填写后可批量导入">导出本页补录表</a>}
      </div>
      <div className="module-table" role="region" aria-label="商品资料表" aria-busy={loading} tabIndex={0}>
        <table className={styles.table}>
          <thead><tr>
            <th scope="col">SKU</th><th scope="col">商品名称</th><th scope="col">规格</th><th scope="col">尺寸</th>
            <th scope="col">图片</th><th scope="col">商品介绍</th><th scope="col">资料状态</th>{canManage && <th scope="col">操作</th>}
          </tr></thead>
          <tbody>
            {data?.skus.map(sku => <tr key={sku.id}>
              <td className={styles.code}>{sku.code}</td><td>{sku.name}</td><td>{sku.productDetails.specification?.trim() || '—'}</td>
              <td>{sku.productDetails.dimensions?.trim() || '—'}</td><td>{sku.productDetails.imageUrl ? <PurchaseProductImageLink value={sku.productDetails.imageUrl} /> : '—'}</td>
              <td><span className={styles.description} title={sku.productDetails.description ?? undefined}>{sku.productDetails.description?.trim() || '—'}</span></td>
              <td className={sku.missingFields.length ? styles.incomplete : styles.complete}>{sku.missingFields.length ? `缺${sku.missingFields.map(field => skuCatalogFields[field]).join('、')}` : '齐全'}</td>
              {canManage && <td><button type="button" className="procurement-text-button" onClick={() => onEdit(sku)} disabled={busy || loading} aria-label={`编辑 ${sku.code}`}>编辑</button></td>}
            </tr>)}
            {!data?.skus.length && <tr><td colSpan={canManage ? 8 : 7} className="empty-cell">{loading ? '加载中' : '没有符合当前条件的商品'}</td></tr>}
          </tbody>
        </table>
      </div>
      {pageCount > 1 && <nav className={styles.pagination} aria-label="商品档案分页">
        <button type="button" className="secondary-button" disabled={page <= 1 || loading} onClick={() => setPage(value => value - 1)}>上一页</button>
        <span>第 {page} / {pageCount} 页</span>
        <button type="button" className="secondary-button" disabled={page >= pageCount || loading} onClick={() => setPage(value => value + 1)}>下一页</button>
      </nav>}
    </>}
  </section>;
}
