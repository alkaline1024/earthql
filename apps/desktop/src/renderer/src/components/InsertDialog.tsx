import { useMemo, useState } from 'react';
import {
  cellToText,
  describePath,
  type BuiltStatement,
  type Cell,
  type ColumnInfo,
  type ErrorInfo,
  type InsertCell,
  type InsertSpec,
  type TableStructure,
  type WriteResult,
} from '@earthql/core';
import { api, errorInfo } from '../api';
import { noteError, profileOf, useApp } from '../store';
import { ConfirmTarget, ErrorView, Modal, Spinner, plural } from './common';

type Mode = 'value' | 'null' | 'default';
interface CellState {
  mode: Mode;
  value: string;
}

function isComputed(c: ColumnInfo): boolean {
  return /^AS /.test(c.defaultValue ?? '') || /GENERATED ALWAYS/i.test(c.defaultValue ?? '');
}

function initialCell(c: ColumnInfo, defaultsSupported: boolean): CellState {
  if (defaultsSupported && (c.defaultValue !== null || c.isIdentity)) return { mode: 'default', value: '' };
  if (c.nullable) return { mode: 'null', value: '' };
  return { mode: 'value', value: '' };
}

/** Seeds a cell from an existing row's value (Duplicate) — identity/PK columns still get a fresh
 *  default instead of copying the original key, so the duplicate doesn't collide with it. */
function cellFromValue(c: ColumnInfo, value: Cell, defaultsSupported: boolean): CellState {
  if (c.isIdentity || c.isPrimaryKey) return initialCell(c, defaultsSupported);
  if (value === null) return c.nullable ? { mode: 'null', value: '' } : { mode: 'value', value: '' };
  return { mode: 'value', value: cellToText(value) };
}

