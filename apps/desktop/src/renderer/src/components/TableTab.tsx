import { useCallback, useEffect, useState } from 'react';
import {
  describePath,
  type BrowseResult,
  type ErrorInfo,
  type Filter,
  type FilterOp,
  type ObjectKind,
  type ObjectPath,
  type ObjectPrivileges,
  type SectionStatus,
  type Sort,
  type TableStructure,
} from '@earthql/core';
import { api, errorInfo } from '../api';
import { noteError, profileOf, useApp } from '../store';
import { DataGrid } from './DataGrid';
import { ContextBar } from './ContextBar';
import { ErrorView, Spinner, StateView, formatDuration } from './common';
import { InsertDialog } from './InsertDialog';
import { ExportDialog } from './ExportDialog';

const OPS: { op: FilterOp; label: string; needsValue: boolean }[] = [
  { op: '=', label: '=', needsValue: true },
  { op: '!=', label: '≠', needsValue: true },
  { op: '<', label: '<', needsValue: true },
  { op: '<=', label: '≤', needsValue: true },
  { op: '>', label: '>', needsValue: true },
  { op: '>=', label: '≥', needsValue: true },
  { op: 'contains', label: 'contains', needsValue: true },
  { op: 'starts_with', label: 'starts with', needsValue: true },
  { op: 'is_null', label: 'is NULL', needsValue: false },
  { op: 'is_not_null', label: 'is not NULL', needsValue: false },
];

const PAGE_SIZES = [50, 100, 200, 500, 1000];

export function TableTab({
  tabId,
  profileId,
  object,
  objectKind,
  initialView,
  active,
}: {
  tabId: string;
  profileId: string;
  object: ObjectPath;
  objectKind: ObjectKind;
  initialView?: 'data' | 'structure';
  active: boolean;
}) {
  const [view, setView] = useState<'data' | 'structure'>(initialView ?? 'data');
  const [structure, setStructure] = useState<TableStructure | null>(null);
  const [structureErr, setStructureErr] = useState<ErrorInfo | null>(null);
  const [privileges, setPrivileges] = useState<ObjectPrivileges | null>(null);
  const [dataVersion, setDataVersion] = useState(0);
  const conn = useApp((s) => s.connections[profileId]);
  const profile = profileOf(profileId)?.profile;

  const loadStructure = useCallback(
    async (refresh = false) => {
      setStructureErr(null);
      try {
        setStructure(await api.meta.structure(profileId, object, refresh));
      } catch (e) {
        const info = errorInfo(e);
        noteError(profileId, info);
        setStructureErr(info);
      }
    },
    [profileId, object],
  );

  useEffect(() => {
    void loadStructure();
    api.meta
      .privileges(profileId, object)
      .then(setPrivileges)
      .catch(() => setPrivileges({ select: 'unknown', insert: 'unknown' }));
  }, [loadStructure, profileId, object]);

  if (!conn || !profile) return <StateView title="Not connected" />;

  // Why Insert is (not) available — capability, object type, then the account's privilege.
  const kind = structure?.kind ?? objectKind;
  let insertBlocked: string | null = null;
  if (!conn.capabilities.insert) insertBlocked = 'This driver does not support inserting from the form.';
  else if (kind === 'view') insertBlocked = 'This is a view. Insert rows into its base table instead.';
  else if (privileges?.insert === 'no') insertBlocked = privileges.reason ?? 'This account has no INSERT privilege on this table.';
  else if (structure && structure.columnsStatus.state !== 'ok') insertBlocked = 'The column list could not be read, so the form cannot be built.';

  return (
    <>
      <ContextBar profileId={profileId} target={describePath(object)} kindLabel={kind === 'view' ? 'View' : 'Table'}>
        <div className="subtabs">
          <button className={view === 'data' ? 'on' : ''} onClick={() => setView('data')}>
            Data
          </button>
          <button className={view === 'structure' ? 'on' : ''} onClick={() => setView('structure')}>
            Structure
          </button>
        </div>
      </ContextBar>
      {view === 'data' ? (
        <DataView
          key={dataVersion}
          tabId={tabId}
          profileId={profileId}
          object={object}
          structure={structure}
          insertBlocked={insertBlocked}
          insertUnknown={privileges?.insert === 'unknown'}
          active={active}
          onInserted={() => setDataVersion((v) => v + 1)}
        />
      ) : (
        <StructureView structure={structure} error={structureErr} onRefresh={() => void loadStructure(true)} />
      )}
    </>
  );
}

