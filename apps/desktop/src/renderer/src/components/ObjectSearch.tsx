import { useEffect, useRef, useState } from 'react';
import { describePath } from '@earthql/core';
import type { ConnectionScope } from '../../../shared/api';
import { api, errorInfo } from '../api';
import { searchObjects, type ObjectSearchMatch } from '../object-search';
import { useApp } from '../store';
import { Modal, Spinner } from './common';

export function ObjectSearch({ profileId, scope, onClose }: { profileId: string; scope?: ConnectionScope; onClose(): void }) {
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<'objects' | 'columns'>('objects');
  const [matches, setMatches] = useState<ObjectSearchMatch[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [searched, setSearched] = useState(false);
  const [stopped, setStopped] = useState(false);
  const request = useRef(0);
  const openTab = useApp((s) => s.openTab);
  useEffect(() => () => { request.current += 1; }, []);

  async function search() {
    const term = query.trim().toLowerCase();
    if (!term) return;
    const current = ++request.current;
    setBusy(true);
    setStopped(false);
    setSearched(true);
    setMatches([]);
    setErrors([]);
    await searchObjects({
      term, mode, scope,
      children: (parent) => api.meta.children(profileId, parent),
      structure: (path) => api.meta.structure(profileId, path),
      errorMessage: (error) => errorInfo(error).message,
      cancelled: () => request.current !== current,
      progress: (result) => { setMatches(result.matches); setErrors(result.errors); },
    });
    if (request.current === current) setBusy(false);
  }

  return <Modal title="Search database objects" onClose={onClose}>
    <form className="row" onSubmit={(event) => { event.preventDefault(); void search(); }}>
      <select className="select" aria-label="Search type" value={mode} disabled={busy}
        onChange={(event) => setMode(event.target.value === 'columns' ? 'columns' : 'objects')}>
        <option value="objects">Tables and views</option><option value="columns">Columns</option>
      </select>
      <input className="input grow" aria-label="Search text" autoFocus value={query} disabled={busy} onChange={(event) => setQuery(event.target.value)} />
      {busy ? <button type="button" className="btn" onClick={() => { request.current += 1; setBusy(false); setStopped(true); }}>Stop</button>
        : <button className="btn primary" disabled={!query.trim()}>Search</button>}
    </form>
    <p className="muted small">Searches accessible databases and schemas. Column search reads table metadata and may take time.</p>
    {busy && <p><Spinner /> Searching…</p>}
    {stopped && <p className="muted">Search stopped; results may be incomplete.</p>}
    {searched && !busy && !stopped && !matches.length && <p className="muted">No matches found.</p>}
    {!!errors.length && <details><summary>{errors.length} location{errors.length === 1 ? '' : 's'} could not be searched</summary>
      {errors.map((error, index) => <div key={index} className="err">{error}</div>)}
    </details>}
    <div className="scroll" style={{ maxHeight: 360 }}>
      {matches.map(({ node, columns }) => <button key={JSON.stringify([node.kind, node.path])} type="button" className="btn" style={{ display: 'block', width: '100%', textAlign: 'left', marginBottom: 4 }}
        onClick={() => {
          if (!node.path.name || (node.kind !== 'table' && node.kind !== 'view')) return;
          openTab({ kind: 'table', profileId, object: { ...node.path, name: node.path.name }, objectKind: node.kind, initialView: 'data' });
          onClose();
        }}>
        {describePath(node.path)}{columns.length > 0 && <span className="muted"> — {columns.join(', ')}</span>}
      </button>)}
    </div>
  </Modal>;
}
