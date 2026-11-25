import { useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { cellToText, isBinaryCell, type Cell, type ResultColumn, type Sort } from '@earthql/core';
import { Modal } from './common';

const ROW_H = 26;

export interface GridEditing {
  canEdit(row: number, col: number): boolean;
  nullable(col: number): boolean;
  changed(row: number, col: number): boolean;
  change(row: number, col: number, value: string | null): void;
}

function renderCell(c: Cell) {
  if (c === null) return <span className="null">NULL</span>;
  if (c === '') return <span className="emptystr">(empty)</span>;
  if (isBinaryCell(c)) return <span className="bin">{`0x${c.$binary}${c.truncated ? '…' : ''} (${c.bytes} B)`}</span>;
  if (typeof c === 'boolean') return <span>{c ? 'true' : 'false'}</span>;
  const s = String(c);
  return <span>{s.length > 500 ? s.slice(0, 500) + '…' : s.replace(/\n/g, '↵')}</span>;
}

function initialWidths(columns: ResultColumn[], rows: Cell[][]): number[] {
  return columns.map((col, i) => {
    // Header shows the name and the type side by side.
    let w = col.name.length * 7.5 + col.type.length * 6.2 + 30;
    for (let r = 0; r < Math.min(rows.length, 60); r++) {
      const v = rows[r][i];
      const len = v === null ? 4 : isBinaryCell(v) ? 24 : String(v).length;
      w = Math.max(w, Math.min(len, 60) * 7.4 + 18);
    }
    return Math.round(Math.max(70, Math.min(w, 380)));
  });
}

export function DataGrid({
  columns,
  rows,
  sort,
  onSort,
  rowOffset = 0,
  emptyText = 'No rows',
  editing,
}: {
  columns: ResultColumn[];
  rows: Cell[][];
  sort?: Sort;
  onSort?: (column: string) => void;
  rowOffset?: number;
  emptyText?: string;
  editing?: GridEditing;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const colKey = columns.map((c) => c.name + ':' + c.type).join('|');
  const [widths, setWidths] = useState<number[]>(() => initialWidths(columns, rows));
  const [sel, setSel] = useState<{ r: number; c: number } | null>(null);
  const [viewer, setViewer] = useState<{ col: ResultColumn; value: Cell } | null>(null);
  const [editor, setEditor] = useState<{ r: number; c: number; initial: string | null } | null>(null);

  useEffect(() => {
    setWidths(initialWidths(columns, rows));
    setSel(null);
    setEditor(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [colKey]);

  const rowNumW = Math.max(44, String(rowOffset + rows.length).length * 8 + 18);
  const total = rowNumW + widths.reduce((a, b) => a + b, 0);

  const v = useVirtualizer({ count: rows.length, getScrollElement: () => wrap.current, estimateSize: () => ROW_H, overscan: 12 });

  const startResize = (i: number, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const x0 = e.clientX;
    const w0 = widths[i];
    const move = (ev: MouseEvent) => setWidths((ws) => ws.map((w, j) => (j === i ? Math.max(50, w0 + ev.clientX - x0) : w)));
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  function openCell(r: number, c: number) {
    const value = rows[r][c];
    if (editing?.canEdit(r, c)) setEditor({ r, c, initial: value === null ? null : cellToText(value) });
    else setViewer({ col: columns[c], value });
  }

  function finishEdit() {
    setEditor(null);
    wrap.current?.focus();
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!sel) return;
    if ((e.metaKey || e.ctrlKey) && e.key === 'c') {
      const sc = window.getSelection()?.toString();
      if (sc) return; // let the browser copy a text selection
      e.preventDefault();
      void navigator.clipboard.writeText(cellToText(rows[sel.r]?.[sel.c] ?? null, 'NULL'));
      return;
    }
    const moves: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    const m = moves[e.key];
    if (m) {
      e.preventDefault();
      const r = Math.max(0, Math.min(rows.length - 1, sel.r + m[0]));
      const c = Math.max(0, Math.min(columns.length - 1, sel.c + m[1]));
      setSel({ r, c });
      v.scrollToIndex(r);
    }
    if ((e.key === 'Enter' || e.key === 'F2') && rows[sel.r]) {
      e.preventDefault();
      openCell(sel.r, sel.c);
    }
  };

  const header = useMemo(
    () => (
      <div className="grid-head" style={{ width: total }}>
        <div className="ghead" style={{ width: rowNumW, position: 'sticky', left: 0, zIndex: 3, background: 'var(--bg-sunken)' }} />
        {columns.map((c, i) => (
          <div
            key={i}
            className={`ghead${onSort ? ' sortable' : ''}`}
            style={{ width: widths[i] }}
            title={`${c.name} · ${c.type}${onSort ? ' — click to sort' : ''}`}
            onClick={() => onSort?.(c.name)}
          >
            <span className="hname">{c.name}</span>
            <span className="htype">{c.type}</span>
            {sort?.column === c.name && <span className="sort">{sort.dir === 'asc' ? '▲' : '▼'}</span>}
            <span className="resize" onMouseDown={(e) => startResize(i, e)} onClick={(e) => e.stopPropagation()} />
          </div>
        ))}
      </div>
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [columns, widths, sort, onSort, total, rowNumW],
  );

  return (
    <>
      <div className="grid-wrap" ref={wrap} tabIndex={0} onKeyDown={onKeyDown}>
        <div className="grid" style={{ width: total, height: v.getTotalSize() + 31 }}>
          {header}
          {rows.length === 0 && <div className="tree-msg" style={{ padding: 16 }}>{emptyText}</div>}
          {v.getVirtualItems().map((vr) => {
            const row = rows[vr.index];
            return (
              <div key={vr.key} className="grid-row" style={{ top: vr.start + 31, height: ROW_H, width: total }}>
                <div className="gcell rownum" style={{ width: rowNumW }}>
                  {rowOffset + vr.index + 1}
                </div>
                {columns.map((col, ci) => (
                  <div
                    key={ci}
                    className={`gcell${col.kind === 'number' ? ' num' : ''}${sel?.r === vr.index && sel?.c === ci ? ' sel' : ''}${editing?.changed(vr.index, ci) ? ' draft-cell' : ''}`}
                    style={{ width: widths[ci] }}
                    onMouseDown={() => setSel({ r: vr.index, c: ci })}
                    onDoubleClick={() => openCell(vr.index, ci)}
                  >
                    {editor?.r === vr.index && editor.c === ci && editing?.canEdit(vr.index, ci) ? (
                      <div
                        className="grid-cell-editor"
                        onMouseDown={(event) => event.stopPropagation()}
                        onDoubleClick={(event) => event.stopPropagation()}
                        onBlur={(event) => {
                          if (!event.currentTarget.contains(event.relatedTarget)) setEditor(null);
                        }}
                      >
                        <textarea
                          autoFocus
                          rows={1}
                          aria-label={`Edit ${col.name}, row ${rowOffset + vr.index + 1}`}
                          value={cellToText(row[ci])}
                          placeholder={row[ci] === null ? 'NULL' : undefined}
                          onFocus={(event) => event.currentTarget.select()}
                          onChange={(event) => editing.change(vr.index, ci, event.target.value)}
                          onKeyDown={(event) => {
                            event.stopPropagation();
                            if (event.key === 'Escape') {
                              event.preventDefault();
                              editing.change(vr.index, ci, editor.initial);
                              finishEdit();
                            } else if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                              event.preventDefault();
                              finishEdit();
                            }
                          }}
                        />
                        {editing.nullable(ci) && (
                          <button type="button" title="Set SQL NULL" onMouseDown={(event) => event.preventDefault()} onClick={() => { editing.change(vr.index, ci, null); finishEdit(); }}>
                            NULL
                          </button>
                        )}
                      </div>
                    ) : renderCell(row[ci])}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>
      {viewer && (
        <Modal title={`${viewer.col.name}`} headExtra={<span className="pill">{viewer.col.type}</span>} onClose={() => setViewer(null)} narrow>
          {viewer.value === null ? (
            <div className="null" style={{ fontSize: 13 }}>
              NULL — no value (different from an empty string)
            </div>
          ) : viewer.value === '' ? (
            <div className="muted">Empty string ('')</div>
          ) : (
            <pre className="sql" style={{ maxHeight: 420 }}>
              {prettyValue(viewer.value)}
            </pre>
          )}
          <div className="row" style={{ marginTop: 10 }}>
            <button className="btn small" onClick={() => void navigator.clipboard.writeText(cellToText(viewer.value, 'NULL'))}>
              Copy
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}

function prettyValue(c: Cell): string {
  const s = cellToText(c);
  // Skip pretty-printing when it could round long numbers.
  if (typeof c === 'string' && /^[[{]/.test(c.trim()) && !/\d{16,}/.test(c)) {
    try {
      return JSON.stringify(JSON.parse(c), null, 2);
    } catch {
      return s;
    }
  }
  return s;
}
