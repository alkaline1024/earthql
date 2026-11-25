import { useCallback, useEffect, useRef, useState } from 'react';
import {
  isReadOnlyStatement,
  splitStatements,
  statementAt,
  type CompletionSchema,
  type ErrorInfo,
  type ExecContext,
  type QueryPhase,
  type StatementResult,
  type TreeNode,
} from '@earthql/core';
import type { HistoryEntry, RunResponse, SavedQuery } from '../../../shared/api';
import { api, errorInfo, uid } from '../api';
import { noteError, profileOf, useApp } from '../store';
import { formatSql } from '../sql-format';
import { ContextBar } from './ContextBar';
import { ContextSubmenu } from './ContextSubmenu';
import { DataGrid } from './DataGrid';
import { ExportDialog, type ExportOption } from './ExportDialog';
import { SqlEditor, type SqlEditorHandle } from './SqlEditor';
import { SplitButton, ToolbarDropdown } from './ToolbarMenu';
import { ErrorView, Spinner, formatDuration, plural } from './common';

/** A practical "no cap" sentinel: the SQL itself is never rewritten, this just stops the client
 *  from capping how many rows it pulls from the (already streaming) cursor. */
const NO_LIMIT = Number.MAX_SAFE_INTEGER;
const LIMITS = [100, 500, 1000, 5000, 10000, 50000, 100000, 500000];

const PHASE_TEXT: Record<QueryPhase, string> = {
  connecting: 'Connecting…',
  'waiting-warehouse': 'Waiting for the SQL warehouse (it may be starting)…',
  queued: 'Queued in the warehouse…',
  running: 'Running…',
  fetching: 'Fetching rows…',
};

interface RunState {
  runId: string;
  started: number;
  phase: QueryPhase;
  statementIndex: number;
  statements: number;
  cancel: 'none' | 'requesting' | 'requested' | 'failed';
}

