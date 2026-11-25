import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  cellToText,
  csvRows,
  isBinaryCell,
  toCsv,
  toHtmlTable,
  toJsonRows,
  toMarkdownTable,
  toTsv,
  type Cell,
  type FilterOp,
  type ResultColumn,
  type Sort,
} from '@earthql/core';
import { ContextSubmenu } from './ContextSubmenu';
import { Modal, plural } from './common';
import { Kbd, Keys, useShortcuts } from './Shortcut';
import { GRID_COPY_FORMATS, effectiveAccelerator, matchesAccelerator } from '../../../shared/keybindings';

const ROW_H = 26;

export interface GridEditing {
  canEdit(row: number, col: number): boolean;
  nullable(col: number): boolean;
  choices?(row: number, col: number): { label: string; value: string | null }[];
  changed(row: number, col: number): boolean;
  change(row: number, col: number, value: string | null): void;
}

/** Table-level actions shown in the context menu; each is independently optional so the caller
 *  can omit whichever aren't allowed (e.g. no insert privilege) without hiding the rest. */
export interface TableGridActions {
  onAddRow?(): void;
  structureLabel?: string;
  onDuplicateRows?(rowIndexes: number[]): void;
  onDeleteRows?(rowIndexes: number[]): void;
  onQuickFilter?(column: string, op: FilterOp, value?: string): void;
  onImport?(format: 'csv' | 'json' | 'sql'): void;
  /** Dialect-correct INSERT statement text for the given columns/rows (async: needs a main-process round-trip). */
  onFormatInsert?(columns: ResultColumn[], rows: Cell[][]): Promise<string>;
}

const QUICK_FILTER_OPS: { op: FilterOp; label: string; needsValue: boolean }[] = [
  { op: '=', label: '=', needsValue: true },
  { op: '!=', label: '<>', needsValue: true },
  { op: '<', label: '<', needsValue: true },
  { op: '<=', label: '<=', needsValue: true },
  { op: '>', label: '>', needsValue: true },
  { op: '>=', label: '>=', needsValue: true },
  { op: 'contains', label: 'Contains', needsValue: true },
  { op: 'not_contains', label: 'Not contains', needsValue: true },
  { op: 'starts_with', label: 'Has prefix', needsValue: true },
  { op: 'ends_with', label: 'Has suffix', needsValue: true },
  { op: 'in', label: 'IN', needsValue: true },
  { op: 'not_in', label: 'NOT IN', needsValue: true },
  { op: 'is_null', label: 'IS NULL', needsValue: false },
  { op: 'is_not_null', label: 'IS NOT NULL', needsValue: false },
];

function renderCell(c: Cell) {
  if (c === null) return <span className="null">NULL</span>;
  if (c === '') return <span className="emptystr">(empty)</span>;
  if (isBinaryCell(c)) return <span className="bin">{`0x${c.$binary}${c.truncated ? '…' : ''} (${c.bytes} B)`}</span>;
  if (typeof c === 'boolean') return <span>{c ? 'true' : 'false'}</span>;
  const s = String(c);
  return <span>{s.length > 500 ? s.slice(0, 500) + '…' : s.replace(/\n/g, '↵')}</span>;
}

function initialWidths(columns: ResultColumn[], rows: Cell[][], sampleLimit = 60): number[] {
  return columns.map((col, i) => {
    // Header shows the name and the type side by side.
    let w = col.name.length * 7.5 + col.type.length * 6.2 + 30;
    for (let r = 0; r < Math.min(rows.length, sampleLimit); r++) {
      const v = rows[r][i];
      const len = v === null ? 4 : isBinaryCell(v) ? 24 : String(v).length;
      w = Math.max(w, Math.min(len, 60) * 7.4 + 18);
    }
    return Math.round(Math.max(70, Math.min(w, 380)));
  });
}

async function writeClipboardHtml(html: string, plainFallback: string) {
  try {
    const ClipboardItemCtor = (window as unknown as { ClipboardItem?: typeof ClipboardItem }).ClipboardItem;
    if (!ClipboardItemCtor) throw new Error('ClipboardItem unavailable');
    await navigator.clipboard.write([
      new ClipboardItemCtor({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([plainFallback], { type: 'text/plain' }),
      }),
    ]);
  } catch {
    await navigator.clipboard.writeText(plainFallback);
  }
}

