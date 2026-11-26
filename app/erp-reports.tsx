'use client';

import { useEffect, useState } from 'react';
import {
  defaultPlatformReportFilters, defaultReportWindow, formatReportMinor, isSnapshotReport, reportColumns, reportDefinitions, reportKinds,
  type PlatformReportFilters, type ReportKind, type ReportMinorEncoding, type ReportResult, type ReportRow, type ReportStoreOption,
} from '../lib/report-contract';
import styles from './erp-reports.module.css';

const purchaseStatuses: Record<string, string> = {
  draft: '草稿', issued: '已下达', partially_received: '部分到货',
  received: '全部到货', closed_short: '短收结案', cancelled: '已取消',
};
const platformNames: Record<string, string> = { amazon: 'Amazon', shopify: 'Shopify', wayfair: 'Wayfair', yqn: '运去哪' };
const coverageLabels: Record<string, string> = { complete: '区间已核验', partial: '有覆盖缺口', unknown: '覆盖待核' };
const quantityFormat = new Intl.NumberFormat('zh-CN');
const timeFormat = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'medium', hourCycle: 'h23',
});

export default function ErpReports() {
  const [draftWindow, setDraftWindow] = useState(defaultReportWindow);
  const [draftPlatform, setDraftPlatform] = useState(defaultPlatformReportFilters);
  const [selection, setSelection] = useState(() => ({
    report: 'orders' as ReportKind, window: defaultReportWindow(), platform: defaultPlatformReportFilters, version: 0,
  }));
  const [loaded, setLoaded] = useState<{ version: number; report: ReportResult } | null>(null);
  const [failure, setFailure] = useState<{ version: number; message: string } | null>(null);
  const result = loaded?.version === selection.version ? loaded.report : null;
  const error = failure?.version === selection.version ? failure.message : '';
  const busy = !result && !error;
  const definition = reportDefinitions[selection.report];
  const columns = reportColumns(selection.report, selection.platform.groupBy).map((column) => ({
    ...column, numeric: Boolean(column.minorAmount) || /_(count|qty|days|sales)$/.test(column.key),
  }));
  const dateBased = !isSnapshotReport(selection.report);
  const feishuSales = selection.report === 'feishu-sales';
  const storeOptions = loaded?.report.platform?.stores ?? [];

  useEffect(() => {
    const controller = new AbortController();
    const query = new URLSearchParams({ report: selection.report });
    if (!isSnapshotReport(selection.report)) {
      query.set('from', selection.window.from);
      query.set('to', selection.window.to);
    }
    if (selection.report === 'platform') {
      if (selection.platform.store) query.set('store', selection.platform.store);
      query.set('groupBy', selection.platform.groupBy);
    }
    async function loadReport() {
      try {
        const response = await fetch(`/api/reports?${query}`, { cache: 'no-store', signal: controller.signal });
        const data = await response.json().catch(() => null) as (ReportResult | { ok: false; message?: string }) | null;
        if (!response.ok || data?.ok !== true || data.report !== selection.report || !Array.isArray(data.rows)) {
          throw new Error(data?.ok === false && data.message ? data.message : '暂时无法生成报表，请重试。');
        }
        if (!controller.signal.aborted) setLoaded({ version: selection.version, report: data });
      } catch (readError) {
        if (!controller.signal.aborted) setFailure({
          version: selection.version,
          message: readError instanceof Error ? readError.message : '暂时无法生成报表，请重试。',
        });
      }
    }
    void loadReport();
    return () => controller.abort();
  }, [selection]);

  function refresh() {
    setSelection((current) => ({ ...current, window: draftWindow, platform: draftPlatform, version: current.version + 1 }));
  }

  return <div className={`content module-content ${styles.reports}`}>
    <header className="module-head">
      <h1>数据报表</h1>
      <button className="secondary-button" type="button" disabled={!result?.rows.length} onClick={() => result && downloadCsv(result)}>
        导出 CSV
      </button>
    </header>
    <section className={`card data-card ${styles.controls}`} aria-label="报表筛选">
      <div className={styles.tabs} role="group" aria-label="报表类型">
        {reportKinds.filter((kind) => kind !== 'feishu-sales').map((kind) => <button key={kind} type="button" aria-pressed={selection.report === kind} onClick={() => {
          if (kind !== selection.report) setSelection((current) => ({ ...current, report: kind, version: current.version + 1 }));
        }}>{reportDefinitions[kind].label}</button>)}
      </div>
      <div className={styles.toolbar}>
        <form className={styles.filters} onSubmit={(event) => { event.preventDefault(); refresh(); }}>
          {dateBased && <>
            <label>开始日期<input type="date" required value={draftWindow.from} max={draftWindow.to || undefined}
              onChange={(event) => setDraftWindow((current) => ({ ...current, from: event.target.value }))} /></label>
            <label>结束日期<input type="date" required value={draftWindow.to} min={draftWindow.from || undefined}
              onChange={(event) => setDraftWindow((current) => ({ ...current, to: event.target.value }))} /></label>
          </>}
          {selection.report === 'platform' && <>
            <label>店铺<select value={draftPlatform.store ?? ''} onChange={(event) => {
              const store = event.target.value || undefined;
              setDraftPlatform((current) => ({ ...current, store }));
            }}>
              <option value="">全部店铺</option>
              {draftPlatform.store && !storeOptions.some((store) => store.key === draftPlatform.store) && <option value={draftPlatform.store}>上次选择的店铺</option>}
              {storeOptions.map((store) => <option key={store.key} value={store.key}>{platformNames[store.platform] ?? store.platform} · {storeName(store, storeOptions)}</option>)}
            </select></label>
            <label>汇总<select value={draftPlatform.groupBy} onChange={(event) => {
              const groupBy = event.target.value as PlatformReportFilters['groupBy'];
              setDraftPlatform((current) => ({ ...current, groupBy }));
            }}><option value="store">按店铺</option><option value="day">按日分店</option></select></label>
          </>}
          <button className="primary-button" type="submit" disabled={busy}>{dateBased ? '查询' : feishuSales ? '重新读取快照' : '刷新库存'}</button>
        </form>
        <details className={styles.method}>
          <summary>统计口径</summary><p>{definition.source}</p>
        </details>
      </div>
    </section>

    {error && <p className={styles.error} role="alert">{error}</p>}
    {busy && <p className={styles.loading} role="status">正在生成报表…</p>}
    {result && <>
      <dl className={styles.metrics} aria-label="报表汇总">
        {definition.summary.map((metric) => <div key={metric.key}>
          <dt>{metric.label}</dt><dd>{reportMetric(result, metric.key)}</dd>
        </div>)}
      </dl>
      <article className="card data-card" aria-label={definition.label}>
        <header className={styles.tableHeader}>
          <h2>{definition.label}</h2>
          <p>{result.window ? `${result.window.from} 至 ${result.window.to}` : `读取于 ${formatReportTime(result.generatedAt)}`}
            {result.snapshot && <><br />快照 {result.snapshot.date} · 保存于 {formatReportTime(result.snapshot.importedAt)}</>}</p>
        </header>
        <div className={`table-wrap module-table ${styles.resultsTable}`} role="region" aria-label={`${definition.label}明细`} tabIndex={0}><table>
          <thead><tr>{columns.map((column) => <th scope="col" key={column.key} data-numeric={column.numeric}>{column.label}</th>)}</tr></thead>
          <tbody>{result.rows.length ? result.rows.map((row, index) => <tr key={index}>
            {columns.map((column) => <td key={column.key} data-numeric={column.numeric}>{reportCell(row, column.key, column.minorAmount, storeOptions)
              ?? (feishuSales || (column.minorAmount && Number(row.active_count ?? 0) > 0) ? '待核' : '—')}</td>)}
          </tr>) : <tr><td className="empty-cell" colSpan={columns.length}>{feishuSales
            ? result.snapshot ? '飞书快照暂无可汇总的店铺记录' : '当前工作区尚无飞书采购快照'
            : '当前范围没有已入库记录'}</td></tr>}</tbody>
        </table></div>
      </article>
    </>}
  </div>;
}