export function SqlTab({
  profileId,
  initialSql,
  context,
  active,
  refreshVersion = 0,
}: {
  profileId: string;
  initialSql: string;
  context: ExecContext;
  active: boolean;
  refreshVersion?: number;
}) {
  const conn = useApp((s) => s.connections[profileId]);
  const profile = profileOf(profileId)?.profile;
  const toast = useApp((s) => s.toast);
  const sqlRunDefault = useApp((s) => s.sqlRunDefault);
  const setSqlRunDefault = useApp((s) => s.setSqlRunDefault);
  const editor = useRef<SqlEditorHandle | null>(null);
  const [ctx, setCtx] = useState<ExecContext>(context);
  const [limit, setLimit] = useState(1000);
  const [schema, setSchema] = useState<CompletionSchema | null>(null);
  const [run, setRun] = useState<RunState | null>(null);
  const [response, setResponse] = useState<RunResponse | null>(null);
  const [results, setResults] = useState<StatementResult[]>([]);
  const [activeResult, setActiveResult] = useState(0);
  const [runError, setRunError] = useState<ErrorInfo | null>(null);
  const [panel, setPanel] = useState<'none' | 'history' | 'saved'>('none');
  const [historyVersion, setHistoryVersion] = useState(0);
  const [exporting, setExporting] = useState<StatementResult | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [saving, setSaving] = useState<{ name: string; id?: string } | null>(null);
  const [now, setNow] = useState(Date.now());
  const [editorHeight, setEditorHeight] = useState<number | null>(null);
  const splitRef = useRef<HTMLDivElement>(null);
  const runRef = useRef<RunState | null>(null);
  runRef.current = run;
  const [savedId, setSavedId] = useState<string | undefined>();

  // Autocomplete schema for this tab's connection and context.
  useEffect(() => {
    let alive = true;
    api.meta
      .completion(profileId, ctx)
      .then((s) => alive && setSchema(s))
      .catch(() => alive && setSchema(null));
    return () => {
      alive = false;
    };
  }, [profileId, ctx, refreshVersion]);

  useEffect(() => api.query.onPhase((e) => {
    if (runRef.current && e.runId === runRef.current.runId) setRun((r) => (r ? { ...r, phase: e.phase, statementIndex: e.statementIndex } : r));
  }), []);

  useEffect(() => {
    if (!run) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [run]);

  const closeCursors = useCallback((rs: StatementResult[]) => {
    for (const r of rs) if (r.cursorId) void api.query.closeCursor(r.cursorId);
  }, []);

  // Close open cursors when the tab goes away.
  const resultsRef = useRef(results);
  resultsRef.current = results;
  useEffect(() => () => closeCursors(resultsRef.current), [closeCursors]);

  const execute = useCallback(async (mode: 'current' | 'all') => {
    if (!profile || runRef.current) return;
    const selection = editor.current?.getSelection() ?? '';
    let text: string;
    if (selection.trim()) {
      text = selection;
    } else if (mode === 'all') {
      text = editor.current?.getText() ?? '';
    } else {
      const whole = editor.current?.getText() ?? '';
      const cursor = editor.current?.getCursor() ?? 0;
      text = statementAt(splitStatements(whole, profile.driver), cursor)?.sql ?? whole;
    }
    if (!text.trim()) return;
    const statements = splitStatements(text, profile.driver).length;
    if (statements === 0) return;
    closeCursors(results);
    const runId = uid();
    setRun({ runId, started: Date.now(), phase: 'connecting', statementIndex: 0, statements, cancel: 'none' });
    setRunError(null);
    try {
      const res = await api.query.run(profileId, runId, text, ctx, limit);
      setResponse(res);
      setResults(res.results);
      // Show the first failed / cancelled statement, else the last one with rows, else the last.
      const failed = res.results.findIndex((r) => r.status !== 'ok' && r.status !== 'skipped');
      const lastRows = [...res.results].reverse().findIndex((r) => r.columns);
      setActiveResult(failed >= 0 ? failed : lastRows >= 0 ? res.results.length - 1 - lastRows : res.results.length - 1);
      for (const r of res.results) if (r.error) noteError(profileId, r.error);
    } catch (e) {
      const info = errorInfo(e);
      noteError(profileId, info);
      setRunError(info);
      setResults([]);
      setResponse(null);
    } finally {
      setRun(null);
      setHistoryVersion((v) => v + 1);
    }
  }, [profile, profileId, ctx, limit, results, closeCursors]);

  const cancel = useCallback(async () => {
    const r = runRef.current;
    if (!r) return;
    setRun((x) => (x ? { ...x, cancel: 'requesting' } : x));
    const res = await api.query.cancel(r.runId).catch(() => 'failed' as const);
    setRun((x) => (x ? { ...x, cancel: res === 'failed' ? 'failed' : 'requested' } : x));
  }, []);

  const saveQuery = useCallback(() => {
    setSaving({ name: '', id: savedId });
    setPanel('saved');
  }, [savedId]);

  const beautify = useCallback((scope: 'default' | 'selection' | 'all') => {
    if (!profile || !editor.current) return;
    try {
      const range = scope !== 'all' ? editor.current.getSelectionRange() : null;
      if (range) {
        const selected = editor.current.getText().slice(range.from, range.to);
        editor.current.replaceRange(range.from, range.to, formatSql(selected, profile.driver));
      } else {
        editor.current.setText(formatSql(editor.current.getText(), profile.driver));
      }
    } catch (e) {
      toast('error', `Could not format this SQL: ${errorInfo(e).message}`);
    }
  }, [profile, toast]);

  const saveSqlFile = useCallback(async () => {
    const text = editor.current?.getText() ?? '';
    if (!text.trim()) {
      toast('error', 'The editor is empty.');
      return;
    }
    try {
      const res = await api.query.saveFile(text, `${(profile?.name || 'query').replace(/\s+/g, '-')}.sql`);
      if (res.status === 'ok') toast('ok', `Saved to ${res.path}.`);
    } catch (e) {
      toast('error', errorInfo(e).message);
    }
  }, [profile, toast]);

  useEffect(() => {
    if (!active) return;
    return window.earthqlBridge.on('menu:command', (cmd) => {
      if (cmd === 'run') void execute(sqlRunDefault);
      if (cmd === 'run-all') void execute('all');
      if (cmd === 'cancel') void cancel();
      if (cmd === 'save') saveQuery();
      if (cmd === 'beautify') beautify('default');
      if (cmd === 'save-sql-file') void saveSqlFile();
    });
  }, [active, execute, cancel, saveQuery, beautify, saveSqlFile, sqlRunDefault]);

  async function loadMore(r: StatementResult) {
    if (!r.cursorId) return;
    setLoadingMore(true);
    try {
      const chunk = await api.query.more(r.cursorId, limit);
      setResults((rs) =>
        rs.map((x) =>
          x.index === r.index ? { ...x, rows: [...(x.rows ?? []), ...chunk.rows], hasMore: !chunk.done, cursorId: chunk.done ? undefined : x.cursorId } : x,
        ),
      );
    } catch (e) {
      const info = errorInfo(e);
      toast('error', info.message);
      setResults((rs) => rs.map((x) => (x.index === r.index ? { ...x, cursorId: undefined } : x)));
    } finally {
      setLoadingMore(false);
    }
  }

  if (!conn || !profile) return null;
  const current = results[activeResult];
  const elapsed = run ? now - run.started : 0;

  return (
    <>
      <ContextBar profileId={profileId} target={<ContextPicker profileId={profileId} ctx={ctx} onChange={setCtx} />} kindLabel="SQL">
        <button className={`btn small${panel === 'history' ? ' primary' : ''}`} onClick={() => setPanel((p) => (p === 'history' ? 'none' : 'history'))}>
          History
        </button>
        <button className={`btn small${panel === 'saved' ? ' primary' : ''}`} onClick={() => setPanel((p) => (p === 'saved' ? 'none' : 'saved'))}>
          Saved
        </button>
      </ContextBar>
      <div className="toolbar">
        <ToolbarDropdown
          trigger={limit === NO_LIMIT ? 'No limit' : `${limit.toLocaleString()} rows`}
          title={`Limit rows fetched (${profile.driver === 'mssql' ? 'TOP' : 'LIMIT'})`}
          disabled={!!run}
        >
          {(close) => (
            <>
              <button type="button" role="menuitem" onClick={() => { setLimit(NO_LIMIT); close(); }}>No limit</button>
              <div className="conn-menu-separator" role="separator" />
              {LIMITS.map((n) => (
                <button type="button" key={n} role="menuitem" onClick={() => { setLimit(n); close(); }}>
                  {n.toLocaleString()} rows
                </button>
              ))}
            </>
          )}
        </ToolbarDropdown>
        <SplitButton label="Beautify" title="Format SQL (⌘I)" menuLabel="Beautify options" disabled={!!run} onClick={() => beautify('default')}>
          {(close) => (
            <>
              <button type="button" role="menuitem" onClick={() => { beautify('selection'); close(); }}>Format Selection</button>
              <button type="button" role="menuitem" onClick={() => { beautify('all'); close(); }}>Format Entire Query</button>
            </>
          )}
        </SplitButton>
        {run ? (
          <button className="btn small danger" onClick={() => void cancel()} disabled={run.cancel === 'requesting'} title="Cancel (⌘.)">
            ■ Cancel
          </button>
        ) : (
          <SplitButton
            label={sqlRunDefault === 'all' ? '▶ Run All' : '▶ Run Current'}
            title={sqlRunDefault === 'all' ? 'Run the whole query (⇧⌘↵)' : 'Run the selection, or the statement under the cursor (⌘↵)'}
            className="primary"
            menuLabel="Run options"
            align="right"
            onClick={() => void execute(sqlRunDefault)}
          >
            {(close) => (
              <>
                <button type="button" role="menuitem" onClick={() => { void execute('all'); close(); }}><span>Run All</span><kbd>⇧⌘↵</kbd></button>
                <button type="button" role="menuitem" onClick={() => { void execute('current'); close(); }}><span>Run Current</span><kbd>⌘↵</kbd></button>
                <div className="conn-menu-separator" role="separator" />
                <button type="button" role="menuitem" onClick={() => { saveQuery(); close(); }}>Add to Queries</button>
                <div className="conn-menu-separator" role="separator" />
                <button type="button" role="menuitem" onClick={() => { void saveSqlFile(); close(); }}><span>Save SQL as…</span><kbd>⇧⌘S</kbd></button>
                <div className="conn-menu-separator" role="separator" />
                <ContextSubmenu label="Default">
                  <button type="button" role="menuitemradio" aria-checked={sqlRunDefault === 'current'} className={`radio-item${sqlRunDefault === 'current' ? ' on' : ''}`} onClick={() => { setSqlRunDefault('current'); close(); }}>
                    Run Current
                  </button>
                  <button type="button" role="menuitemradio" aria-checked={sqlRunDefault === 'all'} className={`radio-item${sqlRunDefault === 'all' ? ' on' : ''}`} onClick={() => { setSqlRunDefault('all'); close(); }}>
                    Run All
                  </button>
                </ContextSubmenu>
              </>
            )}
          </SplitButton>
        )}
        <span className="spacer" />
        {run && (
          <span className="row small">
            <Spinner />
            {run.statements > 1 && <span className="muted">Statement {run.statementIndex + 1} of {run.statements} ·</span>}
            <span>{run.cancel === 'requested' ? 'Cancel requested — waiting for the database to confirm…' : run.cancel === 'failed' ? 'Cancel request failed; still running…' : PHASE_TEXT[run.phase]}</span>
            <span className="muted">{formatDuration(elapsed)}</span>
          </span>
        )}
        {!run && response && <RunSummary response={response} results={results} />}
      </div>
      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <div className="sql-split" ref={splitRef}>
          <div style={{ height: editorHeight ?? '40%', minHeight: 90, display: 'flex', flexDirection: 'column' }}>
            <SqlEditor driver={profile.driver} initial={initialSql} schema={schema} handleRef={editor} />
          </div>
          <div
            className="splitter"
            onMouseDown={(e) => {
              const top = splitRef.current!.getBoundingClientRect().top;
              const move = (ev: MouseEvent) => setEditorHeight(Math.max(90, Math.min(ev.clientY - top, splitRef.current!.clientHeight - 120)));
              const up = () => {
                window.removeEventListener('mousemove', move);
                window.removeEventListener('mouseup', up);
              };
              window.addEventListener('mousemove', move);
              window.addEventListener('mouseup', up);
              e.preventDefault();
            }}
          />
          <div className="results">
            {runError && (
              <div style={{ padding: 12 }}>
                <ErrorView error={runError} />
              </div>
            )}
            {!runError && results.length === 0 && !run && (
              <div className="state">
                <p>
                  Run a query to see results here. <span className="kbd">⌘</span> <span className="kbd">↵</span> runs the selection, or {sqlRunDefault === 'all' ? 'the whole editor' : 'the statement under the cursor'}.
                </p>
                {schema?.truncated && <p className="muted small">Autocomplete shows only part of this database (very many columns).</p>}
              </div>
            )}
            {run && results.length === 0 && (
              <div className="state">
                <Spinner />
                <p>{PHASE_TEXT[run.phase]}</p>
              </div>
            )}
            {results.length > 1 && (
              <div className="result-tabs">
                {results.map((r, i) => (
                  <button key={i} className={i === activeResult ? 'on' : ''} onClick={() => setActiveResult(i)} title={r.sql}>
                    <StatusDot status={r.status} />
                    {i + 1}. {r.command || 'Statement'}
                    {r.columns ? ` (${(r.rows?.length ?? 0).toLocaleString()}${r.hasMore ? '+' : ''})` : ''}
                  </button>
                ))}
              </div>
            )}
            {current && (
              <ResultView
                key={`${response?.runId}-${current.index}`}
                result={current}
                cancelOutcome={response?.cancel}
                onLoadMore={() => void loadMore(current)}
                loadingMore={loadingMore}
                onExport={() => setExporting(current)}
              />
            )}
          </div>
        </div>
        {panel !== 'none' && (
          <SidePanel
            profileId={profileId}
            mode={panel}
            version={historyVersion + refreshVersion}
            saving={saving}
            onSavingChange={setSaving}
            getText={() => editor.current?.getText() ?? ''}
            ctx={ctx}
            onOpen={(q, ctxOverride) => {
              editor.current?.setText(q);
              if (ctxOverride) setCtx(ctxOverride);
              editor.current?.focus();
            }}
            onSaved={(q) => setSavedId(q.id)}
          />
        )}
      </div>
      {exporting && (
        <ExportDialog name={profile.name.replace(/\s+/g, '-') + '-query'} options={exportOptions(exporting, profileId, ctx, profile.driver)}
          onClose={() => setExporting(null)}
          onExported={(id) => {
            // Exporting the entire result reads the open cursor to the end; it cannot load more afterwards.
            if (id === 'cursor') setResults((rs) => rs.map((x) => (x.index === exporting.index ? { ...x, cursorId: undefined } : x)));
          }}
        />
      )}
    </>
  );
}

function exportOptions(r: StatementResult, profileId: string, ctx: ExecContext, driver: Parameters<typeof isReadOnlyStatement>[1]): ExportOption[] {
  const cols = r.columns ?? [];
  const rows = r.rows ?? [];
  if (!r.hasMore) {
    return [{ id: 'all', label: `All rows (${rows.length.toLocaleString()}) — the complete result is loaded`, scope: { kind: 'loaded', columns: cols, rows } }];
  }
  const opts: ExportOption[] = [{ id: 'loaded', label: `Loaded rows only (${rows.length.toLocaleString()})`, scope: { kind: 'loaded', columns: cols, rows } }];
  if (r.cursorId) {
    opts.push({
      id: 'cursor',
      label: 'Entire result',
      detail: 'Writes the loaded rows, then keeps reading the still-open result to the end. The statement is not run again.',
      scope: { kind: 'cursor', cursorId: r.cursorId, columns: cols, rows },
    });
  } else if (isReadOnlyStatement(r.sql, driver)) {
    opts.push({
      id: 'rerun',
      label: 'Entire result (runs the statement again)',
      detail: 'The open result was closed, so the read-only statement is executed again and every row is streamed to the file. Data may have changed since.',
      scope: { kind: 'rerun', profileId, sql: r.sql, context: ctx },
    });
  } else {
    opts.push({
      id: 'none',
      label: 'Entire result',
      unavailable: 'the open result was closed and this statement may change data, so EarthQL will not run it again.',
    });
  }
  return opts;
}

function StatusDot({ status }: { status: StatementResult['status'] }) {
  const color = status === 'ok' ? 'var(--ok)' : status === 'cancelled' ? 'var(--accent)' : status === 'skipped' ? 'var(--text-3)' : status === 'outcome_unknown' ? 'var(--warn)' : 'var(--danger)';
  return <span className="dot" style={{ background: color }} />;
}

function RunSummary({ response, results }: { response: RunResponse; results: StatementResult[] }) {
  const total = results.reduce((a, r) => a + r.durationMs, 0);
  const errors = results.filter((r) => r.status === 'error').length;
  const unknown = results.some((r) => r.status === 'outcome_unknown');
  return (
    <span className="row small">
      {response.cancel === 'confirmed' && <span className="pill info">Cancelled — confirmed by the database</span>}
      {response.cancel === 'completed-before-cancel' && <span className="pill">Finished before the cancel took effect</span>}
      {unknown && <span className="pill warn">Write result unknown</span>}
      {errors > 0 && <span className="pill danger">{plural(errors, 'error')}</span>}
      {response.cancel === 'none' && errors === 0 && !unknown && <span className="pill ok">Success</span>}
      <span className="muted">{formatDuration(total)}</span>
    </span>
  );
}

function ResultView({
  result,
  cancelOutcome,
  onLoadMore,
  loadingMore,
  onExport,
}: {
  result: StatementResult;
  cancelOutcome?: RunResponse['cancel'];
  onLoadMore: () => void;
  loadingMore: boolean;
  onExport: () => void;
}) {
  if (result.status === 'skipped')
    return (
      <div className="state">
        <p>Not run — an earlier statement failed or the run was cancelled.</p>
        <pre className="sql" style={{ maxWidth: 640 }}>{result.sql}</pre>
      </div>
    );
  if (result.error) {
    return (
      <div style={{ padding: 12 }} className="col scroll">
        <ErrorView error={result.error} />
        {result.status === 'cancelled' && cancelOutcome === 'confirmed' && <div className="muted small">The database confirmed the cancellation. You can run the next query now.</div>}
        <pre className="sql">{result.sql}</pre>
      </div>
    );
  }
  if (!result.columns) {
    return (
      <div className="state">
        <div className="big-ico">✓</div>
        <h3>{result.command || 'Statement'} completed</h3>
        <p>
          {result.rowsAffected !== undefined ? plural(result.rowsAffected, 'row') + ' affected' : 'No rows returned'} · {formatDuration(result.durationMs)}
        </p>
        {result.notices?.map((n, i) => (
          <p key={i} className="muted small">
            {n}
          </p>
        ))}
      </div>
    );
  }
  const rows = result.rows ?? [];
  return (
    <>
      <DataGrid columns={result.columns} rows={rows} emptyText="The query returned no rows." />
      <div className="statusbar">
        <span>{plural(rows.length, 'row')} loaded</span>
        {result.hasMore ? (
          <span className="pill warn" title="The app stopped loading at the row limit; more rows exist.">
            Limited to {rows.length.toLocaleString()} rows — more available
          </span>
        ) : (
          <span className="pill">Complete result</span>
        )}
        {result.hasMore &&
          (result.cursorId ? (
            <button className="btn small" onClick={onLoadMore} disabled={loadingMore}>
              {loadingMore ? <Spinner /> : null} Load {result.limit?.toLocaleString()} more
            </button>
          ) : (
            <span className="muted">Run this statement on its own to load more.</span>
          ))}
        <span className="muted">{formatDuration(result.durationMs)}</span>
        {result.notices && result.notices.length > 0 && (
          <span className="muted" title={result.notices.join('\n')} style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
            ⓘ {result.notices[0]}
          </span>
        )}
        <span className="spacer" />
        <button className="btn small" onClick={onExport}>
          Export CSV…
        </button>
      </div>
    </>
  );
}

function ContextPicker({ profileId, ctx, onChange }: { profileId: string; ctx: ExecContext; onChange: (c: ExecContext) => void }) {
  const conn = useApp((s) => s.connections[profileId]);
  const hierarchy = conn?.capabilities.hierarchy ?? [];
  const topKind = hierarchy[0] as 'catalog' | 'database';
  const hasSchema = hierarchy.includes('schema');
  const top = topKind === 'catalog' ? ctx.catalog : ctx.database;
  const [tops, setTops] = useState<string[]>([]);
  const [schemas, setSchemas] = useState<string[]>([]);

  useEffect(() => {
    api.meta.children(profileId, null).then((n) => setTops(n.map((x) => x.name))).catch(() => setTops([]));
  }, [profileId]);

  useEffect(() => {
    if (!hasSchema || !top) return setSchemas([]);
    const node: TreeNode = { kind: topKind, name: top, path: {}, hasChildren: true };
    api.meta.children(profileId, node).then((n) => setSchemas(n.map((x) => x.name))).catch(() => setSchemas([]));
  }, [profileId, top, topKind, hasSchema]);

  const setTop = (v: string) => onChange(topKind === 'catalog' ? { catalog: v || undefined, schema: undefined } : { ...ctx, database: v || undefined, schema: undefined });

  return (
    <span className="row" style={{ gap: 4 }}>
      <select className="select" style={{ height: 22, maxWidth: 200 }} value={top ?? ''} onChange={(e) => setTop(e.target.value)} title={topKind === 'catalog' ? 'Catalog' : 'Database'}>
        <option value="">{topKind === 'catalog' ? '(session catalog)' : '(default database)'}</option>
        {[...new Set([top, ...tops].filter((x): x is string => !!x))].map((x) => (
          <option key={x}>{x}</option>
        ))}
      </select>
      {hasSchema && (
        <>
          <span className="sep">.</span>
          <select className="select" style={{ height: 22, maxWidth: 200 }} value={ctx.schema ?? ''} onChange={(e) => onChange({ ...ctx, schema: e.target.value || undefined })} title="Schema">
            <option value="">(default schema)</option>
            {[...new Set([ctx.schema, ...schemas].filter((x): x is string => !!x))].map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
        </>
      )}
    </span>
  );
}

function SidePanel({
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
        <b>{mode === 'history' ? 'Query history' : 'Saved queries'}</b>
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
            <div className="tree-msg" style={{ padding: 12 }}>{saved.length ? 'No matches.' : 'Save queries you use often with “Add to Queries” (⌘S). They are kept per connection on this Mac.'}</div>
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