export function InsertDialog({
  profileId,
  structure,
  privilegeUnknown,
  initialRows,
  onClose,
  onInserted,
}: {
  profileId: string;
  structure: TableStructure;
  privilegeUnknown: boolean;
  /** Pre-fill rows from existing data (Duplicate); defaults to one blank row. */
  initialRows?: Record<string, Cell>[];
  onClose: () => void;
  onInserted: () => void;
}) {
  const profile = profileOf(profileId)!.profile;
  const caps = useApp((s) => s.connections[profileId]?.capabilities);
  const toast = useApp((s) => s.toast);
  const defaultsSupported = !!caps?.columnDefaults;
  const columns = structure.columns;
  const blankRow = () => Object.fromEntries(columns.map((c) => [c.name, initialCell(c, defaultsSupported)])) as Record<string, CellState>;
  const rowFromValues = (values: Record<string, Cell>) =>
    Object.fromEntries(columns.map((c) => [c.name, cellFromValue(c, values[c.name] ?? null, defaultsSupported)])) as Record<string, CellState>;
  const [rows, setRows] = useState<Record<string, CellState>[]>(() => (initialRows?.length ? initialRows.map(rowFromValues) : [blankRow()]));
  const [step, setStep] = useState<'edit' | 'review' | 'running' | 'done'>('edit');
  const [preview, setPreview] = useState<BuiltStatement | null>(null);
  const [error, setError] = useState<ErrorInfo | null>(null);
  const [result, setResult] = useState<WriteResult | null>(null);

  const issues = useMemo(() => {
    const errors: string[] = [];
    const warnings: string[] = [];
    rows.forEach((r, i) => {
      for (const c of columns) {
        const cell = r[c.name];
        const where = `Row ${i + 1}, ${c.name}`;
        if (cell.mode === 'null' && c.nullable === false) errors.push(`${where}: column does not allow NULL.`);
        if (cell.mode === 'value' && isComputed(c)) errors.push(`${where}: generated column — use DEFAULT.`);
        if (cell.mode === 'default' && c.nullable === false && c.defaultValue === null && !c.isIdentity)
          warnings.push(`${where}: no default and NOT NULL — the database will likely reject this.`);
        if (cell.mode === 'value' && c.kind === 'number' && cell.value.trim() !== '' && !/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(cell.value.trim()))
          warnings.push(`${where}: "${cell.value}" does not look like a number.`);
        if (cell.mode === 'value' && c.kind === 'number' && cell.value.trim() === '') errors.push(`${where}: enter a number, or choose NULL / DEFAULT.`);
      }
    });
    return { errors, warnings };
  }, [rows, columns]);

  const spec = (): InsertSpec => ({
    object: structure.object,
    columns: columns.map((c) => ({ name: c.name, type: c.type, kind: c.kind })),
    rows: rows.map((r) =>
      Object.fromEntries(
        columns.map((c) => {
          const cell = r[c.name];
          const out: InsertCell = cell.mode === 'value' ? { kind: 'value', value: cell.value } : cell.mode === 'null' ? { kind: 'null' } : { kind: 'default' };
          return [c.name, out];
        }),
      ),
    ),
  });

  async function review() {
    setError(null);
    try {
      const b = await api.write.previewInsert(profileId, spec());
      setPreview(b);
      setStep('review');
    } catch (e) {
      setError(errorInfo(e));
    }
  }

  async function run() {
    setStep('running');
    setError(null);
    try {
      const r = await api.write.insert(profileId, spec());
      setResult(r);
      if (r.status === 'ok') {
        toast('ok', `Inserted ${plural(r.rowsAffected ?? rows.length, 'row')} into ${describePath(structure.object)}.`);
        onInserted();
        return;
      }
      if (r.error) noteError(profileId, r.error);
      setStep('done');
    } catch (e) {
      const info = errorInfo(e);
      noteError(profileId, info);
      setError(info);
      setStep('review');
    }
  }

  const setCell = (ri: number, col: string, patch: Partial<CellState>) =>
    setRows((rs) => rs.map((r, i) => (i === ri ? { ...r, [col]: { ...r[col], ...patch } } : r)));

  const target = describePath(structure.object);

  return (
    <Modal
      title={`Insert into ${structure.object.name}`}
      onClose={step === 'running' ? () => undefined : onClose}
      footer={
        step === 'edit' ? (
          <>
            <span className="muted small">{plural(rows.length, 'row')}</span>
            {issues.errors.length > 0 && <span className="small" style={{ color: 'var(--danger)' }}>{issues.errors[0]}</span>}
            <span className="spacer" />
            <button className="btn" onClick={onClose}>
              Cancel
            </button>
            <button className="btn primary" disabled={issues.errors.length > 0} onClick={() => void review()}>
              Review SQL…
            </button>
          </>
        ) : step === 'review' || step === 'running' ? (
          <>
            <button className="btn" disabled={step === 'running'} onClick={() => setStep('edit')}>
              ‹ Back to edit
            </button>
            <span className="spacer" />
            <button className="btn primary" disabled={step === 'running' || !!preview?.errors.length} onClick={() => void run()}>
              {step === 'running' ? <Spinner /> : null} Insert {plural(rows.length, 'row')} on {profile.name}
            </button>
          </>
        ) : (
          <>
            <span className="spacer" />
            <button className="btn" onClick={() => setStep('edit')}>
              Back to edit
            </button>
            <button className="btn primary" onClick={onInserted}>
              Close & refresh data
            </button>
          </>
        )
      }
    >
      {step === 'edit' && (
        <>
          <p className="muted small" style={{ marginTop: 0 }}>
            For each cell choose <b>Value</b> (what you type, even empty text), <b>NULL</b> (no value) or <b>Default</b> (the column default).
          </p>
          <div className="scroll" style={{ maxHeight: 'calc(100vh - 360px)' }}>
            <table className="list">
              <thead>
                <tr>
                  <th style={{ width: 30 }}>#</th>
                  {columns.map((c) => (
                    <th key={c.name} title={`${c.type}${c.nullable === false ? ' NOT NULL' : ''}${c.defaultValue ? ` DEFAULT ${c.defaultValue}` : ''}`}>
                      {c.name} {c.isPrimaryKey && <span className="pill info">PK</span>}
                      <div className="muted" style={{ fontWeight: 400, fontFamily: 'var(--mono)', fontSize: 10.5 }}>
                        {c.type}
                        {c.nullable === false ? ' · not null' : ''}
                      </div>
                    </th>
                  ))}
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((r, ri) => (
                  <tr key={ri}>
                    <td className="muted">{ri + 1}</td>
                    {columns.map((c) => {
                      const cell = r[c.name];
                      return (
                        <td key={c.name}>
                          <div className="ins-cell">
                            {cell.mode === 'value' ? (
                              <input
                                className="input"
                                value={cell.value}
                                placeholder={c.kind === 'number' ? '0' : "'' (empty text)"}
                                onChange={(e) => setCell(ri, c.name, { value: e.target.value })}
                              />
                            ) : (
                              <span
                                className="placeholder"
                                onClick={() => !isComputed(c) && setCell(ri, c.name, { mode: 'value' })}
                                title={cell.mode === 'default' ? c.defaultValue ?? (c.isIdentity ? 'identity' : 'no default defined') : ''}
                              >
                                {cell.mode === 'null' ? 'NULL' : `DEFAULT${c.defaultValue ? ` · ${c.defaultValue}` : c.isIdentity ? ' · identity' : ''}`}
                              </span>
                            )}
                            <div className="segmented tiny">
                              <button className={cell.mode === 'value' ? 'on' : ''} disabled={isComputed(c)} onClick={() => setCell(ri, c.name, { mode: 'value' })}>
                                Value
                              </button>
                              <button className={cell.mode === 'null' ? 'on' : ''} disabled={c.nullable === false} onClick={() => setCell(ri, c.name, { mode: 'null' })}>
                                NULL
                              </button>
                              <button
                                className={cell.mode === 'default' ? 'on' : ''}
                                disabled={!defaultsSupported}
                                onClick={() => setCell(ri, c.name, { mode: 'default' })}
                              >
                                Default
                              </button>
                            </div>
                          </div>
                        </td>
                      );
                    })}
                    <td>
                      <div className="row" style={{ gap: 2 }}>
                        <button className="btn small ghost" title="Duplicate row" onClick={() => setRows((rs) => [...rs.slice(0, ri + 1), structuredClone(r), ...rs.slice(ri + 1)])}>
                          ⧉
                        </button>
                        <button className="btn small ghost" title="Remove row" disabled={rows.length === 1} onClick={() => setRows((rs) => rs.filter((_, i) => i !== ri))}>
                          ✕
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="row" style={{ marginTop: 10 }}>
            <button className="btn small" onClick={() => setRows((rs) => [...rs, blankRow()])}>
              ＋ Add row
            </button>
          </div>
          {issues.warnings.length > 0 && (
            <ul className="small" style={{ color: 'var(--warn)', margin: '10px 0 0', paddingLeft: 18 }}>
              {issues.warnings.slice(0, 6).map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          )}
          {error && (
            <div style={{ marginTop: 10 }}>
              <ErrorView error={error} />
            </div>
          )}
        </>
      )}

      {(step === 'review' || step === 'running' || step === 'done') && preview && (
        <div className="col">
          <ConfirmTarget profile={profile} action={`INSERT ${plural(rows.length, 'row')}`} target={target} />
          {privilegeUnknown && step !== 'done' && (
            <div className="muted small">EarthQL could not check your INSERT privilege in advance; the database will enforce it.</div>
          )}
          <b>SQL</b>
          <pre className="sql">{preview.sql}</pre>
          {preview.params.length > 0 && (
            <>
              <b>Bound values</b>
              <div className="scroll" style={{ maxHeight: 180 }}>
                <table className="list">
                  <tbody>
                    {preview.params.map((p, i) => (
                      <tr key={i}>
                        <td className="mono muted" style={{ width: 60 }}>
                          {profile.driver === 'postgres' ? `$${i + 1}` : profile.driver === 'mssql' ? `@p${i}` : profile.driver === 'databricks' ? `:p${i}` : `? #${i + 1}`}
                        </td>
                        <td className="mono">{p.value === '' ? <span className="emptystr">(empty text)</span> : p.value}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          {preview.errors.map((e, i) => (
            <div key={i} style={{ color: 'var(--danger)' }}>
              {e}
            </div>
          ))}
          {error && <ErrorView error={error} />}
          {result && result.status !== 'ok' && result.error && (
            <ErrorView
              error={result.error}
              actions={
                result.status === 'outcome_unknown' ? (
                  <span className="small">Close this dialog and refresh the table to see whether the rows were saved before inserting again.</span>
                ) : undefined
              }
            />
          )}
        </div>
      )}
    </Modal>
  );
}
