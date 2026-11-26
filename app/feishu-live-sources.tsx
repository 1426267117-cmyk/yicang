'use client';

import { useEffect, useRef, useState } from 'react';

type SourceTable = { id: string; title: string; hidden: boolean; preview: boolean };
type LiveSource = {
  id: string;
  title: string;
  type: 'sheet' | 'bitable';
  usage: '采购' | '库存' | '物流' | '订单';
  status: 'ready' | 'failed';
  checkedAt: string | null;
  tables: SourceTable[];
  message?: string;
};
type SourcePreview = {
  sourceId: string;
  tableId: string;
  title: string;
  readAt: string;
  columns: string[];
  rows: Array<Array<string | number | null>>;
  hasMore: boolean;
};
type SourceResponse = { ok?: boolean; sources?: LiveSource[]; preview?: SourcePreview; message?: string };
type ReadState = { url: string; data: SourceResponse | null; error: string; reading: boolean };

const beijingTime = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

function retainSourceDirectories(current: SourceResponse, previous: SourceResponse | null): SourceResponse {
  if (!current.sources || !previous?.sources?.length) return current;
  const previousById = new Map(previous.sources.map((source) => [source.id, source]));
  return {
    ...current,
    sources: current.sources.map((source) => {
      const last = previousById.get(source.id);
      if (source.status !== 'failed' || source.tables.length || !last?.tables.length) return source;
      return { ...source, checkedAt: last.checkedAt, tables: last.tables,
        message: `${source.message ?? '读取来源失败。'} 当前显示上次成功读取的子表目录。` };
    }),
  };
}

function useLiveRead(url: string | null, kind: 'list' | 'table') {
  const [state, setState] = useState<ReadState | null>(null);
  const action = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!url) return;
    const requestUrl = url;
    const controller = new AbortController();
    let timer: number;
    let reading = false;

    async function read() {
      if (reading || controller.signal.aborted) return;
      reading = true;
      window.clearTimeout(timer);
      setState((previous) => ({
        url: requestUrl,
        data: previous?.url === requestUrl ? previous.data : null,
        error: previous?.url === requestUrl ? previous.error : '',
        reading: true,
      }));
      try {
        const response = await fetch(requestUrl, {
          cache: 'no-store',
          credentials: 'same-origin',
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(55_000)]),
        });
        if (response.status === 401 || response.status === 403) {
          if (!controller.signal.aborted) setState({ url: requestUrl, data: null, error: '当前账号没有该来源的读取权限。', reading: false });
          return;
        }
        const body = await response.json().catch(() => null) as SourceResponse | null;
        const valid = kind === 'list' ? Array.isArray(body?.sources)
          : Array.isArray(body?.preview?.columns) && Array.isArray(body.preview.rows);
        if (!response.ok || body?.ok !== true || !valid) {
          throw new Error(body?.message || '暂时无法读取飞书来源。');
        }
        if (!controller.signal.aborted) setState((previous) => ({
          url: requestUrl,
          data: retainSourceDirectories(body, previous?.url === requestUrl ? previous.data : null),
          error: '', reading: false,
        }));
      } catch (error) {
        if (!controller.signal.aborted) setState((previous) => ({
          url: requestUrl,
          data: previous?.url === requestUrl ? previous.data : null,
          error: error instanceof Error && error.message ? error.message : '暂时无法读取飞书来源。',
          reading: false,
        }));
      } finally {
        reading = false;
        if (!controller.signal.aborted) timer = window.setTimeout(() => { void read(); }, 60_000);
      }
    }

    timer = window.setTimeout(() => { void read(); }, 0);
    action.current = () => { void read(); };
    return () => {
      controller.abort();
      window.clearTimeout(timer);
      action.current = null;
    };
  }, [url, kind]);

  return {
    state: state?.url === url ? state : null,
    refresh: () => action.current?.(),
  };
}

function ReadTime({ value }: { value: string | null }) {
  if (!value) return '尚无记录';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? '时间待核' : <time dateTime={value}>{beijingTime.format(date)}</time>;
}

