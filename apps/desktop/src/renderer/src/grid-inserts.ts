import { canEditGridInsertColumn, cellToText, gridInputCell, gridRowId, type Cell, type ColumnInfo, type GridChanges, type GridRowKey, type InsertCell } from '@earthql/core';
import type { GridRowsClipboard } from './grid-clipboard';
import type { GridDraft } from './store';

export function gridDraftRowCount(draft: GridDraft | undefined): number {
  return new Set([...Object.keys(draft?.rows ?? {}), ...Object.keys(draft?.deletes ?? {})]).size + (draft?.inserts?.length ?? 0);
}

export function stageGridDeletes(draft: GridDraft | undefined, keys: GridRowKey[], insertIds: string[]): GridDraft | undefined {
  const deletes = { ...draft?.deletes };
  for (const key of keys) deletes[gridRowId(key)] = { key };
  const rows = Object.fromEntries(Object.entries(draft?.rows ?? {}).filter(([id]) => !deletes[id]));
  const ids = new Set(insertIds);
  const inserts = draft?.inserts?.filter(({ id }) => !ids.has(id));
  return Object.keys(rows).length || Object.keys(deletes).length || inserts?.length ? { rows, inserts, deletes } : undefined;
}

export function newGridRow(columns: ColumnInfo[], source?: Record<string, InsertCell>, duplicate = false): Record<string, InsertCell> {
  return Object.fromEntries(columns.map((column): [string, InsertCell] => {
    if (!canEditGridInsertColumn(column) || column.defaultValue !== null) {
      if (!source?.[column.name] || !canEditGridInsertColumn(column) || (duplicate && column.isPrimaryKey)) return [column.name, { kind: 'default' }];
    }
    if (source?.[column.name] && !(duplicate && column.isPrimaryKey)) {
      const cell = source[column.name];
      return [column.name, cell.kind === 'value' ? gridInputCell(column, cell.value) : { ...cell }];
    }
    return [column.name, column.nullable ? { kind: 'null' } : { kind: 'value', value: '' }];
  }));
}

export function gridChangesForSave(columns: ColumnInfo[], changes: GridChanges): GridChanges {
  const known = new Map(columns.map((column) => [column.name, column]));
  return {
    ...(changes.deletes ? { deletes: changes.deletes } : {}),
    updates: changes.updates.map((row) => ({ ...row, changes: row.changes.map((change) => {
      const column = known.get(change.column);
      return column && change.expression === undefined && gridInputCell(column, change.value).kind === 'now' ?
        { ...change, value: null, expression: 'now' as const } : change;
    }) })),
    inserts: changes.inserts.map((row) => Object.fromEntries(Object.entries(row).map(([name, cell]) => {
      const column = known.get(name);
      return [name, column && cell.kind === 'value' ? gridInputCell(column, cell.value) : cell];
    }))),
  };
}

export function insertCell(value: Cell): InsertCell {
  return value === null ? { kind: 'null' } : { kind: 'value', value: cellToText(value) };
}

export function pastedGridRows(columns: ColumnInfo[], displayedColumns: string[], clipboard: GridRowsClipboard): Record<string, InsertCell>[] {
  const names = clipboard.columns ?? displayedColumns;
  if (new Set(names).size !== names.length || names.length !== displayedColumns.length ||
    names.some((name) => !displayedColumns.includes(name))) {
    throw new Error('The copied columns do not match this table. Paste rows with the same columns.');
  }
  if (!clipboard.rows.length || clipboard.rows.some((row) => row.length !== names.length)) {
    throw new Error(`Paste rows with exactly ${names.length} columns.`);
  }
  return clipboard.rows.map((row, r) => newGridRow(columns, Object.fromEntries(names.map((name, i) => [
    name, clipboard.defaults?.[r]?.[i] ? { kind: 'default' } : clipboard.now?.[r]?.[i] ? { kind: 'now' } : insertCell(row[i]),
  ]))));
}
