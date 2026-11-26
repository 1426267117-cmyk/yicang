'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { WayfairOrderPreview } from '../lib/connectors/wayfair/order-preview';
import type { WayfairConnectionStatus } from '../lib/connectors/wayfair/store-settings';
import styles from './erp-wayfair-connection.module.css';

const dateTime = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'short' });
const numberFormat = new Intl.NumberFormat('zh-CN');

function displayTime(timestamp: string | null) {
  const instant = timestamp ? Date.parse(timestamp) : NaN;
  return Number.isFinite(instant) ? dateTime.format(instant) : '待核';
}

async function read<T>(endpoint: string, init: RequestInit, fallback: string) {
  const response = await fetch(endpoint, { cache: 'no-store', ...init });
  const payload = await response.json().catch(() => null) as (T & { ok?: boolean; message?: string }) | null;
  if (!response.ok || payload?.ok !== true) throw new Error(payload?.message || fallback);
  return payload;
}

export default function ErpWayfairConnection({ canPreview }: { canPreview: boolean }) {
  const [revision, setRevision] = useState(0);
  const [status, setStatus] = useState<WayfairConnectionStatus | null>(null);
  const [statusError, setStatusError] = useState('');
  const [hasResponse, setHasResponse] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<WayfairOrderPreview | null>(null);
  const [previewError, setPreviewError] = useState('');
  const activePreview = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void read<WayfairConnectionStatus>('/api/connectors/wayfair/status', { signal: controller.signal }, '读取 Wayfair 接入状态失败')
      .then((response) => { if (!controller.signal.aborted) setStatus(response); })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setStatusError(cause instanceof Error ? cause.message : '读取 Wayfair 接入状态失败');
      });
    return () => controller.abort();
  }, [revision]);

  useEffect(() => () => activePreview.current?.abort(), []);

  async function preview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canPreview || status?.configuration !== 'configured' || activePreview.current) return;
    const controller = new AbortController();
    activePreview.current = controller;
    setBusy(true);
    setPreviewError('');
    setResult(null);
    try {
      const response = await read<WayfairOrderPreview>('/api/connectors/wayfair/preview', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hasResponse }), signal: controller.signal,
      }, 'Wayfair 采购单预览失败');
      if (!controller.signal.aborted) setResult(response);
    } catch (cause) {
      if (!controller.signal.aborted) setPreviewError(cause instanceof Error ? cause.message : 'Wayfair 采购单预览失败');
    } finally {
      activePreview.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  const state = result ? { label: result.environment === 'sandbox' ? '本次沙箱核验通过' : '本次正式接口核验通过', tone: 'success' }
    : status?.configuration === 'configured' ? { label: status.environment === 'sandbox' ? '沙箱待核验' : '正式接口待核验', tone: 'info' }
    : status?.configuration === 'invalid' ? { label: '配置待补齐', tone: 'warning' }
    : status?.configuration === 'unconfigured' ? { label: '待授权', tone: 'muted' } : null;

  return <article className="ops-panel" aria-label="Wayfair 林和店铺接入">
    <div className="ops-panel-head"><h2>Wayfair 林和</h2>
      {state && <span className={`ops-state ops-state-${state.tone}`}>{state.label}</span>}
    </div>
    {statusError && <div className={styles.message} role="alert">{statusError}
      <button type="button" className="link-button" onClick={() => { setStatusError(''); setRevision((current) => current + 1); }}>重试</button>
    </div>}
    {!status && !statusError && <p className="ops-empty" role="status">正在读取 Wayfair 接入状态…</p>}
    {status?.configuration === 'configured' && <>
      {canPreview && <form className={`ops-filterline ${styles.filters}`} onSubmit={preview}>
        <label>供应商确认状态<select value={hasResponse ? 'acknowledged' : 'open'} disabled={busy}
          onChange={(event) => { setHasResponse(event.target.value === 'acknowledged'); setResult(null); setPreviewError(''); }}>
          <option value="open">未确认</option><option value="acknowledged">已确认</option>
        </select></label>
        <button className="secondary-button" type="submit" disabled={busy}>{busy ? '正在核验并读取…' : '预览采购单'}</button>
        <span>按 PO 创建日查看近 {status.previewDays} 天，每次最多 {status.maxOrders} 单。</span>
      </form>}
      {previewError && <p className={styles.message} role="alert">{previewError}</p>}
      {result && <>
        <div className={styles.resultHead} role="status">{result.hasResponse ? '已确认' : '未确认'} · 自 {result.fromDay} · {result.orders.length} 单 · {displayTime(result.readAt)}</div>
        {result.possiblyTruncated && <p className={styles.warning} role="status">已达到 {status.maxOrders} 单查询上限，Wayfair 可能还有其他记录。</p>}
        {result.orders.length > 0 ? <div className={`table-wrap ops-table erp-channel-table ${styles.table}`} tabIndex={0} role="region" aria-label="Wayfair 采购单预览">
          <table><thead><tr>
            <th scope="col">Wayfair 采购单</th><th scope="col">PO 创建时间（北京时间）</th><th scope="col">商品明细</th>
          </tr></thead><tbody>{result.orders.map((order) => <tr key={order.poNumber}>
            <td><strong>{order.poNumber}</strong></td><td className="erp-channel-date">{displayTime(order.createdAt)}</td>
            <td>{order.lines.length ? <details><summary>{numberFormat.format(order.lines.length)} 项</summary>
              <ul className={styles.lines}>{order.lines.map((line, index) => <li key={index}>
                <span><strong>{line.supplierSku ?? '供应商 SKU 待核'}</strong>{line.wayfairSku && <small>Wayfair SKU {line.wayfairSku}</small>}
                  {line.title && <small>{line.title}</small>}</span>
                <span>{line.quantity === null ? '数量待核' : `${numberFormat.format(line.quantity)} 件`}{line.cancelled === true && <small>已取消</small>}</span>
              </li>)}</ul>
            </details> : '暂无商品明细'}</td>
          </tr>)}</tbody></table>
        </div> : <p className="ops-empty">未返回符合条件的采购单。</p>}
      </>}
    </>}
  </article>;
}
