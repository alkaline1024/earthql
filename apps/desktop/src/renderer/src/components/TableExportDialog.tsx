import { backgroundTransfer, trackTransfer } from '../background-transfer';
import { useEffect, useRef, useState } from 'react';
import { describePath, type ObjectPath, type TreeNode } from '@earthql/core';
import type { ExportResult, TableExportItem, TableExportOptions, TableFileFormat } from '../../../shared/api';
import { api, errorInfo, uid } from '../api';
import { connectionName, profileOf, useApp } from '../store';
import { FILE_NAME_TOKENS, tableFileName } from '../table-file-name';
import { ErrorView, Modal, Spinner } from './common';
import { ExportProgressModal, ExportSuccessModal, exportSummary } from './ExportProgress';

export function TableExportDialog({ profileId, object, selectedObjects, views = [], onClose }: { profileId: string; object: ObjectPath; selectedObjects?: ObjectPath[]; views?: ObjectPath[]; onClose: () => void }) {
  const isView = (target: ObjectPath) => views.some((view) => describePath(view) === describePath(target));
  const defaultItem = (target: ObjectPath, checked: boolean): TableExportItem => ({
    object: target,
    data: checked,
    structure: checked && !isView(target),
    drop: checked && !isView(target),
  });
  const [items, setItems] = useState<TableExportItem[]>(() => (selectedObjects ?? [object]).map((target) => defaultItem(target, true)));
  const [tables, setTables] = useState<ObjectPath[]>(selectedObjects ?? [object]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [options, setOptions] = useState<TableExportOptions>({ format: 'csv', suggestedName: '', delimiter: ',', quote: 'needed', lineBreak: '\n', decimal: '.', headers: true, nullToEmpty: true, replaceLineBreaks: false, bom: true, gzip: false });
  const [pattern, setPattern] = useState('{database}_{table}_{year}-{month}-{day}');
  const [customize, setCustomize] = useState(false);
  const [draftPattern, setDraftPattern] = useState(pattern);
  const profile = profileOf(profileId)?.profile;
  const context = { connection: connectionName(profileId), object, tag: profile?.env.name ?? '' };
  const [fileName, setFileName] = useState(() => tableFileName(pattern, context));
  const [exportId] = useState(uid);
  const [running, setRunning] = useState(false);
  const [rows, setRows] = useState(0);
  const [total, setTotal] = useState<number | undefined>();
  const [phase, setPhase] = useState<'configure' | 'progress' | 'success'>('configure');
  const [stopping, setStopping] = useState(false);
  const [donePath, setDonePath] = useState<string | undefined>();
  const [result, setResult] = useState<ExportResult | null>(null);
  const inFlight = useRef<Promise<ExportResult> | null>(null);
  const backgrounded = useRef(false);
  const allCheckbox = useRef<HTMLInputElement>(null);
  const toast = useApp((state) => state.toast);
  const exportInBackground = useApp((state) => state.exportInBackground);
  const exportSuccessDialog = useApp((state) => state.exportSuccessDialog);
  const isSql = options.format === 'sql';
  const enabledItems = items.filter((item) => isSql ? item.data || item.structure : item.data);
  const extension = !isSql && options.format !== 'xlsx' && enabledItems.length > 1 ? 'zip' : options.format + (isSql && options.gzip ? '.gz' : '');

  useEffect(() => {
    let current = true;
    const parent: TreeNode | null = object.schema ? { kind: 'schema', name: object.schema, path: { catalog: object.catalog, database: object.database }, hasChildren: true }
      : object.database ? { kind: 'database', name: object.database, path: { catalog: object.catalog }, hasChildren: true }
      : object.catalog ? { kind: 'catalog', name: object.catalog, path: {}, hasChildren: true } : null;
    void api.meta.children(profileId, parent).then((nodes) => {
      if (!current) return;
      const objects = nodes.filter((node) => node.kind === 'table').map((node) => node.path as ObjectPath);
      for (const target of selectedObjects ?? [object]) if (!objects.some((candidate) => describePath(candidate) === describePath(target))) objects.push(target);
      setTables(objects);
    }).catch((error) => { if (current) setListError(errorInfo(error).message); }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [profileId, object, selectedObjects]);
  useEffect(() => api.exports.onProgress((progress) => { if (progress.exportId === exportId) { setRows(progress.rows); setTotal(progress.total); } }), [exportId]);
  useEffect(() => { if (allCheckbox.current) allCheckbox.current.indeterminate = enabledItems.length > 0 && enabledItems.length < tables.length; }, [enabledItems.length, tables.length]);

  const updateOption = <K extends keyof TableExportOptions>(key: K, value: TableExportOptions[K]) => setOptions((previous) => ({ ...previous, [key]: value }));
  function toggle(target: ObjectPath, field: 'data' | 'structure' | 'drop', checked: boolean) {
    setItems((current) => {
      const existing = current.find((item) => describePath(item.object) === describePath(target)) ?? { object: target, data: false, structure: false, drop: false };
      const updated = !isSql && field === 'data' ? defaultItem(target, checked) : { ...existing, [field]: checked };
      if (field === 'drop' && checked) updated.structure = true;
      if (field === 'structure' && !checked) updated.drop = false;
      return [...current.filter((item) => describePath(item.object) !== describePath(target)), updated];
    });
  }
  async function run() {
    if (running || !enabledItems.length) return;
    setRunning(true);
    const selected = tables.flatMap((table) => { const item = enabledItems.find((item) => describePath(item.object) === describePath(table)); return item ? [item] : []; });
    const start = () => api.tableFiles.export(exportId, profileId, selected, { ...options, suggestedName: fileName });
    const cancel = () => api.tableFiles.cancel(exportId);
    if (exportInBackground) {
      void backgroundTransfer(exportId, 'Export', fileName, start, cancel);
      onClose();
      return;
    }
    setResult(null); setRows(0); setTotal(undefined); setStopping(false);
    setPhase('progress');
    const promise = start();
    inFlight.current = promise;
    let outcome: ExportResult;
    try { outcome = await promise; }
    catch (error) { outcome = { status: 'error', error: errorInfo(error) }; }
    inFlight.current = null;
    if (backgrounded.current) return;
    setRunning(false);
    setStopping(false);
    if (outcome.status === 'ok') {
      if (exportSuccessDialog) { setDonePath(outcome.path); setPhase('success'); }
      else { toast('ok', `Export completed · ${outcome.rows?.toLocaleString() ?? 0} rows`, 'Export'); onClose(); }
    } else {
      if (outcome.status !== 'dialog-cancelled') setResult(outcome);
      setPhase('configure');
    }
  }
  function toBackground() {
    if (!inFlight.current) return;
    backgrounded.current = true;
    void trackTransfer(exportId, 'Export', fileName, inFlight.current, () => api.tableFiles.cancel(exportId));
    onClose();
  }

  const summary = exportSummary(enabledItems.map((item) => item.object.name));
  if (phase === 'progress') return <ExportProgressModal title={enabledItems.length > 1 ? 'Export multiple tables' : 'Export table'} summary={summary} rows={rows} total={total} stopping={stopping} onStop={() => { setStopping(true); void api.tableFiles.cancel(exportId).catch(() => setStopping(false)); }} onBackground={toBackground} />;
  if (phase === 'success') return <ExportSuccessModal path={donePath} onClose={onClose} />;

  return <>
    <Modal title="Export tables" onClose={() => { if (!running && !customize) onClose(); }} footer={<>
      {running && <><Spinner /><span className="muted">Starting export…</span></>}
      <span className="spacer" />
      <button className="btn" disabled={running} onClick={onClose}>Cancel</button><button className="btn primary" disabled={running || !enabledItems.length || !fileName.trim()} onClick={() => void run()}>Export…</button>
    </>}>
      <fieldset className="table-transfer-fieldset" disabled={running}>
        <div className="table-export-layout">
          <section className="table-export-items" aria-label="Tables to export">
            <div className="table-export-list-head"><b>Items</b><label className="check"><input ref={allCheckbox} type="checkbox" aria-label="Select all tables" checked={enabledItems.length === tables.length && tables.length > 0} onChange={(event) => setItems(tables.map((table) => defaultItem(table, event.target.checked)))} />All</label></div>
            <div className={`table-export-column-head${isSql ? ' with-sql' : ''}`}><span>{object.schema ?? object.database ?? object.catalog ?? 'Tables'}</span>{isSql && <><span title="Create table structure">Structure</span><span title="DROP TABLE before CREATE">Drop</span></>}<span>Data</span></div>
            <div className="table-export-table-list">
              {loading && <span className="muted"><Spinner /> Loading tables…</span>}
              {tables.map((table) => {
                const item = items.find((item) => describePath(item.object) === describePath(table));
                return <div key={describePath(table)} className={`table-export-object${isSql ? ' with-sql' : ''}`}><span title={describePath(table)}>▦ {table.name}</span>
                  {isSql && <><input aria-label={`${table.name}: Structure`} type="checkbox" disabled={isView(table)} checked={!!item?.structure} onChange={(event) => toggle(table, 'structure', event.target.checked)} /><input aria-label={`${table.name}: Drop`} type="checkbox" disabled={isView(table)} checked={!!item?.drop} onChange={(event) => toggle(table, 'drop', event.target.checked)} /></>}
                  <input aria-label={`${table.name}: Data`} type="checkbox" checked={!!item?.data} onChange={(event) => toggle(table, 'data', event.target.checked)} /></div>;
              })}
            </div>
            {listError && <div className="muted small">Could not list other tables: {listError}</div>}
          </section>
          <section className="table-export-settings">
            <div className="segmented table-export-formats" role="group" aria-label="Export format">{(['csv', 'json', 'sql', 'xlsx'] as TableFileFormat[]).map((format) => <button key={format} className={options.format === format ? 'on' : ''} onClick={() => updateOption('format', format)}>{format === 'xlsx' ? 'EXCEL' : format.toUpperCase()}</button>)}</div>
            <div className="table-export-format-options">
              {options.format === 'csv' && <>
                <label className="check"><input type="checkbox" checked={options.nullToEmpty} onChange={(event) => updateOption('nullToEmpty', event.target.checked)} />Convert NULL to empty</label>
                <label className="check"><input type="checkbox" checked={options.replaceLineBreaks} onChange={(event) => updateOption('replaceLineBreaks', event.target.checked)} />Convert line breaks to spaces</label>
                <label className="check"><input type="checkbox" checked={options.headers} onChange={(event) => updateOption('headers', event.target.checked)} />Put field names in the first row</label>
                <div className="table-export-option-grid">
                  <label htmlFor="export-delimiter">Delimiter</label><select id="export-delimiter" className="select" value={options.delimiter} onChange={(event) => updateOption('delimiter', event.target.value)}><option value=",">Comma (,)</option><option value=";">Semicolon (;)</option><option value={'\t'}>Tab</option><option value="|">Pipe (|)</option></select>
                  <label htmlFor="export-quote">Quote</label><select id="export-quote" className="select" value={options.quote} onChange={(event) => updateOption('quote', event.target.value as 'needed' | 'all')}><option value="needed">If needed</option><option value="all">All fields</option></select>
                  <label htmlFor="export-linebreak">Line break</label><select id="export-linebreak" className="select" value={options.lineBreak} onChange={(event) => updateOption('lineBreak', event.target.value as '\n' | '\r\n')}><option value={'\n'}>LF (\n)</option><option value={'\r\n'}>CRLF (\r\n)</option></select>
                  <label htmlFor="export-decimal">Decimal</label><select id="export-decimal" className="select" value={options.decimal} onChange={(event) => updateOption('decimal', event.target.value as '.' | ',')}><option value=".">.</option><option value=",">,</option></select>
                </div>
                <label className="check"><input type="checkbox" checked={options.bom} onChange={(event) => updateOption('bom', event.target.checked)} />UTF-8 BOM (for Excel)</label>
                <span className="muted small">Empty strings are quoted to distinguish them from NULL.</span>
              </>}
              {options.format === 'json' && <p className="muted">Export data as a JSON array of objects. NULL remains null; precise numeric strings remain strings.</p>}
              {isSql && <><label className="check"><input type="checkbox" checked={options.gzip} onChange={(event) => updateOption('gzip', event.target.checked)} />Compress the file using Gzip</label><p className="muted small">Choose Structure, Drop and Data per table. SQL uses this connection’s dialect. Export reports an error if an exact structure definition is unavailable.</p></>}
              {options.format === 'xlsx' && <><p className="muted">Export one worksheet per table in an Excel workbook.</p><label className="check"><input type="checkbox" checked={options.headers} onChange={(event) => updateOption('headers', event.target.checked)} />Include column headers</label><span className="muted small">Text stays text, including long numeric strings and values starting with “=”.</span></>}
            </div>
            <div className="table-export-filename"><label htmlFor="table-export-filename">File name</label><input id="table-export-filename" className="input" value={fileName} onChange={(event) => setFileName(event.target.value)} /><span className="muted">.{extension}</span><button className="btn" onClick={() => { setDraftPattern(pattern); setCustomize(true); }}>Customize…</button></div>
            <div className="muted small">{enabledItems.length} {enabledItems.length === 1 ? 'table' : 'tables'} selected{extension === 'zip' ? ' · One file per table, bundled in ZIP' : ''}</div>
          </section>
        </div>
      </fieldset>
      {result?.status === 'error' && result.error && <ErrorView error={result.error} />}
      {result?.status === 'cancelled-by-user' && <p className="muted">Export stopped. No partial file was saved.</p>}
    </Modal>
    {customize && <Modal narrow title="Customize file name" onClose={() => setCustomize(false)} footer={<><span className="spacer" /><button className="btn" onClick={() => setCustomize(false)}>Cancel</button><button className="btn primary" onClick={() => { setPattern(draftPattern); setFileName(tableFileName(draftPattern, context)); setCustomize(false); }}>Apply</button></>}>
      <div className="col"><label>Pattern<input className="input" autoFocus style={{ width: '100%', marginTop: 6 }} value={draftPattern} onChange={(event) => setDraftPattern(event.target.value)} /></label><span className="muted small">Type a name or insert patterns below. Remove text to remove a pattern.</span><div className="filename-patterns">{FILE_NAME_TOKENS.map((token) => <button className="btn small" key={token} onClick={() => setDraftPattern((value) => value + `{${token}}`)}>{token === 'monthPretty' ? 'month pretty' : token}</button>)}{['_', '-', ' ', '.'].map((separator) => <button className="btn small" key={separator} onClick={() => setDraftPattern((value) => value + separator)}>{separator === ' ' ? 'space' : separator}</button>)}</div><div className="banner"><span className="muted">Preview</span> {tableFileName(draftPattern, context)}.{extension}</div></div>
    </Modal>}
  </>;
}
