'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import styles from './erp-sku-import.module.css';

type ImportStatus = 'new' | 'update' | 'unchanged' | 'error';
type ImportFilter = 'all' | 'errors' | 'missing';
type ImportIntent = 'preview' | 'apply';
type ImportRow = {
  rowNumber: number;
  code: string;
  name: string;
  status: ImportStatus;
  changedFields: string[];
  missingFields: string[];
  errors: string[];
  changes?: Array<{ field: string; before: string | null; after: string | null }>;
};
type ImportPreview = {
  ok: true;
  previewKey: string;
  sheetName: string;
  rows: ImportRow[];
  counts: Record<ImportStatus, number>;
};
type ImportResult = {
  ok: true;
  created: number;
  updated: number;
  unchanged: number;
  replayed?: boolean;
};

const statuses: Array<{ key: ImportStatus; label: string }> = [
  { key: 'new', label: '新增' },
  { key: 'update', label: '更新' },
  { key: 'unchanged', label: '无需更新' },
  { key: 'error', label: '有问题' },
];
const rowsPerPage = 30;
const workbookSizeLimit = 2 * 1024 * 1024;

export default function ErpSkuImport({ onClose, onImported }: {
  onClose: () => void;
  onImported: () => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState<ImportIntent | null>(null);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<ImportFilter>('all');
  const [page, setPage] = useState(1);

  useEffect(() => {
    const element = dialog.current;
    const previousFocus = document.activeElement;
    element?.showModal();
    return () => {
      if (element?.open) element.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) {
        const focusAfterClose = previousFocus.getClientRects().length ? previousFocus : previousFocus.closest('details')?.querySelector('summary');
        focusAfterClose?.focus();
      }
    };
  }, []);

  const matchedRows = useMemo(() => {
    const rows = preview?.rows ?? [];
    if (filter === 'errors') return rows.filter((row) => row.status === 'error');
    if (filter === 'missing') return rows.filter((row) => row.missingFields.length > 0);
    return rows;
  }, [preview, filter]);
  const pageCount = Math.max(1, Math.ceil(matchedRows.length / rowsPerPage));
  const visibleRows = matchedRows.slice((page - 1) * rowsPerPage, page * rowsPerPage);
  const hasChanges = Boolean(preview && preview.counts.new + preview.counts.update > 0);
  const canApply = Boolean(preview && preview.counts.error === 0 && hasChanges);

  function selectFile(next?: File) {
    if (!next) return;
    setPreview(null);
    setResult(null);
    setError('');
    setFilter('all');
    setPage(1);
    if (!/\.xlsx$/iu.test(next.name) || next.size > workbookSizeLimit) {
      setFile(null);
      setError('请选择 2 MB 以内的 .xlsx 文件。');
      return;
    }
    setFile(next);
  }

  async function runImport(intent: ImportIntent) {
    if (!file || busy || (intent === 'apply' && !canApply)) return;
    const form = new FormData();
    form.set('intent', intent);
    form.set('file', file);
    if (intent === 'apply' && preview) form.set('previewKey', preview.previewKey);
    setError('');
    setBusy(intent);
    try {
      const response = await fetch('/api/purchase/skus/import', { method: 'POST', body: form });
      const data = await response.json().catch(() => null) as ImportPreview | ImportResult | { ok?: false; message?: string } | null;
      if (!response.ok || !data?.ok) {
        if (intent === 'apply' && response.status === 409) setPreview(null);
        const message = data && 'message' in data ? data.message : null;
        throw new Error(message || (intent === 'preview' ? '预览失败，请核对表格。' : '导入失败，请重试。'));
      }
      if (intent === 'preview' && 'previewKey' in data) {
        setPreview(data);
        setFilter(data.counts.error ? 'errors' : 'all');
        setPage(1);
      } else if (intent === 'apply' && 'created' in data) {
        setPreview(null);
        setResult(data);
        await onImported();
      } else {
        throw new Error('导入服务返回了无法识别的结果，请重试。');
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '处理表格失败，请重试。');
    } finally {
      setBusy(null);
    }
  }

  return <dialog className={styles.dialog} ref={dialog} aria-labelledby="sku-import-title" aria-describedby="sku-import-policy"
    onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
    <header className={styles.header}>
      <div>
        <h2 id="sku-import-title">批量导入 SKU</h2>
        <p id="sku-import-policy">按 SKU 编码匹配商品。表格中的空白字段保留现有资料。</p>
      </div>
      <button className={styles.closeButton} type="button" aria-label="关闭批量导入" disabled={Boolean(busy)} onClick={onClose}>×</button>
    </header>

    <div className={styles.body} aria-busy={Boolean(busy)}>
      {result ? <section className={styles.success} role="status">
        <h3>导入完成</h3>
        <p>新增 <strong>{result.created}</strong> 个，更新 <strong>{result.updated}</strong> 个，<strong>{result.unchanged}</strong> 个无需更新。</p>
      </section> : <>
        <div className={styles.filePanel}>
          <div className={styles.fileControls}>
            <input ref={fileInput} type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden
              onChange={(event) => {
                const selected = event.currentTarget.files?.[0];
                event.currentTarget.value = '';
                selectFile(selected);
              }} />
            <button className="secondary-button" type="button" disabled={Boolean(busy)} onClick={() => fileInput.current?.click()}>
              {file ? '更换 Excel 文件' : '选择 Excel 文件'}
            </button>
            {file && <span className={styles.fileName} title={file.name}>{file.name}</span>}
          </div>
          <a className={styles.download} href="/sku-import-template.xlsx" download="SKU导入模板.xlsx">下载导入模板</a>
          <p>使用 .xlsx 文件，每批最多 500 行、2 MB。图片列可填写图片链接。</p>
        </div>

        {preview && <section className={styles.review} aria-label="SKU 导入预览">
          <div className={styles.reviewHeader}>
            <h3>导入预览 <span>{preview.sheetName}</span></h3>
            <label className={styles.filter}>显示
              <select value={filter} onChange={(event) => { setFilter(event.currentTarget.value as ImportFilter); setPage(1); }} disabled={Boolean(busy)}>
                <option value="all">全部行</option>
                <option value="errors">有问题</option>
                <option value="missing">资料待补</option>
              </select>
            </label>
          </div>
          <dl className={styles.counts}>
            {statuses.map(({ key, label }) => <div key={key} data-status={key}><dt>{label}</dt><dd>{preview.counts[key]}</dd></div>)}
          </dl>
          <div className={styles.tableWrap}>
            <table>
              <thead><tr><th scope="col">Excel 行号</th><th scope="col">SKU / 商品名称</th><th scope="col">结果</th><th scope="col">变动及待补资料</th></tr></thead>
              <tbody>{visibleRows.length ? visibleRows.map((row) => <PreviewRow key={row.rowNumber} row={row} />) : (
                <tr><td colSpan={4} className={styles.empty}>当前筛选下没有记录</td></tr>
              )}</tbody>
            </table>
          </div>
          {pageCount > 1 && <nav className={styles.pagination} aria-label="导入明细分页">
            <button type="button" className="secondary-button" disabled={page === 1 || Boolean(busy)} onClick={() => setPage(page - 1)}>上一页</button>
            <span>{page} / {pageCount} 页</span>
            <button type="button" className="secondary-button" disabled={page === pageCount || Boolean(busy)} onClick={() => setPage(page + 1)}>下一页</button>
          </nav>}
          {preview.counts.error > 0 && <p className={styles.reviewNote}>请按行提示修正表格，再重新选择文件预览。</p>}
          {preview.counts.error === 0 && !hasChanges && <p className={styles.reviewNote}>表格中的资料已与 ERP 一致。</p>}
        </section>}
      </>}
      {error && <p className={styles.error} role="alert">{error}</p>}
    </div>

    <footer className={styles.actions}>
      {result ? <button className="primary-button" type="button" disabled={Boolean(busy)} onClick={onClose}>完成</button> : <>
        <button className="secondary-button" type="button" disabled={Boolean(busy)} onClick={onClose}>取消</button>
        {preview ? <button className="primary-button" type="button" disabled={Boolean(busy) || !canApply}
          onClick={() => void runImport('apply')}>{busy === 'apply' ? '正在导入…' : '确认导入'}</button> : (
          <button className="primary-button" type="button" disabled={Boolean(busy) || !file}
            onClick={() => void runImport('preview')}>{busy === 'preview' ? '正在预览…' : '预览导入'}</button>
        )}
      </>}
    </footer>
  </dialog>;
}

function PreviewRow({ row }: { row: ImportRow }) {
  return <tr>
    <td>{row.rowNumber}</td>
    <td><strong className={styles.productCode}>{row.code || '未填写'}</strong>{row.name && <div className={styles.productName}>{row.name}</div>}</td>
    <td><span className={styles.status} data-status={row.status}>{statuses.find(({ key }) => key === row.status)?.label}</span></td>
    <td>
      {row.errors.length > 0 && <ul className={styles.rowErrors}>{row.errors.map((message) => <li key={message}>{message}</li>)}</ul>}
      {row.changedFields.length > 0 && <div className={styles.rowDetails}>写入字段 · {row.changedFields.join('、')}</div>}
      {row.missingFields.length > 0 && <div className={styles.missing}>资料待补 · {row.missingFields.join('、')}</div>}
      {row.changes && row.changes.length > 0 && <details className={styles.diff}>
        <summary>查看变动详情</summary>
        <dl>{row.changes.map(({ field, before, after }) => <div key={field}><dt>{field}</dt><dd>{before || '空白'} → {after || '空白'}</dd></div>)}</dl>
      </details>}
      {!row.errors.length && !row.changedFields.length && !row.missingFields.length && '—'}
    </td>
  </tr>;
}