function DataView({
  tabId,
  profileId,
  object,
  structure,
  insertBlocked,
  insertUnknown,
  active,
  onInserted,
}: {
  tabId: string;
  profileId: string;
  object: ObjectPath;
  structure: TableStructure | null;
  insertBlocked: string | null;
  insertUnknown: boolean;
  active: boolean;
  onInserted: () => void;
}) {
  const [filters, setFilters] = useState<Filter[]>([]);
  const [draftFilters, setDraftFilters] = useState<Filter[]>([]);
  const [sort, setSort] = useState<Sort | undefined>();
  const [offset, setOffset] = useState(0);
  const [pageSize, setPageSize] = useState(100);
  const [result, setResult] = useState<BrowseResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<ErrorInfo | null>(null);
  const [showInsert, setShowInsert] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const driver = profileOf(profileId)?.profile.driver;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setResult(await api.data.browse(profileId, { object, filters, sort, offset, pageSize }));
    } catch (e) {
      const info = errorInfo(e);
      noteError(profileId, info);
      setError(info);
    } finally {
      setLoading(false);
    }
  }, [profileId, object, filters, sort, offset, pageSize]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!active) return;
    const off = window.earthqlBridge.on('menu:command', (cmd) => {
      if (cmd === 'refresh') void load();
    });
    return off;
  }, [active, load]);

  const columnNames = structure?.columns.map((c) => c.name) ?? result?.columns.map((c) => c.name) ?? [];

  const toggleSort = (column: string) => {
    setOffset(0);
    setSort((s) => (s?.column !== column ? { column, dir: 'asc' } : s.dir === 'asc' ? { column, dir: 'desc' } : undefined));
  };

  const applyFilters = () => {
    const valid = draftFilters.filter((f) => f.column && (OPS.find((o) => o.op === f.op)?.needsValue ? f.value !== undefined && f.value !== '' : true));
    setOffset(0);
    setFilters(valid);
  };

  const page = Math.floor(offset / pageSize) + 1;
  const rowsShown = result?.rows.length ?? 0;

  return (
    <>
      <div className="toolbar">
        <button
          className="btn small"
          onClick={() => setDraftFilters((f) => [...f, { column: columnNames[0] ?? '', op: '=', value: '' }])}
          disabled={columnNames.length === 0}
        >
          ＋ Filter
        </button>
        {filters.length > 0 && <span className="pill info">{filters.length} filter{filters.length > 1 ? 's' : ''} applied</span>}
        {sort && (
          <span className="pill info">
            Sorted by {sort.column} {sort.dir === 'asc' ? '▲' : '▼'}
            <span style={{ cursor: 'default', marginLeft: 4 }} onClick={() => setSort(undefined)}>
              ✕
            </span>
          </span>
        )}
        <span className="spacer" />
        <button className="btn small" onClick={() => void load()} disabled={loading} title="Refresh (⌘R)">
          ↻ Refresh
        </button>
        <button className="btn small" onClick={() => setShowExport(true)} disabled={!result}>
          Export CSV…
        </button>
        <span title={insertBlocked ?? (insertUnknown ? 'The database will check your privileges when you insert.' : '')}>
          <button className="btn small primary" disabled={!!insertBlocked || !structure} onClick={() => setShowInsert(true)}>
            ＋ Insert rows
          </button>
        </span>
      </div>
      {insertBlocked && (
        <div className="banner" style={{ background: 'var(--bg-sunken)', borderBottomColor: 'var(--line)' }}>
          <span className="muted">Insert unavailable:</span> {insertBlocked}
        </div>
      )}

      {draftFilters.length > 0 && (
        <div className="filters">
          {draftFilters.map((f, i) => {
            const meta = OPS.find((o) => o.op === f.op)!;
            const upd = (patch: Partial<Filter>) => setDraftFilters((fs) => fs.map((x, j) => (j === i ? { ...x, ...patch } : x)));
            return (
              <div key={i} className="filter-row">
                <span className="muted small" style={{ width: 34, textAlign: 'right' }}>
                  {i === 0 ? 'where' : 'and'}
                </span>
                <select className="select" value={f.column} onChange={(e) => upd({ column: e.target.value })}>
                  {columnNames.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
                <select className="select" value={f.op} onChange={(e) => upd({ op: e.target.value as FilterOp })}>
                  {OPS.map((o) => (
                    <option key={o.op} value={o.op}>
                      {o.label}
                    </option>
                  ))}
                </select>
                {meta.needsValue && (
                  <input
                    className="input mono"
                    style={{ width: 240 }}
                    value={f.value ?? ''}
                    placeholder="value"
                    onChange={(e) => upd({ value: e.target.value })}
                    onKeyDown={(e) => e.key === 'Enter' && applyFilters()}
                  />
                )}
                <button className="btn small ghost" onClick={() => setDraftFilters((fs) => fs.filter((_, j) => j !== i))}>
                  ✕
                </button>
              </div>
            );
          })}
          <div className="filter-row" style={{ paddingLeft: 40 }}>
            <button className="btn small primary" onClick={applyFilters}>
              Apply
            </button>
            <button
              className="btn small"
              onClick={() => {
                setDraftFilters([]);
                setFilters([]);
                setOffset(0);
              }}
            >
              Clear
            </button>
            <span className="muted small">Filters and sorting run in the database.</span>
          </div>
        </div>
      )}

      {error ? (
        <div style={{ padding: 16 }}>
          <ErrorView error={error} actions={<button className="btn small" onClick={() => void load()}>Try again</button>} />
        </div>
      ) : !result ? (
        <div className="state">
          <Spinner />
          <p>Loading rows…{driver === 'databricks' ? ' (a stopped SQL warehouse can take a few minutes to start)' : ''}</p>
        </div>
      ) : (
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', opacity: loading ? 0.55 : 1 }}>
          <DataGrid
            columns={result.columns}
            rows={result.rows}
            sort={sort}
            onSort={toggleSort}
            rowOffset={result.offset}
            emptyText={filters.length ? 'No rows match the filter.' : offset > 0 ? 'No rows on this page.' : 'This table has no rows.'}
          />
        </div>
      )}

      <div className="statusbar">
        {loading && <Spinner />}
        {result && (
          <>
            <span>
              {rowsShown === 0 ? 'No rows' : `Rows ${(result.offset + 1).toLocaleString()}–${(result.offset + rowsShown).toLocaleString()}`}
            </span>
            {result.hasMore ? <span className="pill info">More rows available</span> : <span className="pill">End of data</span>}
            <span className="muted">{formatDuration(result.durationMs)}</span>
          </>
        )}
        <span className="spacer" />
        <span className="muted">Rows per page</span>
        <select
          className="select"
          style={{ height: 22 }}
          value={pageSize}
          onChange={(e) => {
            setPageSize(Number(e.target.value));
            setOffset(0);
          }}
        >
          {PAGE_SIZES.map((n) => (
            <option key={n}>{n}</option>
          ))}
        </select>
        <button className="btn small" disabled={offset === 0 || loading} onClick={() => setOffset(Math.max(0, offset - pageSize))}>
          ‹ Prev
        </button>
        <span>Page {page}</span>
        <button className="btn small" disabled={!result?.hasMore || loading} onClick={() => setOffset(offset + pageSize)}>
          Next ›
        </button>
      </div>

      {showInsert && structure && (
        <InsertDialog
          profileId={profileId}
          structure={structure}
          privilegeUnknown={insertUnknown}
          onClose={() => setShowInsert(false)}
          onInserted={() => {
            setShowInsert(false);
            onInserted();
          }}
        />
      )}
      {showExport && result && (
        <ExportDialog
          key={tabId}
          name={object.name}
          onClose={() => setShowExport(false)}
          options={[
            { id: 'page', label: `Current page (${result.rows.length.toLocaleString()} rows)`, scope: { kind: 'loaded', columns: result.columns, rows: result.rows } },
            {
              id: 'all',
              label: filters.length ? 'All rows matching the filter' : 'All rows in the table',
              detail: `Runs SELECT without paging${sort ? `, sorted by ${sort.column}` : ''} and streams every row to the file.`,
              scope: { kind: 'table', profileId, object, filters, sort },
            },
          ]}
        />
      )}
    </>
  );
}