export function DataGrid({
  columns,
  rows,
  sort,
  onSort,
  rowOffset = 0,
  expandRows = false,
  emptyText = 'No rows',
  editing,
  onRefresh,
  onExportPage,
  tableActions,
  cellLinks,
}: {
  columns: ResultColumn[];
  rows: Cell[][];
  sort?: Sort;
  onSort?: (column: string) => void;
  rowOffset?: number;
  expandRows?: boolean;
  emptyText?: string;
  editing?: GridEditing;
  /** Shown as "Refresh" in the context menu; omit to hide it. */
  onRefresh?(): void;
  /** Shown as "Export current page…"; omit to hide it. */
  onExportPage?(): void;
  /** Row/table-level actions; omit entirely for read-only results (e.g. SQL query output). */
  tableActions?: TableGridActions;
  cellLinks?(row: number, column: number): { label: string; open(): void }[];
}) {
  const sc = useShortcuts();
  const wrap = useRef<HTMLDivElement>(null);
  const colKey = columns.map((c) => c.name + ':' + c.type).join('|');
  const [widths, setWidths] = useState<number[]>(() => initialWidths(columns, rows));
  // `anchor` is where a selection started (mousedown / plain click); `sel` is the "focus" cell —
  // the one arrow-keys/Enter/double-click act on, same as the single-cell selection always was.
  // anchor === sel is a single cell; otherwise they bound a drag/shift-extended rectangle.
  const [anchor, setAnchor] = useState<{ r: number; c: number } | null>(null);
  const [sel, setSel] = useState<{ r: number; c: number } | null>(null);
  const [viewer, setViewer] = useState<{ col: ResultColumn; value: Cell } | null>(null);
  const [editor, setEditor] = useState<{ r: number; c: number; initial: string | null } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<number[] | null>(null);
  const dragging = useRef(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const focusBeforeMenu = useRef<HTMLElement | null>(null);

  useEffect(() => {
    setWidths(initialWidths(columns, rows));
    setAnchor(null);
    setSel(null);
    setEditor(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [colKey]);

  function beginSelect(r: number, c: number, extend: boolean) {
    if (!extend || !anchor) setAnchor({ r, c });
    setSel({ r, c });
    dragging.current = true;
    const up = () => {
      dragging.current = false;
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mouseup', up);
  }

  function extendSelect(r: number, c: number) {
    if (dragging.current) setSel({ r, c });
  }

  const rangeBounds = anchor && sel
    ? { r1: Math.min(anchor.r, sel.r), r2: Math.max(anchor.r, sel.r), c1: Math.min(anchor.c, sel.c), c2: Math.max(anchor.c, sel.c) }
    : null;
  const inRange = (r: number, c: number) => !!rangeBounds && r >= rangeBounds.r1 && r <= rangeBounds.r2 && c >= rangeBounds.c1 && c <= rangeBounds.c2;
  // Every row touched by the selection gets the same tint across its whole width, even outside
  // the selected columns, so it's easy to see which rows the selection spans.
  const inActiveRow = (r: number) => !!rangeBounds && r >= rangeBounds.r1 && r <= rangeBounds.r2;
  // A single continuous border around the dragged rectangle, built from per-cell edge
  // box-shadows (so touching cells don't each draw their own inner border).
  function rangeEdgeShadow(r: number, c: number): string | undefined {
    if (!rangeBounds || !inRange(r, c)) return undefined;
    const edges: string[] = [];
    if (r === rangeBounds.r1) edges.push('inset 0 2px 0 0 var(--primary)');
    if (r === rangeBounds.r2) edges.push('inset 0 -2px 0 0 var(--primary)');
    if (c === rangeBounds.c1) edges.push('inset 2px 0 0 0 var(--primary)');
    if (c === rangeBounds.c2) edges.push('inset -2px 0 0 0 var(--primary)');
    return edges.length ? edges.join(', ') : undefined;
  }

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

  // ---------------------------------------------------------------------------
  // Selection helpers shared by keyboard copy and the context menu
  // ---------------------------------------------------------------------------

  function rangeRows(c1: number, c2: number): Cell[][] {
    if (!rangeBounds) return [];
    const out: Cell[][] = [];
    for (let r = rangeBounds.r1; r <= rangeBounds.r2; r++) {
      const row: Cell[] = [];
      for (let c = c1; c <= c2; c++) row.push(rows[r]?.[c] ?? null);
      out.push(row);
    }
    return out;
  }

  function rangeRowIndexes(): number[] {
    if (!rangeBounds) return [];
    const out: number[] = [];
    for (let r = rangeBounds.r1; r <= rangeBounds.r2; r++) out.push(r);
    return out;
  }

  function copySelectedCells() {
    if (rangeBounds && (rangeBounds.r1 !== rangeBounds.r2 || rangeBounds.c1 !== rangeBounds.c2)) {
      void navigator.clipboard.writeText(toTsv(columns.slice(rangeBounds.c1, rangeBounds.c2 + 1), rangeRows(rangeBounds.c1, rangeBounds.c2)));
    } else if (sel) {
      void navigator.clipboard.writeText(cellToText(rows[sel.r]?.[sel.c] ?? null, 'NULL'));
    }
  }

  function copyRowsPlain() {
    if (!rangeBounds) return;
    void navigator.clipboard.writeText(toTsv(columns, rangeRows(0, columns.length - 1)));
  }

  async function copyAs(format: (typeof GRID_COPY_FORMATS)[number]['format'], scope: 'rows' | 'cells') {
    const c1 = scope === 'rows' ? 0 : (rangeBounds?.c1 ?? 0);
    const c2 = scope === 'rows' ? columns.length - 1 : (rangeBounds?.c2 ?? columns.length - 1);
    const cols = columns.slice(c1, c2 + 1);
    const data = rangeRows(c1, c2);
    if (!data.length) return;
    switch (format) {
      case 'plain':
        void navigator.clipboard.writeText(toTsv(cols, data));
        return;
      case 'json':
        void navigator.clipboard.writeText(toJsonRows(cols, data));
        return;
      case 'html':
        void writeClipboardHtml(toHtmlTable(cols, data), toTsv(cols, data));
        return;
      case 'markdown':
        void navigator.clipboard.writeText(toMarkdownTable(cols, data));
        return;
      case 'csv':
        void navigator.clipboard.writeText(csvRows(data));
        return;
      case 'csv-header':
        void navigator.clipboard.writeText(toCsv(cols, data));
        return;
      case 'insert':
        if (!tableActions?.onFormatInsert) return;
        try {
          const text = await tableActions.onFormatInsert(cols, data);
          void navigator.clipboard.writeText(text);
        } catch {
          // The caller's onFormatInsert is responsible for surfacing its own errors (e.g. a toast).
        }
    }
  }

  function copyAllColumnValues() {
    if (!sel) return;
    void navigator.clipboard.writeText(rows.map((r) => cellToText(r[sel.c] ?? null, 'NULL')).join('\n'));
  }

  function setSelectedValues(value: string | null) {
    if (!editing || !rangeBounds) return;
    for (let r = rangeBounds.r1; r <= rangeBounds.r2; r++) {
      for (let c = rangeBounds.c1; c <= rangeBounds.c2; c++) {
        if (editing.canEdit(r, c) && (value === null ? editing.nullable(c) : true)) editing.change(r, c, value);
      }
    }
  }

  async function pasteFromClipboard(fill: boolean) {
    if (!editing) return;
    let text: string;
    try {
      text = await navigator.clipboard.readText();
    } catch {
      return;
    }
    if (!text) return;
    const grid = text.replace(/\r\n/g, '\n').split('\n').map((line) => line.split('\t'));
    if (fill) {
      if (!rangeBounds) return;
      const value = grid[0]?.[0] ?? '';
      for (let r = rangeBounds.r1; r <= rangeBounds.r2; r++) {
        for (let c = rangeBounds.c1; c <= rangeBounds.c2; c++) {
          if (editing.canEdit(r, c)) editing.change(r, c, value);
        }
      }
      return;
    }
    const startR = anchor?.r ?? sel?.r ?? 0;
    const startC = anchor?.c ?? sel?.c ?? 0;
    grid.forEach((line, dr) => {
      line.forEach((value, dc) => {
        const r = startR + dr;
        const c = startC + dc;
        if (r < rows.length && c < columns.length && editing.canEdit(r, c)) editing.change(r, c, value);
      });
    });
  }

  function quickFilter(op: FilterOp) {
    if (!tableActions?.onQuickFilter || !sel) return;
    const column = columns[sel.c].name;
    const needsValue = QUICK_FILTER_OPS.find((o) => o.op === op)?.needsValue;
    tableActions.onQuickFilter(column, op, needsValue ? cellToText(rows[sel.r]?.[sel.c] ?? null, '') : undefined);
  }

  function handleCopyShortcut(e: ReactKeyboardEvent): boolean {
    if (!rangeBounds || e.nativeEvent.isComposing) return false;
    for (const scope of ['cells', 'rows'] as const) {
      for (const { format } of GRID_COPY_FORMATS) {
        if (format === 'insert' && !tableActions?.onFormatInsert) continue;
        if (!matchesAccelerator(e, effectiveAccelerator(`grid-copy-${scope}-${format}`, sc.overrides))) continue;
        e.preventDefault();
        e.stopPropagation();
        setMenu(null);
        void copyAs(format, scope);
        wrap.current?.focus();
        return true;
      }
    }
    return false;
  }

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (!sel || editor || (e.target instanceof HTMLElement && e.target.closest('input, textarea, [contenteditable="true"]'))) return;
    if (handleCopyShortcut(e)) return;
    if (matchesAccelerator(e, effectiveAccelerator('sys-select-all', sc.overrides))) {
      if (!rows.length || !columns.length) return;
      e.preventDefault();
      e.stopPropagation();
      window.getSelection()?.removeAllRanges();
      setAnchor({ r: 0, c: 0 });
      setSel({ r: rows.length - 1, c: columns.length - 1 });
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'c') {
      const sc = window.getSelection()?.toString();
      if (sc) return; // let the browser copy a text selection
      e.preventDefault();
      copySelectedCells();
      return;
    }
    const moves: Record<string, [number, number]> = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    const m = moves[e.key];
    if (m) {
      e.preventDefault();
      const r = Math.max(0, Math.min(rows.length - 1, sel.r + m[0]));
      const c = Math.max(0, Math.min(columns.length - 1, sel.c + m[1]));
      setSel({ r, c });
      if (!e.shiftKey) setAnchor({ r, c });
      if (expandRows) wrap.current?.querySelector(`[data-grid-row="${r}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      else v.scrollToIndex(r);
    }
    if ((e.key === 'Enter' || e.key === 'F2') && rows[sel.r]) {
      e.preventDefault();
      openCell(sel.r, sel.c);
    }
  };

  // ---------------------------------------------------------------------------
  // Context menu
  // ---------------------------------------------------------------------------

  function openMenu(x: number, y: number) {
    focusBeforeMenu.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setEditor(null);
    setMenu({ x, y });
  }

  function invoke(action: () => void) {
    setMenu(null);
    action();
  }

  useLayoutEffect(() => {
    const element = menuRef.current;
    if (!menu || !element) return;
    element.style.left = `${Math.max(8, Math.min(menu.x, window.innerWidth - element.offsetWidth - 8))}px`;
    element.style.top = `${Math.max(8, Math.min(menu.y, window.innerHeight - element.offsetHeight - 8))}px`;
    element.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target)) setMenu(null);
    };
    const close = () => setMenu(null);
    window.addEventListener('pointerdown', dismiss);
    window.addEventListener('resize', close);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('pointerdown', dismiss);
      window.removeEventListener('resize', close);
      window.removeEventListener('blur', close);
    };
  }, [menu]);

  function onMenuKey(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (handleCopyShortcut(event)) return;
    if (event.key === 'Escape' || event.key === 'Tab') {
      setMenu(null);
      focusBeforeMenu.current?.focus();
      if (event.key === 'Escape') event.preventDefault();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')).filter(
      (button) => button.closest('[role="menu"]') === event.currentTarget,
    );
    const index = buttons.findIndex((button) => button === document.activeElement);
    if (event.key === 'Home') buttons[0]?.focus();
    else if (event.key === 'End') buttons.at(-1)?.focus();
    else buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
  }

  const singleCell = !rangeBounds || (rangeBounds.r1 === rangeBounds.r2 && rangeBounds.c1 === rangeBounds.c2);
  const selectedRows = rangeRowIndexes();
  const selectedCellCount = rangeBounds ? (rangeBounds.r2 - rangeBounds.r1 + 1) * (rangeBounds.c2 - rangeBounds.c1 + 1) : 0;
  const canEditFocus = !!editing && !!sel && editing.canEdit(sel.r, sel.c);
  function copyAsItems(scope: 'rows' | 'cells') {
    return GRID_COPY_FORMATS.filter(({ format }) => format !== 'insert' || tableActions?.onFormatInsert).map(({ format, label }) => (
      <span key={format} style={{ display: 'contents' }}>
        {(format === 'csv' || format === 'insert') && <div className="conn-menu-separator" role="separator" />}
        <button type="button" role="menuitem" aria-keyshortcuts={sc.aria(`grid-copy-${scope}-${format}`)} onClick={() => invoke(() => void copyAs(format, scope))}>
          <span>{label}</span><Kbd id={`grid-copy-${scope}-${format}`} />
        </button>
      </span>
    ));
  }

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
            <span className="resize" title="Double-click to fit column" onMouseDown={(e) => startResize(i, e)} onClick={(e) => e.stopPropagation()}
              onDoubleClick={(event) => {
                event.stopPropagation();
                const [width] = initialWidths([c], rows.map((row) => [row[i]]), rows.length);
                setWidths((current) => current.map((value, index) => index === i ? width : value));
              }} />
          </div>
        ))}
      </div>
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [columns, rows, widths, sort, onSort, total, rowNumW],
  );

  return (
    <>
      <div className={expandRows ? "grid-wrap expand-rows" : "grid-wrap"} ref={wrap} tabIndex={0} onKeyDown={onKeyDown}
        onContextMenu={(event) => {
          event.preventDefault();
          setAnchor(null);
          setSel(null);
          wrap.current?.focus();
          openMenu(event.clientX, event.clientY);
        }}>
        <div className="grid" style={{ width: total, height: expandRows ? 31 + Math.max(rows.length * ROW_H, rows.length ? 0 : 48) : v.getTotalSize() + 31 }}>
          {header}
          {rows.length === 0 && <div className="tree-msg" style={{ padding: 16 }}>{emptyText}</div>}
          {(expandRows ? rows.map((_, index) => ({ key: index, index, start: index * ROW_H })) : v.getVirtualItems()).map((vr) => {
            const row = rows[vr.index];
            return (
              <div key={vr.key} data-grid-row={vr.index} className="grid-row" style={{ top: vr.start + 31, height: ROW_H, width: total }}>
                <div className="gcell rownum" style={{ width: rowNumW }} onContextMenu={tableActions?.structureLabel ? (event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  if (!selectedRows.includes(vr.index)) {
                    setAnchor({ r: vr.index, c: 0 });
                    setSel({ r: vr.index, c: 0 });
                  }
                  openMenu(event.clientX, event.clientY);
                } : undefined}>
                  {rowOffset + vr.index + 1}
                </div>
                {columns.map((col, ci) => {
                  const links = cellLinks?.(vr.index, ci) ?? [];
                  const choices = !links.length && editing?.canEdit(vr.index, ci) ? editing.choices?.(vr.index, ci) : undefined;
                  return (
                  <div
                    key={ci}
                    className={`gcell${col.kind === 'number' ? ' num' : ''}${inRange(vr.index, ci) ? ' range' : inActiveRow(vr.index) ? ' row-active' : ''}${editing?.changed(vr.index, ci) ? ' draft-cell' : ''}`}
                    style={{ width: widths[ci], boxShadow: rangeEdgeShadow(vr.index, ci) }}
                    onMouseDown={(event) => { if (event.button === 0) beginSelect(vr.index, ci, event.shiftKey); }}
                    onMouseEnter={(event) => { if (event.buttons === 1) extendSelect(vr.index, ci); }}
                    onDoubleClick={() => openCell(vr.index, ci)}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      if (!inRange(vr.index, ci)) {
                        setAnchor({ r: vr.index, c: ci });
                        setSel({ r: vr.index, c: ci });
                      }
                      openMenu(event.clientX, event.clientY);
                    }}
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
                    ) : <>
                      {renderCell(row[ci])}
                      {!!choices?.length && <span className="grid-cell-choice">
                        <svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" aria-hidden="true">
                          <path d="m3 4.5 3-3 3 3m-6 3 3 3 3-3" />
                        </svg>
                        <select aria-label={`Choose ${col.name}, row ${rowOffset + vr.index + 1}`} value=""
                          onMouseDown={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}
                          onKeyDown={(event) => event.stopPropagation()}
                          onChange={(event) => {
                            const choice = choices[Number(event.target.value)];
                            if (choice) editing?.change(vr.index, ci, choice.value);
                          }}>
                          <option value="" disabled>Choose a value</option>
                          {choices.map((choice, index) => <option key={index} value={index}>{choice.label}</option>)}
                        </select>
                      </span>}
                      {links.map(({ label, open }, index) => (
                        <button key={index} type="button" className="grid-foreign-link" aria-label={label} title={label}
                          onMouseDown={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}
                          onClick={(event) => { event.stopPropagation(); open(); }}>→</button>
                      ))}
                    </>}
                  </div>
                ); })}
              </div>
            );
          })}
        </div>
      </div>
      {menu && (
        <div className="tab-context-menu grid-context-menu" ref={menuRef} role="menu" aria-label="Cell actions" onKeyDown={onMenuKey}>
          <button type="button" role="menuitem" disabled={!sel} onClick={() => invoke(() => sel && openCell(sel.r, sel.c))}>
            <span>Quick Look Editor</span><Keys keys="⌘↵" />
          </button>
          {tableActions?.structureLabel && tableActions.onAddRow && <button type="button" role="menuitem" onClick={() => invoke(tableActions.onAddRow!)}>New {tableActions.structureLabel}</button>}
          {tableActions?.structureLabel && tableActions.onDuplicateRows && selectedRows.length > 0 && <button type="button" role="menuitem"
            onClick={() => invoke(() => tableActions.onDuplicateRows!(selectedRows))}>Duplicate</button>}
          {editing && !tableActions?.structureLabel && (
            <ContextSubmenu label="Set Value" disabled={!canEditFocus}>
              <button type="button" role="menuitem" onClick={() => invoke(() => setSelectedValues(''))}>EMPTY</button>
              <button type="button" role="menuitem" disabled={!!sel && !editing.nullable(sel.c)} onClick={() => invoke(() => setSelectedValues(null))}>NULL</button>
              <button type="button" role="menuitem" disabled title="Not supported for existing rows yet">DEFAULT</button>
            </ContextSubmenu>
          )}
          {onRefresh && (
            <>
              <div className="conn-menu-separator" role="separator" />
              <button type="button" role="menuitem" onClick={() => invoke(onRefresh)}>Refresh</button>
            </>
          )}
          {editing && !tableActions?.structureLabel && (
            <>
              <div className="conn-menu-separator" role="separator" />
              <button type="button" role="menuitem" disabled={!canEditFocus} onClick={() => invoke(() => void pasteFromClipboard(false))}>
                <span>Paste</span><Keys keys="⌘V" />
              </button>
              <button type="button" role="menuitem" disabled={singleCell} onClick={() => invoke(() => void pasteFromClipboard(true))}>
                <span>Paste to {singleCell ? 'Selected Cells' : plural(selectedCellCount, 'Cell')}</span><Keys keys="⌘⇧V" />
              </button>
              {tableActions?.onAddRow && (
                <button type="button" role="menuitem" onClick={() => invoke(tableActions.onAddRow!)}>
                  <span>Add Row</span><Keys keys="⌘I" />
                </button>
              )}
              {tableActions?.onDuplicateRows && (
                <button type="button" role="menuitem" disabled={!selectedRows.length} onClick={() => invoke(() => tableActions.onDuplicateRows!(selectedRows))}>
                  <span>Duplicate {selectedRows.length ? plural(selectedRows.length, 'Row') : 'Rows'}</span><Keys keys="⌘D" />
                </button>
              )}
            </>
          )}
          <div className="conn-menu-separator" role="separator" />
          <button type="button" role="menuitem" disabled={!rangeBounds} onClick={() => invoke(copyRowsPlain)}>
            Copy {rangeBounds ? plural(selectedRows.length, 'Row') : 'Rows'}
          </button>
          <ContextSubmenu label={rangeBounds ? `Copy ${plural(selectedRows.length, 'Row')} As` : 'Copy Rows As'} disabled={!rangeBounds}>
            {copyAsItems('rows')}
          </ContextSubmenu>
          <button type="button" role="menuitem" disabled={!rangeBounds} onClick={() => invoke(copySelectedCells)}>
            <span>Copy {rangeBounds ? plural(selectedCellCount, 'Cell') : 'Selected Cells'}</span><Keys keys="⌘C" />
          </button>
          <ContextSubmenu label={rangeBounds ? `Copy ${plural(selectedCellCount, 'Cell')} As` : 'Copy Selected Cells As'} disabled={!rangeBounds}>
            {copyAsItems('cells')}
          </ContextSubmenu>
          <button type="button" role="menuitem" disabled={!sel} onClick={() => invoke(copyAllColumnValues)}>
            Copy All Column Values
          </button>
          {tableActions?.onQuickFilter && (
            <>
              <div className="conn-menu-separator" role="separator" />
              <ContextSubmenu label="Quick Filter" disabled={!sel}>
                {QUICK_FILTER_OPS.map((o) => (
                  <button type="button" key={o.op} role="menuitem" onClick={() => invoke(() => quickFilter(o.op))}>
                    {sel ? `${columns[sel.c].name} ${o.label}${o.needsValue ? ` ${JSON.stringify(cellToText(rows[sel.r]?.[sel.c] ?? null, 'NULL'))}` : ''}` : o.label}
                  </button>
                ))}
              </ContextSubmenu>
            </>
          )}
          {tableActions?.onImport && (
            <>
              <div className="conn-menu-separator" role="separator" />
              <ContextSubmenu label="Import">
                <button type="button" role="menuitem" onClick={() => invoke(() => tableActions.onImport!('csv'))}>From CSV…</button>
                <button type="button" role="menuitem" onClick={() => invoke(() => tableActions.onImport!('json'))}>From JSON…</button>
                <button type="button" role="menuitem" onClick={() => invoke(() => tableActions.onImport!('sql'))}>From SQL Dump…</button>
              </ContextSubmenu>
            </>
          )}
          {onExportPage && <button type="button" role="menuitem" onClick={() => invoke(onExportPage)}>Export current page…</button>}
          {tableActions?.onDeleteRows && (
            <>
              <div className="conn-menu-separator" role="separator" />
              <button
                type="button"
                role="menuitem"
                className="destructive"
                disabled={!selectedRows.length}
                onClick={() => invoke(() => { if (tableActions.structureLabel) tableActions.onDeleteRows!(selectedRows); else setConfirmDelete(selectedRows); })}
              >
                {tableActions.structureLabel ? 'Drop / Delete' : `Delete ${selectedRows.length ? plural(selectedRows.length, 'Row') : 'Rows'}`}
              </button>
            </>
          )}
        </div>
      )}
      {confirmDelete && (
        <Modal
          narrow
          title={`Delete ${confirmDelete.length} row${confirmDelete.length === 1 ? '' : 's'}?`}
          onClose={() => setConfirmDelete(null)}
          footer={
            <>
              <button className="btn" onClick={() => setConfirmDelete(null)}>Cancel</button>
              <button
                className="btn danger"
                onClick={() => {
                  tableActions?.onDeleteRows?.(confirmDelete);
                  setConfirmDelete(null);
                }}
              >
                Delete
              </button>
            </>
          }
        >
          <p>This cannot be undone.</p>
        </Modal>
      )}
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
