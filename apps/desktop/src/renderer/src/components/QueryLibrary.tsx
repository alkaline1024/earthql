import { useCallback, useEffect, useState } from 'react';
import type { ExecContext, StatementResult } from '@earthql/core';
import type { HistoryEntry, SavedQuery } from '../../../shared/api';
import { api, errorInfo } from '../api';
import { filterHistory } from '../history-filter';
import { fillSnippet, snippetVariables } from '../sql-snippets';
import { useApp } from '../store';
import { formatDuration, Modal } from './common';
import { useShortcuts } from './Shortcut';

export function QueryLibrary({
  profileId,
  mode,
  version,
  saving,
  onSavingChange,
  getText,
  ctx,
  onOpen,
  onSaved,
}: {
  profileId: string;
  mode: 'history' | 'saved';
  version: number;
  saving: { name: string; id?: string } | null;
  onSavingChange: (s: { name: string; id?: string } | null) => void;
  getText: () => string;
  ctx: ExecContext;
  onOpen: (sql: string, ctx?: ExecContext) => void;
  onSaved: (q: SavedQuery) => void;
}) {
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [historyProfileId, setHistoryProfileId] = useState(profileId);
  const [historyVersion, setHistoryVersion] = useState(0);
  const [saved, setSaved] = useState<SavedQuery[]>([]);
  const [search, setSearch] = useState('');
  const [historyStatus, setHistoryStatus] = useState<HistoryEntry['status'] | 'all'>('all');
  const [historyFrom, setHistoryFrom] = useState('');
  const [historyThrough, setHistoryThrough] = useState('');
  const [snippet, setSnippet] = useState<SavedQuery | null>(null);
  const [snippetValues, setSnippetValues] = useState<Record<string, string>>({});
  const [confirmClear, setConfirmClear] = useState(false);
  const newSqlTab = useApp((s) => s.newSqlTab);
  const connections = useApp((s) => s.connections);
  const profiles = useApp((s) => s.profiles);
  const toast = useApp((s) => s.toast);
  const sc = useShortcuts();

  const reload = useCallback(() => {
    api.saved.list(profileId).then(setSaved).catch((error) => toast('error', `Queries could not be loaded: ${errorInfo(error).message}`));
  }, [profileId, toast]);

  useEffect(reload, [reload, version, mode]);
  useEffect(() => {
    let active = true;
    setHistory([]);
    api.history.list(historyProfileId).then((entries) => { if (active) setHistory(entries); })
      .catch((error) => { if (active) toast('error', `Query history could not be loaded: ${errorInfo(error).message}`); });
    return () => { active = false; };
  }, [historyProfileId, historyVersion, version, toast]);
  useEffect(() => {
    if (!connections[historyProfileId]) setHistoryProfileId(profileId);
  }, [connections, historyProfileId, profileId]);

  useEffect(() => {
    if (saving && saving.id && !saving.name) {
      const existing = saved.find((s) => s.id === saving.id);
      if (existing) onSavingChange({ ...saving, name: existing.name });
    }
  }, [saving, saved, onSavingChange]);

  const q = search.toLowerCase();
  const hist = filterHistory(history, search, historyStatus, historyFrom, historyThrough);
  const sav = saved.filter((s) => !q || s.name.toLowerCase().includes(q) || s.sql.toLowerCase().includes(q));

  async function doSave(asNew: boolean) {
    if (!saving?.name.trim()) return;
    const sql = getText();
    if (!sql.trim()) {
      toast('error', 'Enter a SQL query first.');
      return;
    }
    const item = await api.saved.save(profileId, { id: asNew ? '' : (saving.id ?? ''), name: saving.name.trim(), sql, context: ctx });
    onSaved(item);
    onSavingChange(null);
    reload();
    toast('ok', `Saved “${item.name}”.`);
  }

  return (
    <div className="side-panel">
      <div className="toolbar" style={{ background: 'transparent' }}>
        <b>{mode === 'history' ? 'Query history' : 'Queries'}</b>
        <span className="spacer" />
        {mode === 'history' &&
          (confirmClear ? (
            <>
              <button className="btn small" onClick={() => setConfirmClear(false)}>
                Keep
              </button>
              <button
                className="btn small danger"
                onClick={async () => {
                  await api.history.clear(historyProfileId);
                  setConfirmClear(false);
                  setHistoryVersion((value) => value + 1);
                }}
              >
                Clear all
              </button>
            </>
          ) : (
            <button className="btn small" disabled={history.length === 0} onClick={() => setConfirmClear(true)}>
              Clear…
            </button>
          ))}
      </div>
      <div style={{ padding: '6px 10px' }}>
        <input className="input" style={{ width: '100%' }} placeholder="Search" value={search} onChange={(e) => setSearch(e.target.value)} />
        {mode === 'history' && <div className="col" style={{ marginTop: 6, gap: 6 }}>
          <label>Connection <select className="select" value={historyProfileId} onChange={(event) => {
            setConfirmClear(false);
            setHistoryProfileId(event.target.value);
          }}>
            {Object.entries(connections).map(([id, connection]) => <option key={id} value={id}>
              {profiles.find(({ profile }) => profile.id === connection.profileId)?.profile.name ?? connection.profileId}
              {connection.scope ? ` (${connection.scope.name})` : ''}
            </option>)}
          </select></label>
          <label>Status <select className="select" value={historyStatus} onChange={(event) => setHistoryStatus(event.target.value as HistoryEntry['status'] | 'all')}>
            <option value="all">All</option><option value="ok">Succeeded</option><option value="error">Failed</option>
            <option value="cancelled">Cancelled</option><option value="outcome_unknown">Outcome unknown</option>
          </select></label>
          <label>From <input className="input" type="date" value={historyFrom} onChange={(event) => setHistoryFrom(event.target.value)} /></label>
          <label>Through <input className="input" type="date" value={historyThrough} onChange={(event) => setHistoryThrough(event.target.value)} /></label>
        </div>}
      </div>
      {mode === 'saved' && saving && (
        <div className="col" style={{ padding: '6px 10px 10px', borderBottom: '1px solid var(--line)' }}>
          <input
            className="input"
            autoFocus
            placeholder="Name for this query"
            value={saving.name}
            onChange={(e) => onSavingChange({ ...saving, name: e.target.value })}
            onKeyDown={(e) => e.key === 'Enter' && void doSave(false)}
          />
          <div className="row">
            <button className="btn small primary" disabled={!saving.name.trim()} onClick={() => void doSave(false)}>
              {saving.id ? 'Update' : 'Save'}
            </button>
            {saving.id && (
              <button className="btn small" disabled={!saving.name.trim()} onClick={() => void doSave(true)}>
                Save as new
              </button>
            )}
            <button className="btn small ghost" onClick={() => onSavingChange(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      <div className="scroll grow">
        {mode === 'history' &&
          (hist.length === 0 ? (
            <div className="tree-msg" style={{ padding: 12 }}>{history.length ? 'No matches.' : 'Queries you run on this connection appear here. History is stored only on this Mac.'}</div>
          ) : (
            hist.map((h) => (
              <div key={h.id} className="hist-item" onDoubleClick={() => historyProfileId === profileId ? onOpen(h.sql, h.context) : newSqlTab(historyProfileId, h.sql, h.context)}>
                <div className="h-sql">{h.sql}</div>
                <div className="h-meta">
                  <StatusDot status={h.status === 'cancelled' ? 'cancelled' : h.status === 'ok' ? 'ok' : h.status === 'outcome_unknown' ? 'outcome_unknown' : 'error'} />
                  <span>{new Date(h.ranAt).toLocaleString()}</span>
                  <span>· {formatDuration(h.durationMs)}</span>
                  <span className="spacer" />
                  <button className="btn small ghost" onClick={() => historyProfileId === profileId ? onOpen(h.sql, h.context) : newSqlTab(historyProfileId, h.sql, h.context)}>
                    Open
                  </button>
                  <button className="btn small ghost" onClick={() => newSqlTab(historyProfileId, h.sql, h.context)}>
                    New tab
                  </button>
                </div>
              </div>
            ))
          ))}
        {mode === 'saved' &&
          (sav.length === 0 ? (
            <div className="tree-msg" style={{ padding: 12 }}>{saved.length ? 'No matches.' : `Save queries you use often with “Add to Queries”${sc.label('save') ? ` (${sc.label('save')})` : ''}. They are kept per connection on this Mac.`}</div>
          ) : (
            sav.map((s) => (
              <div key={s.id} className="hist-item" onDoubleClick={() => onOpen(s.sql, s.context)}>
                <div style={{ fontWeight: 600, marginBottom: 2 }}>{s.name}</div>
                <div className="h-sql">{s.sql}</div>
                <div className="h-meta">
                  <span>{new Date(s.updatedAt).toLocaleDateString()}</span>
                  <span className="spacer" />
                  <button className="btn small ghost" onClick={() => (onOpen(s.sql, s.context), onSaved(s))}>
                    Open
                  </button>
                  <button className="btn small ghost" onClick={() => newSqlTab(profileId, s.sql, s.context, s.name)}>
                    New tab
                  </button>
                  {snippetVariables(s.sql).length > 0 && <button className="btn small ghost" onClick={() => {
                    setSnippetValues(Object.fromEntries(snippetVariables(s.sql).map((name) => [name, ''])));
                    setSnippet(s);
                  }}>Fill variables…</button>}
                  <button
                    className="btn small ghost"
                    style={{ color: 'var(--danger)' }}
                    onClick={async () => {
                      await api.saved.remove(profileId, s.id);
                      reload();
                    }}
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))
          ))}
      </div>
      {snippet && <Modal title={`Fill variables: ${snippet.name}`} narrow onClose={() => setSnippet(null)}>
        <form onSubmit={(event) => {
          event.preventDefault();
          onOpen(fillSnippet(snippet.sql, snippetValues), snippet.context);
          setSnippet(null);
        }}>
          <p className="muted small">Values replace placeholders as SQL text, not bound parameters. Quote and escape values yourself; review the query before running it.</p>
          {snippetVariables(snippet.sql).map((name) => <label key={name} className="col" style={{ marginBottom: 8 }}>
            {name}<input className="input" value={snippetValues[name] ?? ''} onChange={(event) => setSnippetValues((values) => ({ ...values, [name]: event.target.value }))} />
          </label>)}
          <div className="row" style={{ justifyContent: 'flex-end' }}>
            <button type="button" className="btn" onClick={() => setSnippet(null)}>Cancel</button>
            <button type="submit" className="btn primary">Open query</button>
          </div>
        </form>
      </Modal>}
    </div>
  );
}

function StatusDot({ status }: { status: StatementResult['status'] }) {
  const color = status === 'ok' ? 'var(--ok)' : status === 'cancelled' ? 'var(--accent)' : status === 'skipped' ? 'var(--text-3)' : status === 'outcome_unknown' ? 'var(--warn)' : 'var(--danger)';
  return <span className="dot" style={{ background: color }} />;
}