function SectionState({ status, empty }: { status: SectionStatus; empty: string }) {
  if (status.state === 'empty') return <div className="tree-msg">{empty}</div>;
  if (status.state === 'denied')
    return (
      <div className="tree-msg" style={{ color: 'var(--warn)' }}>
        Cannot read — {status.message}
      </div>
    );
  if (status.state === 'unsupported') return <div className="tree-msg">Not supported — {status.message}</div>;
  return null;
}

function StructureView({ structure, error, onRefresh }: { structure: TableStructure | null; error: ErrorInfo | null; onRefresh: () => void }) {
  if (error)
    return (
      <div style={{ padding: 16 }}>
        <ErrorView error={error} actions={<button className="btn small" onClick={onRefresh}>Try again</button>} />
      </div>
    );
  if (!structure)
    return (
      <div className="state">
        <Spinner />
      </div>
    );
  return (
    <div className="scroll" style={{ flex: 1, padding: '6px 14px 24px' }}>
      <div className="row" style={{ margin: '8px 0' }}>
        <span className="section-label" style={{ padding: 0 }}>
          Columns
        </span>
        <span className="pill">{structure.columns.length}</span>
        <span className="spacer" />
        <button className="btn small" onClick={onRefresh}>
          ↻ Refresh
        </button>
      </div>
      {structure.columnsStatus.state === 'ok' ? (
        <table className="list">
          <thead>
            <tr>
              <th style={{ width: 36 }}>#</th>
              <th>Name</th>
              <th>Type</th>
              <th>Nullable</th>
              <th>Default</th>
              <th>Key</th>
              <th>Comment</th>
            </tr>
          </thead>
          <tbody>
            {structure.columns.map((c) => (
              <tr key={c.ordinal}>
                <td className="muted">{c.ordinal}</td>
                <td>
                  <b>{c.name}</b>
                </td>
                <td className="mono">{c.type}</td>
                <td>{c.nullable === null ? <span className="muted">unknown</span> : c.nullable ? 'YES' : <b>NO</b>}</td>
                <td className="mono">{c.defaultValue === null ? <span className="muted">—</span> : c.defaultValue}</td>
                <td>
                  {c.isPrimaryKey && <span className="pill info">PK</span>} {c.isIdentity && <span className="pill">identity</span>}
                </td>
                <td className="muted">{c.comment ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <SectionState status={structure.columnsStatus} empty="No columns." />
      )}

      <div className="row" style={{ margin: '20px 0 8px' }}>
        <span className="section-label" style={{ padding: 0 }}>
          Indexes
        </span>
        {structure.indexesStatus.state === 'ok' && <span className="pill">{structure.indexes.length}</span>}
      </div>
      {structure.indexesStatus.state === 'ok' ? (
        <table className="list">
          <thead>
            <tr>
              <th>Name</th>
              <th>Columns</th>
              <th>Unique</th>
              <th>Definition</th>
            </tr>
          </thead>
          <tbody>
            {structure.indexes.map((i) => (
              <tr key={i.name}>
                <td>
                  <b>{i.name}</b> {i.primary && <span className="pill info">PRIMARY</span>}
                </td>
                <td className="mono">{i.columns.join(', ')}</td>
                <td>{i.unique ? 'YES' : 'NO'}</td>
                <td className="mono muted">{i.definition ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <SectionState status={structure.indexesStatus} empty="No indexes." />
      )}

      <div className="row" style={{ margin: '20px 0 8px' }}>
        <span className="section-label" style={{ padding: 0 }}>
          Constraints
        </span>
        {structure.constraintsStatus.state === 'ok' && <span className="pill">{structure.constraints.length}</span>}
      </div>
      {structure.constraintsStatus.state === 'ok' ? (
        <table className="list">
          <thead>
            <tr>
              <th>Name</th>
              <th>Type</th>
              <th>Columns</th>
              <th>Definition / references</th>
            </tr>
          </thead>
          <tbody>
            {structure.constraints.map((c) => (
              <tr key={c.name + c.type}>
                <td>
                  <b>{c.name}</b>
                </td>
                <td>{c.type}</td>
                <td className="mono">{c.columns.join(', ')}</td>
                <td className="mono muted">{c.definition ?? (c.references ? `→ ${c.references}` : '')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <SectionState status={structure.constraintsStatus} empty="No constraints." />
      )}
    </div>
  );
}
