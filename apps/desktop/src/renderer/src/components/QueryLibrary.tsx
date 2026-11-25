import { useCallback, useEffect, useState } from 'react';
import type { ExecContext, StatementResult } from '@earthql/core';
import type { HistoryEntry, SavedQuery } from '../../../shared/api';
import { api } from '../api';
import { useApp } from '../store';
import { formatDuration } from './common';
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
  const [saved, setSaved] = useState<SavedQuery[]>([]);
  const [search, setSearch] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);
  const newSqlTab = useApp((s) => s.newSqlTab);
  const toast = useApp((s) => s.toast);
  const sc = useShortcuts();

  const reload = useCallback(() => {
    api.history.list(profileId).then(setHistory).catch(() => setHistory([]));
    api.saved.list(profileId).then(setSaved).catch(() => setSaved([]));
  }, [profileId]);

  useEffect(reload, [reload, version, mode]);

  useEffect(() => {
    if (saving && saving.id && !saving.name) {
      const existing = saved.find((s) => s.id === saving.id);
      if (existing) onSavingChange({ ...saving, name: existing.name });
    }
  }, [saving, saved, onSavingChange]);

  const q = search.toLowerCase();
  const hist = history.filter((h) => !q || h.sql.toLowerCase().includes(q));
  const sav = saved.filter((s) => !q || s.name.toLowerCase().includes(q) || s.sql.toLowerCase().includes(q));

  async function doSave(asNew: boolean) {
    if (!saving?.name.trim()) return;
    const sql = getText();
    if (!sql.trim()) {
      toast('error', 'The editor is empty.');
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
                  await api.history.clear(profileId);
                  setConfirmClear(false);
                  reload();
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
              <div key={h.id} className="hist-item" onDoubleClick={() => onOpen(h.sql, h.context)}>
                <div className="h-sql">{h.sql}</div>
                <div className="h-meta">
                  <StatusDot status={h.status === 'cancelled' ? 'cancelled' : h.status === 'ok' ? 'ok' : h.status === 'outcome_unknown' ? 'outcome_unknown' : 'error'} />
                  <span>{new Date(h.ranAt).toLocaleString()}</span>
                  <span>· {formatDuration(h.durationMs)}</span>
                  <span className="spacer" />
                  <button className="btn small ghost" onClick={() => onOpen(h.sql, h.context)}>
                    Open
                  </button>
                  <button className="btn small ghost" onClick={() => newSqlTab(profileId, h.sql, h.context)}>
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
    </div>
  );
}

function StatusDot({ status }: { status: StatementResult['status'] }) {
  const color = status === 'ok' ? 'var(--ok)' : status === 'cancelled' ? 'var(--accent)' : status === 'skipped' ? 'var(--text-3)' : status === 'outcome_unknown' ? 'var(--warn)' : 'var(--danger)';
  return <span className="dot" style={{ background: color }} />;
}