function reportMetric(report: ReportResult, key: string) {
  if (report.report !== 'feishu-sales') {
    return quantityFormat.format(report.rows.reduce((sum, row) => sum + Number(row[key] ?? 0), 0));
  }
  const known = report.rows.map((row) => row[key]).filter((value) => value !== undefined && value !== null);
  if (!known.length) return report.snapshot && key === 'reported_stores' ? '0' : '待核';
  return quantityFormat.format(known.reduce((sum, value) => sum + BigInt(value), BigInt(0)));
}

function storeName(store: ReportStoreOption, stores: ReportStoreOption[]) {
  return stores.some(other => other.key !== store.key && other.platform === store.platform && other.name === store.name)
    ? `${store.name}（${store.key.split('/')[1]}）` : store.name;
}

function reportCell(row: ReportRow, key: string, minorAmount: ReportMinorEncoding | undefined, stores: ReportStoreOption[], exportMode = false) {
  const value = row[key];
  if (value === null || value === undefined) return null;
  if (minorAmount) return typeof row.currency === 'string' ? formatReportMinor(value, row.currency, minorAmount) : null;
  if (key === 'store' && typeof value === 'string' && typeof row.platform === 'string' && typeof row.store_key === 'string') {
    return storeName({ key: `${row.platform}/${row.store_key}`, platform: row.platform, name: value }, stores);
  }
  if (key === 'status' && typeof value === 'string') return purchaseStatuses[value] ?? value;
  if (key === 'platform' && typeof value === 'string') return platformNames[value] ?? value;
  if (key === 'coverage_status' && typeof value === 'string') return coverageLabels[value] ?? value;
  if (key === 'latest_update' && typeof value === 'string') return formatReportTime(value);
  return typeof value === 'number' && !exportMode ? quantityFormat.format(value) : value;
}

