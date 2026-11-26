import { backgroundTransfer } from '../background-transfer';
import { useEffect, useRef, useState } from 'react';
import { ctxForObject, describePath, type ErrorInfo, type ObjectPath } from '@earthql/core';
import type { TableImportFormat, TableImportPreview, TableImportResult } from '../../../shared/api';
import { api, errorInfo } from '../api';
import { useApp } from '../store';
import { objectHasUnsavedChanges } from '../unsaved-changes';
import { ErrorView, Modal, Spinner } from './common';

export function TableImportDialog({ profileId, object, format, onClose }: { profileId: string; object: ObjectPath; format: TableImportFormat; onClose: () => void }) {
  const backgroundToken = useRef<string | null>(null);
  const [preview, setPreview] = useState<TableImportPreview | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [delimiter, setDelimiter] = useState(',');
  const [headers, setHeaders] = useState(true);
  const [emptyAsNull, setEmptyAsNull] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const [written, setWritten] = useState(0);
  const [error, setError] = useState<ErrorInfo | null>(null);
  const [result, setResult] = useState<TableImportResult | null>(null);
  const toast = useApp((state) => state.toast);
  const unsaved = useApp((state) => objectHasUnsavedChanges(state.tabs, state.gridDrafts, profileId, object, 'table'));
  useEffect(() => {
    if (!preview) return;
    const off = api.exports.onProgress((progress) => { if (progress.exportId === preview.token) setWritten(progress.rows); });
    return () => { off(); if (backgroundToken.current !== preview.token) void api.tableFiles.release(preview.token); };
  }, [preview]);
  async function chooseFile() {
    setReading(true); setError(null);
    try {
      const chosen = await api.tableFiles.read(profileId, object, format, { delimiter, headers });
      if (!chosen) return;
      setResult(null);
      setPreview(chosen);
      setMapping(Object.fromEntries(chosen.columns.map((name, index) => {
        const match = chosen.targetColumns.find((column) => column.name === name && !column.generated)
          ?? (!headers && format === 'csv' ? chosen.targetColumns.filter((column) => !column.generated)[index] : undefined);
        return [name, match?.name ?? ''];
      })));
    } catch (error) { setError(errorInfo(error)); }
    finally { setReading(false); }
  }
  async function run() {
    if (!preview || busy || unsaved) return;
    setBusy(true);
    backgroundToken.current = preview.token;
    void backgroundTransfer(preview.token, 'Import', describePath(object),
      () => api.tableFiles.import(preview.token, mapping, emptyAsNull),
      () => api.tableFiles.cancel(preview.token),
      (response) => {
        if (response.rows || format === 'sql') {
          const state = useApp.getState();
          state.refreshTree(profileId, ctxForObject(object));
          for (const tab of state.tabs) if (tab.profileId === profileId && tab.kind === 'table' && (format === 'sql' || describePath(tab.object) === describePath(object))) state.refreshTab(tab.id, true);
        }
      }).finally(() => api.tableFiles.release(preview.token));
    onClose();
  }
  const mapped = Object.values(mapping).filter(Boolean);
  const invalidMapping = !mapped.length || new Set(mapped).size !== mapped.length;
  return <Modal title={`Import ${format === 'sql' ? 'SQL dump' : format.toUpperCase()}`} onClose={() => { if (!busy && !reading) onClose(); }} footer={<>
    {busy && <><Spinner /><span className="muted">{format === 'sql' ? 'Running SQL statements…' : `${written.toLocaleString()} rows imported…`}</span></>}
    <span className="spacer" />
    {busy ? <button className="btn" onClick={() => { if (preview) void api.tableFiles.cancel(preview.token); }}>Stop import</button> : <><button className="btn" disabled={reading} onClick={onClose}>Cancel</button>{preview && !result && <button className="btn primary" disabled={reading || unsaved || (format !== 'sql' && invalidMapping)} onClick={() => void run()}>Import {format === 'sql' ? `${preview.statements} statements` : `${preview.rows.toLocaleString()} rows`}</button>}</>}
  </>}>
    <div className="col table-import-content">
      <div><span className="muted">Target</span> <b>{describePath(object)}</b></div>
      {format === 'csv' && !preview && <div className="row"><label>Delimiter <select className="select" disabled={reading} value={delimiter} onChange={(event) => setDelimiter(event.target.value)}><option value=",">Comma (,)</option><option value=";">Semicolon (;)</option><option value={'\t'}>Tab</option><option value="|">Pipe (|)</option></select></label><label className="check"><input type="checkbox" checked={headers} disabled={reading} onChange={(event) => setHeaders(event.target.checked)} />First row contains field names</label></div>}
      <div className="row"><button className="btn" disabled={busy || reading} onClick={() => void chooseFile()}>{reading ? <Spinner /> : null}{preview ? 'Choose another file…' : 'Choose file…'}</button><span className="muted">{preview?.fileName ?? 'UTF-8 · Up to 64 MB per file'}</span></div>
      {unsaved && <div className="banner">Save or discard this table’s unsaved cell changes before importing.</div>}
      {preview && format !== 'sql' && <>
        <b>Map fields · {preview.rows.toLocaleString()} rows</b>
        <div className="table-import-mapping"><table className="list"><thead><tr><th>Source field</th><th>Target column</th></tr></thead><tbody>{preview.columns.map((column) => <tr key={column}><td>{column}</td><td><select className="select" aria-label={`Map ${column}`} disabled={busy || !!result} value={mapping[column] ?? ''} onChange={(event) => setMapping((current) => ({ ...current, [column]: event.target.value }))}><option value="">Skip field</option>{preview.targetColumns.filter((target) => !target.generated).map((target) => <option key={target.name} value={target.name}>{target.name} ({target.type})</option>)}</select></td></tr>)}</tbody></table></div>
        <label className="check"><input type="checkbox" checked={emptyAsNull} disabled={busy || !!result} onChange={(event) => setEmptyAsNull(event.target.checked)} />Treat empty strings as NULL</label>
        {new Set(mapped).size !== mapped.length && <div style={{ color: 'var(--danger)' }}>Each target column can only be mapped once.</div>}
        <span className="muted small">Unmapped target columns use database defaults. Rows are inserted in batches; completed batches remain if a later batch fails or the import is stopped.</span>
        <b>Preview · first {preview.sample.length} rows</b>
        <div className="table-import-preview"><table className="list"><thead><tr>{preview.columns.map((column) => <th key={column}>{column}</th>)}</tr></thead><tbody>{preview.sample.map((row, index) => <tr key={index}>{row.map((value, cell) => <td key={cell}>{value === null ? <span className="muted">NULL</span> : value}</td>)}</tr>)}</tbody></table></div>
      </>}
      {preview && format === 'sql' && <><div className="banner">{preview.statements} SQL statements will run in this connection. A dump can create, drop or change objects beyond the selected table. Completed statements remain if a later statement fails.</div><pre className="table-import-sql">{preview.sqlPreview}</pre>{(preview.sqlPreview?.length ?? 0) >= 20000 && <span className="muted small">Showing the first 20,000 characters. The entire file will be executed.</span>}</>}
      {result && result.status !== 'ok' && <div className="banner">{result.status === 'outcome_unknown' ? 'The last operation’s outcome is unknown. Check the database before importing again.' : result.status === 'cancelled' ? 'Import stopped.' : 'Import stopped at an error.'} {result.rows.toLocaleString()} rows were confirmed imported{result.statements !== undefined ? `; ${result.statements} statements completed` : ''}. Choose the file again to start a new import.</div>}
      {(error || result?.error) && <ErrorView error={(error ?? result?.error)!} />}
    </div>
  </Modal>;
}
