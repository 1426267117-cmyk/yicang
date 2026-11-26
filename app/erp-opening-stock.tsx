'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';

type Region = 'CA' | 'GA' | 'NJ';
type OpeningRow = { sku: string; region: Region; quantity: number | null; skuId: string | null;
  warehouseId: string | null; warehouseName: string | null; status: 'ready' | 'source_unverified' | 'sku_unmapped' | 'warehouse_unmapped' | 'already_initialized' };
type Data = { ok: true; snapshot: { date: string; version: string; importedAt: string } | null; rows: OpeningRow[]; hasNext: boolean };
type Preview = { requestKey: string; data?: Data; error?: string };
type Candidate = { row: OpeningRow; version: string; key: string };
const statuses: Record<OpeningRow['status'], string> = {
  ready: '待确认建账', source_unverified: '库存归属待核', sku_unmapped: '缺少商品档案', warehouse_unmapped: '缺少对应仓库', already_initialized: '已有库存账',
};

export default function ErpOpeningStock({ query, onSetup, onChange }: { query: string; onSetup: () => void; onChange: () => void }) {
  const [region, setRegion] = useState('');
  const [cursor, setCursor] = useState({ key: '', page: 1 });
  const [preview, setPreview] = useState<Preview>();
  const [refresh, setRefresh] = useState(0);
  const [candidate, setCandidate] = useState<Candidate | null>(null);
  const search = query.trim().slice(0, 100);
  const filter = JSON.stringify([search, region]);
  const page = cursor.key === filter ? cursor.page : 1;
  const requestKey = JSON.stringify([filter, page, refresh]);
  const current = preview?.requestKey === requestKey ? preview : undefined;

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({ page: String(page) });
    if (search) params.set('q', search);
    if (region) params.set('region', region);
    async function read() {
      try {
        const response = await fetch(`/api/warehouse/opening-stock?${params}`, { cache: 'no-store',
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12_000)]) });
        const data = await response.json() as Data & { message?: string };
        if (!response.ok || !data.ok || !Array.isArray(data.rows)) throw new Error(data.message || '期初库存读取失败');
        if (!controller.signal.aborted) setPreview({ requestKey, data });
      } catch (failure) {
        if (!controller.signal.aborted) setPreview({ requestKey, error: failure instanceof Error ? failure.message : '期初库存读取失败' });
      }
    }
    const timer = window.setTimeout(() => { void read(); }, 150);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [region, search, page, requestKey]);

  return <article className="ops-panel ops-list">
    <div className="ops-panel-head"><h2>期初库存审核</h2><span>{current?.data?.snapshot ? `资料日期 ${current.data.snapshot.date}` : '按公司与仓库建账'}</span></div>
    <div className="ops-filterline"><label>仓库<select value={region} onChange={(event) => setRegion(event.target.value)}>
      <option value="">全部</option><option value="CA">CA</option><option value="GA">GA</option><option value="NJ">NJ</option>
    </select></label><button className="secondary-button" type="button" onClick={onSetup}>管理商品和仓库</button></div>
    {current?.error ? <div className="ops-empty" role="alert">{current.error} <button className="link-button" type="button" onClick={() => setRefresh((value) => value + 1)}>重试</button></div>
      : <div className="table-wrap ops-table"><table><thead><tr><th>SKU</th><th>ERP 仓库</th><th>数量</th><th>建账状态</th><th>操作</th></tr></thead>
        <tbody>{current?.data?.rows.length ? current.data.rows.map((row) => <tr key={`${row.sku}-${row.region}`}>
          <td>{row.sku}</td><td>{row.warehouseName ?? row.region}</td><td>{row.quantity ?? '待核'}</td>
          <td><span className={`ops-state ops-state-${row.status === 'ready' ? 'info' : row.status === 'already_initialized' ? 'success' : 'muted'}`}>{statuses[row.status]}</span></td>
          <td>{row.status === 'ready' && current.data?.snapshot ? <button type="button" className="link-button" onClick={() => {
            const version = current.data?.snapshot?.version;
            if (version) setCandidate({ row, version, key: crypto.randomUUID() });
          }}>审核建账</button> : '—'}</td></tr>) : <tr><td colSpan={5} className="ops-empty">{current ? '当前范围暂无期初库存资料。' : '正在读取期初库存…'}</td></tr>}</tbody>
      </table></div>}
    {(page > 1 || current?.data?.hasNext) && <div className="logistics-pagination">
      <button className="secondary-button" type="button" disabled={page === 1} onClick={() => setCursor({ key: filter, page: page - 1 })}>上一页</button>
      <span>第 {page} 页</span><button className="secondary-button" type="button" disabled={!current?.data?.hasNext}
        onClick={() => setCursor({ key: filter, page: page + 1 })}>下一页</button></div>}
    {candidate && <ReviewOpeningStock candidate={candidate} onClose={() => setCandidate(null)} onSaved={() => {
      setCandidate(null); setRefresh((value) => value + 1); onChange();
    }} />}
  </article>;
}

function ReviewOpeningStock({ candidate, onClose, onSaved }: { candidate: Candidate; onClose: () => void; onSaved: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const { row, version, key } = candidate;

  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => { if (element?.open) element.close(); };
  }, []);

  async function post(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current || !new FormData(event.currentTarget).has('confirmed')) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/warehouse/opening-stock', { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key },
        body: JSON.stringify({ snapshotVersion: version, sku: row.sku, region: row.region, skuId: row.skuId,
          warehouseId: row.warehouseId, quantity: row.quantity, confirmed: true }), signal: AbortSignal.timeout(20_000) });
      const result = await response.json().catch(() => null) as { ok?: boolean; message?: string } | null;
      if (!response.ok || !result?.ok) throw new Error(result?.message || '建账结果待核，可原样重试。');
      onSaved();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '建账未完成');
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return <dialog ref={dialog} className="modal nine-store-handoff" aria-labelledby="opening-review-title" onCancel={(event) => {
    event.preventDefault(); if (!inFlight.current) onClose();
  }}><div className="modal-head"><div><h2 id="opening-review-title">确认期初库存</h2>
    <p>{row.sku} · {row.warehouseName ?? row.region} · {row.quantity} 件</p></div>
    <button aria-label="关闭" type="button" disabled={busy} onClick={onClose}>×</button></div>
    <form onSubmit={(event) => void post(event)}>
      <div className="form-grid nine-store-handoff-form"><label className="full nine-store-confirm">
        <input name="confirmed" type="checkbox" required disabled={busy} />已核对本公司商品、仓库和外部预占，实际盘点数量与上述数量一致。</label></div>
      {error && <p className="nine-store-handoff-alert" role="alert">{error}</p>}
      <div className="modal-actions"><button type="button" disabled={busy} onClick={onClose}>取消</button>
        <button className="primary-button" type="submit" disabled={busy}>{busy ? '正在建账…' : '确认建账'}</button></div>
    </form>
  </dialog>;
}
