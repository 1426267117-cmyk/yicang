'use client';

import { useState, type FormEvent } from 'react';
import ErpNineStoreOrders, { type NineStoreWorkflow } from './erp-nine-store-orders';
import FeishuPurchasePreview from './feishu-purchase-preview';
import ErpOpeningStock from './erp-opening-stock';

const files = {
  orders: { label: '历史订单', caption: '按平台单号保留导入前的订单和退款。', path: '/api/nine-store-orders/import', limit: 2_500_000, size: '2.5 MB' },
  purchase: { label: '采购与库存资料', caption: '查看开账前的销量、分仓库存和在途资料。', path: '/api/purchase/feishu-preview', limit: 786_432, size: '768 KiB' },
} as const;
type DataType = keyof typeof files | 'stock';
const views: { key: DataType; label: string }[] = [
  { key: 'orders', label: '历史订单' }, { key: 'purchase', label: '采购与库存资料' }, { key: 'stock', label: '期初库存建账' },
];

export default function OpeningData({ query, setQuery, workflow, onStockSetup, onStockChanged }: {
  query: string; setQuery: (value: string) => void; workflow: NineStoreWorkflow; onStockSetup: () => void; onStockChanged: () => void;
}) {
  const [tab, setTab] = useState<DataType>('orders');
  const [file, setFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [feedback, setFeedback] = useState<{ message: string; error: boolean }>();
  const [version, setVersion] = useState(0);
  const current = tab === 'stock' ? null : files[tab];

  async function importFile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (loading || !file || !current) return;
    if (!file.size || file.size > current.limit || !file.name.toLowerCase().endsWith('.json')) {
      setFeedback({ message: `请选择小于 ${current.size} 的预处理 JSON 文件。`, error: true });
      return;
    }
    const form = event.currentTarget;
    setLoading(true);
    setFeedback(undefined);
    try {
      const response = await fetch(current.path, { method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' }, body: file, signal: AbortSignal.timeout(25_000) });
      const result = await response.json().catch(() => null) as { ok?: boolean; message?: string; replayed?: boolean } | null;
      if (!response.ok || !result?.ok) throw new Error(result?.message || '文件未导入，请核对格式与业务范围。');
      setFeedback({ message: result.replayed ? '该批资料已在库，可直接查询。' : '补录成功，已重新读取。', error: false });
      form.reset();
      setFile(null);
      setVersion((value) => value + 1);
    } catch (failure) {
      setFeedback({ message: failure instanceof Error ? failure.message : '导入结果待确认，请重试查验。', error: true });
    } finally {
      setLoading(false);
    }
  }

  return <div className="content ops-page ops-opening">
    <div className="ops-heading"><div><h1>期初导入</h1><p>开账前或资料缺失时，一次性补录历史订单、库存和采购资料。</p></div></div>
    <article className="ops-panel">
      <div className="ops-tabbar" aria-label="期初数据类别">{views.map(({ key, label }) =>
        <button type="button" key={key} aria-pressed={key === tab} disabled={loading} onClick={() => {
          setTab(key); setFile(null); setFeedback(undefined); setQuery('');
        }}>{label}</button>)}</div>
      {current && <>
      <div className="ops-panel-head"><h2>{current.label}</h2><span>{current.caption}</span></div>
      <details className="ops-import-panel">
        <summary>补录已整理资料</summary>
        <form onSubmit={(event) => void importFile(event)} key={tab}>
          <label>预处理文件（JSON，最大 {current.size}）<input type="file" accept=".json,application/json" disabled={loading} required
            onChange={(event) => setFile(event.target.files?.[0] ?? null)} /></label>
          <button className="primary-button" type="submit" disabled={!file || loading}>{loading ? '正在补录…' : '确认补录'}</button>
        </form>
        {feedback && <p role={feedback.error ? 'alert' : 'status'}>{feedback.message}</p>}
      </details>
      </>}
    </article>
    {tab === 'orders' ? <ErpNineStoreOrders key={`orders-${version}`} query={query} workflow={{ ...workflow, canCreate: false }} archived />
      : tab === 'purchase' ? <article className="ops-panel ops-list"><FeishuPurchasePreview key={`purchase-${version}`} query={query} onQueryChange={setQuery} purchaseContext={{}} archived /></article>
        : <ErpOpeningStock query={query} onSetup={onStockSetup} onChange={onStockChanged} />}
  </div>;
}