export default function FeishuLiveSources({ initialSourceId }: { initialSourceId?: string }) {
  const [selection, setSelection] = useState<{ sourceId: string; tableId: string | null } | null>(
    () => initialSourceId ? { sourceId: initialSourceId, tableId: null } : null,
  );
  const inventory = useLiveRead('/api/feishu-sources', 'list');
  const sources = inventory.state?.data?.sources ?? [];
  const activeSource = sources.find((source) => source.id === selection?.sourceId) ?? sources[0];
  const activeTable = activeSource?.tables.find((table) => table.id === selection?.tableId && table.preview)
    ?? activeSource?.tables.find((table) => table.preview && !table.hidden)
    ?? activeSource?.tables.find((table) => table.preview);
  const parameters = activeSource && activeTable ? new URLSearchParams({ source: activeSource.id, table: activeTable.id }) : null;
  const table = useLiveRead(parameters ? `/api/feishu-sources?${parameters}` : null, 'table');
  const loaded = table.state?.data?.preview;
  const selectedPreview = loaded && loaded.sourceId === activeSource?.id && loaded.tableId === activeTable?.id ? loaded : null;
  const reading = !inventory.state || inventory.state.reading || (Boolean(parameters) && (!table.state || table.state.reading));

  return <div className="content feishu-live-sources">
    <header className="feishu-live-heading">
      <div>
        <h1>飞书实时来源</h1>
        <p>查看各来源的子表目录和只读预览。此页面每分钟刷新一次。</p>
      </div>
      <button type="button" className="secondary-button" disabled={reading} onClick={() => {
        inventory.refresh();
        table.refresh();
      }}>{reading ? '正在读取…' : '刷新来源'}</button>
    </header>
    {inventory.state?.error && <p className="feishu-live-error" role="alert">
      {inventory.state.error}{sources.length > 0 && ' 当前显示上次成功读取的来源目录。'}
    </p>}
    {(!inventory.state || inventory.state.reading && !inventory.state.data) && <p className="feishu-live-empty" role="status">正在读取来源目录…</p>}
    {inventory.state?.data && sources.length === 0 && <p className="feishu-live-empty">暂无可查看的飞书来源。</p>}
    {activeSource && <div className="feishu-live-layout">
      <aside className="card feishu-live-directory">
        <h2>来源目录 <span>{sources.length}</span></h2>
        <nav aria-label="飞书来源">
          {sources.map((source) => <button type="button" key={source.id} aria-current={source.id === activeSource.id ? 'page' : undefined} onClick={() => {
            if (source.id !== activeSource.id) setSelection({ sourceId: source.id, tableId: null });
          }}>
            <strong>{source.title}</strong>
            <small>{source.usage} · {source.type === 'bitable' ? '多维表格' : '电子表格'} · {source.tables.length} 个子表</small>
            <span className="feishu-live-status" data-status={source.status}>{source.status === 'ready' ? '可读取' : '读取失败'}</span>
          </button>)}
        </nav>
      </aside>
      <section className="card feishu-live-selected" aria-label="来源子表与预览">
        <div className="feishu-live-source-header">
          <h2>{activeSource.title}</h2>
          <p>最近成功读取（北京时间） <ReadTime value={activeSource.checkedAt} /></p>
          {activeSource.message && <p className={activeSource.status === 'failed' ? 'feishu-live-error' : undefined} role={activeSource.status === 'failed' ? 'alert' : undefined}>
            {activeSource.message}
          </p>}
        </div>
        {activeSource.tables.length > 0 ? <nav className="feishu-live-table-list" aria-label="子表目录">
          {activeSource.tables.map((item) => <button
            type="button"
            key={item.id}
            aria-pressed={item.id === activeTable?.id}
            disabled={!item.preview}
            onClick={() => setSelection({ sourceId: activeSource.id, tableId: item.id })}
          >
            {item.title}
            {item.hidden && <small>隐藏</small>}
            {!item.preview && <small>仅目录</small>}
          </button>)}
        </nav> : <p className="feishu-live-empty">暂无可查看的子表目录。</p>}
        {table.state?.error && <p className="feishu-live-error" role="alert">
          {table.state.error}{selectedPreview && ' 当前显示上次成功读取的预览。'}
        </p>}
        {activeTable && !selectedPreview && !table.state?.error && (!table.state || table.state.reading) && <p className="feishu-live-empty" role="status">正在读取子表预览…</p>}
        {loaded && !selectedPreview && <p className="feishu-live-error" role="alert">返回的子表标识与当前选择不一致。</p>}
        {!activeTable && activeSource.tables.length > 0 && <p className="feishu-live-empty">此来源暂无可预览的子表。</p>}
        {selectedPreview && <PreviewTable preview={selectedPreview} />}
      </section>
    </div>}
  </div>;
}

function PreviewTable({ preview }: { preview: SourcePreview }) {
  return <section className="feishu-live-preview" aria-label="子表预览">
    <div className="feishu-live-source-header">
      <h3>{preview.title}</h3>
      <p>预览读于（北京时间） <ReadTime value={preview.readAt} /> · 显示 {preview.rows.length} 条</p>
    </div>
    {preview.rows.length > 0 && preview.columns.length > 0 ? <div className="table-wrap">
      <table aria-label={`${preview.title} 只读预览`}>
        <thead><tr>{preview.columns.map((column, index) => <th scope="col" key={index}>{column}</th>)}</tr></thead>
        <tbody>{preview.rows.map((row, rowIndex) => <tr key={rowIndex}>
          {preview.columns.map((_, columnIndex) => <td key={columnIndex}>{row[columnIndex] ?? '—'}</td>)}
        </tr>)}</tbody>
      </table>
    </div> : <p className="feishu-live-empty">此子表暂未返回预览记录。</p>}
    {preview.hasMore && <p className="feishu-live-empty">当前为部分记录预览。</p>}
  </section>;
}
