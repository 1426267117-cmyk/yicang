'use client';

import { useState, type FormEvent } from 'react';
import type { ShopifyInventoryItemValue } from '../lib/connectors/shopify/inventory-read';
import type { readShopifyInventoryMirror } from '../lib/connectors/shopify/inventory-mirror';
import type { StoreConnection } from './erp-operations';

type InventoryLookup = {
  ok: true;
  readOnly: true;
  queriedAt: string;
  store: { key: StoreConnection['key']; name: string; domain: string };
  sku: string;
  items: ShopifyInventoryItemValue[];
};
type MirrorLookup = Awaited<ReturnType<typeof readShopifyInventoryMirror>> & { ok: true; readOnly: true };
type LookupSource = 'mirror' | 'live';

const mirrorState = { fresh: '在有效期内', stale: '历史快照 · 待重新核对', unavailable: '库存不可用' };
const mirrorReasons: Record<MirrorLookup['reason'], string> = {
  store_unverified: '店铺身份尚未核验。', not_observed: '暂未保存此 SKU 的库存快照。',
  source_unavailable: '最近一次后台读取失败。', not_found: '最近核对未找到完全匹配的 SKU。',
  ambiguous: '最近核对发现多个完全匹配的库存项。', untracked: '该 SKU 未启用库存跟踪。',
  unavailable: '最近一次库存读取失败。', verified: '快照时效需要重新核对。',
};

const timestamp = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'short' });

function beijingTime(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? timestamp.format(date) : '—';
}

export default function ErpShopifyInventoryLookup({ stores, canSync }: {
  stores: StoreConnection[] | null;
  canSync: boolean;
}) {
  const [store, setStore] = useState('');
  const [sku, setSku] = useState('');
  const [pending, setPending] = useState<LookupSource | null>(null);
  const [error, setError] = useState('');
  const [result, setResult] = useState<InventoryLookup | null>(null);
  const [mirror, setMirror] = useState<MirrorLookup | null>(null);
  const available = stores ?? [];
  const liveEnabled = (option: StoreConnection) => option.credentialsConfigured && option.accessCapabilities?.inventory !== 'missing';
  const selected = available.find(({ key }) => key === store) ?? available.find(liveEnabled) ?? available[0];
  const liveAllowed = Boolean(canSync && selected && liveEnabled(selected));

  async function query(source: LookupSource) {
    const exactSku = sku.trim();
    if (pending || !selected || !exactSku || (source === 'live' && !liveAllowed)) return;
    setPending(source);
    if (source === 'live') setResult(null);
    setError('');
    try {
      const params = { storeKey: selected.key, sku: exactSku };
      const signal = AbortSignal.timeout(30_000);
      const response = source === 'mirror'
        ? await fetch(`/api/connectors/shopify/inventory-mirror?${new URLSearchParams(params)}`, { cache: 'no-store', signal })
        : await fetch('/api/connectors/shopify/inventory', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(params), signal });
      const body = await response.json().catch(() => null) as InventoryLookup | MirrorLookup | { ok: false; message?: string } | null;
      if (!response.ok || !body?.ok || !body.readOnly || body.sku !== exactSku) {
        throw new Error(body && !body.ok && body.message || '暂时无法读取库存');
      }
      if (source === 'mirror' && 'storeKey' in body && body.storeKey === selected.key) setMirror(body);
      else if (source === 'live' && 'store' in body && body.store.key === selected.key && Array.isArray(body.items)) setResult(body);
      else throw new Error('店铺库存响应无法核验');
    } catch (failure) {
      if (source === 'mirror') setMirror(null);
      const message = failure instanceof Error && failure.name !== 'TimeoutError' ? failure.message : '读取超时，请重试';
      setError(`${source === 'mirror' ? '后台镜像' : 'Shopify 实时查询'} · ${message}`);
    } finally {
      setPending(null);
    }
  }

  function clearLookups() { setError(''); setResult(null); setMirror(null); }

  function readMirror(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void query('mirror');
  }

  return <article className="ops-panel ops-list">
    <div className="ops-panel-head"><h2>Shopify 库存查询</h2><span>店铺库存 · 只读</span></div>
    <form className="ops-filterline" onSubmit={readMirror}>
        <label>店铺 <select value={selected?.key ?? ''} disabled={!selected || Boolean(pending)} onChange={(event) => {
          setStore(event.target.value); clearLookups();
        }}>
          {selected ? available.map(({ key, displayName }) => <option key={key} value={key}>{displayName}</option>)
            : <option value="">{stores ? '暂无店铺' : '正在读取接入状态'}</option>}
        </select></label>
        <label>店铺 SKU <input name="sku" type="text" value={sku} required maxLength={160} autoComplete="off"
          placeholder="填写完整 SKU" disabled={!selected || Boolean(pending)} onChange={(event) => {
            setSku(event.target.value); clearLookups();
          }} /></label>
        <button className="primary-button" type="submit" disabled={!selected || Boolean(pending) || !sku.trim()}>
          {pending === 'mirror' ? '读取中…' : '查看同步库存'}
        </button>
        {liveAllowed && <button className="secondary-button" type="button" disabled={Boolean(pending) || !sku.trim()}
          onClick={() => { void query('live'); }}>{pending === 'live' ? '查询中…' : '查询实时库存'}</button>}
    </form>
    {error && <p className="ops-empty" role="alert">{error}</p>}
    {mirror && mirror.storeKey === selected?.key && mirror.sku === sku.trim() && <section aria-label="Shopify 后台库存镜像">
      <p className="ops-empty" role="status">后台镜像 · {selected?.displayName} · {mirror.sku} · {mirrorState[mirror.state]}
        {mirror.observedAt && ` · 采集于 ${beijingTime(mirror.observedAt)}（北京时间）`}
        {mirror.state !== 'fresh' && ` · ${mirrorReasons[mirror.reason]}`}
      </p>
      {mirror.snapshot && <InventoryLevels items={[mirror.snapshot]} />}
    </section>}
    {result && result.store.key === selected?.key && result.sku === sku.trim() && <>
      <p className="ops-empty" role="status">Shopify 实时查询 · {result.store.name} · {result.sku} · {beijingTime(result.queriedAt)}（北京时间）</p>
      {result.items.length ? <InventoryLevels items={result.items} /> : <p className="ops-empty">该店铺未找到完全匹配的 SKU。</p>}
    </>}
  </article>;
}

function InventoryLevels({ items }: { items: ShopifyInventoryItemValue[] }) {
  return <div className="table-wrap ops-table"><table>
    <thead><tr><th scope="col">库存项</th><th scope="col">地点</th><th scope="col">可售</th><th scope="col">现有</th>
      <th scope="col">已占用</th><th scope="col">在途</th><th scope="col">平台更新时间</th></tr></thead>
    <tbody>{items.flatMap(item => item.levels.length ? item.levels.map(level => <tr key={`${item.itemId}:${level.location.id}`}>
      <td>{item.itemId.split('/').at(-1)}</td><td>{level.location.name}{(!level.active || !level.location.isActive) && <small className="cell-sub">未启用</small>}</td>
      <td>{level.available ?? '—'}</td><td>{level.onHand ?? '—'}</td><td>{level.committed ?? '—'}</td><td>{level.incoming ?? '—'}</td><td>{beijingTime(level.updatedAt)}</td>
    </tr>) : <tr key={item.itemId}><td>{item.itemId.split('/').at(-1)}</td><td colSpan={6}>{item.tracked ? '暂无库存地点' : '未启用库存跟踪'}</td></tr>)}</tbody>
  </table></div>;
}