function formatReportTime(timestamp: string) {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? '—' : timeFormat.format(date);
}

function downloadCsv(report: ReportResult) {
  const { label } = reportDefinitions[report.report];
  const columns = reportColumns(report.report, report.platform?.filters.groupBy);
  const snapshotHeaders = report.snapshot && report.window ? ['快照日期', '销量起始日', '销量截止日'] : [];
  const snapshotValues = report.snapshot && report.window ? [report.snapshot.date, report.window.from, report.window.to] : [];
  const lines = [[...snapshotHeaders, ...columns.map((column) => column.label)].map((column) => escapeCsv(column)).join(','),
    ...report.rows.map((row) => [...snapshotValues.map((value) => escapeCsv(value)), ...columns.map((column) => {
      const cell = reportCell(row, column.key, column.minorAmount, report.platform?.stores ?? [], true);
      const numeric = (column.minorAmount || ['verified_sales', 'other_sales'].includes(column.key))
        && typeof cell === 'string' && /^-?\d+(?:\.\d+)?$/u.test(cell);
      return escapeCsv(cell, numeric);
    })].join(',')),
  ];
  const url = URL.createObjectURL(new Blob(['\ufeff', lines.join('\r\n'), '\r\n'], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  const dateLabel = report.window ? `${report.window.from}_${report.window.to}` : defaultReportWindow().to;
  link.href = url;
  link.download = `${label}_${dateLabel}.csv`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function escapeCsv(value: string | number | null, numericText = false) {
  if (value === null) return '';
  if (typeof value === 'number' || numericText) return String(value);
  const safe = /^(?:[\t\r\n]|\s*[=+\-@])/u.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}
