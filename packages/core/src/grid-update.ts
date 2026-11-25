import type { Dialect } from './dialect';
import type { DriverConnection, StatementInput } from './driver';
import { makeError } from './errors';
import type { ColumnInfo, GridRowDelete, GridRowUpdate, SqlParam, TableStructure, WriteResult } from './types';

export const MAX_GRID_UPDATE_ROWS = 1000;

const TEXT = /^(?:(?:n?varchar|n?char|character(?: varying)?)\s*(?:\(\s*(?:\d+|max)\s*\))?|(?:tiny|medium|long)?text|uuid|uniqueidentifier)$/i;
const INTEGER = /^(?:tinyint|smallint|mediumint|int|integer|bigint)\s*(?:\(\s*\d+\s*\))?(?:\s+unsigned)?$/i;
const DECIMAL = /^(?:decimal|numeric)\s*(?:\(\s*\d+\s*(?:,\s*\d+\s*)?\))?(?:\s+unsigned)?$/i;
const OTHER_SCALARS = /^(?:real|float(?:\(\d+\))?|double(?: precision)?|money|smallmoney|bool|boolean|bit|date|(?:datetime2?|datetimeoffset|smalldatetime|time|timestamp)(?:\(\d+\))?(?: (?:with|without) time zone)?)$/i;

export function isGridText(column: ColumnInfo): boolean {
  return TEXT.test(column.type.trim()) && !/^(uuid|uniqueidentifier)$/i.test(column.type.trim());
}

export function gridPrimaryKey(structure: TableStructure): ColumnInfo[] | null {
  const key = structure.constraints.find((constraint) => constraint.type === 'PRIMARY KEY');
  if (!key?.columns.length || new Set(key.columns).size !== key.columns.length) return null;
  const columns = key.columns.map((name) => structure.columns.find((column) => column.name === name));
  if (columns.some((column) => !column || ![TEXT, INTEGER, DECIMAL].some((kind) => kind.test(column.type.trim())))) return null;
  return columns as ColumnInfo[];
}

export function canEditGridColumn(column: ColumnInfo, key: ColumnInfo[]): boolean {
  const type = column.type.trim();
  return !column.isGenerated && !column.isIdentity && !key.some((part) => part.name === column.name) &&
    [TEXT, INTEGER, DECIMAL, OTHER_SCALARS].some((kind) => kind.test(type));
}

export function gridRowId(key: GridRowUpdate['key']): string {
  return JSON.stringify(key.map(({ value }) => value));
}

function validateValue(column: ColumnInfo, value: unknown): asserts value is string | null {
  if (value === null && column.nullable !== false) return;
  if (typeof value !== 'string') throw makeError('config', `${column.name} requires a value.`);
  const type = column.type.trim();
  const valid = INTEGER.test(type) ? /^[+-]?\d+$/.test(value.trim()) :
    DECIMAL.test(type) ? /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim()) :
    /^(?:real|float|double|money|smallmoney)\b/i.test(type) ? /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?$/i.test(value.trim()) :
    /^(?:bool|boolean|bit)$/i.test(type) ? /^(?:true|false|0|1)$/i.test(value.trim()) :
    /^(?:uuid|uniqueidentifier)$/i.test(type) ? /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value) :
    TEXT.test(type) || value.trim() !== '';
  if (!valid) throw makeError('config', `Enter a valid ${column.type} value for ${column.name}.`);
}

export function buildGridUpdates(dialect: Dialect, structure: TableStructure, rows: GridRowUpdate[]): StatementInput[] {
  const key = gridPrimaryKey(structure);
  if (!structure.gridUpdate || structure.kind !== 'table' || structure.columnsStatus.state !== 'ok' || !key) {
    throw makeError('unsupported', 'Editing requires a transactional table with an enforced primary key of supported types.');
  }
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > MAX_GRID_UPDATE_ROWS) {
    throw makeError('config', `Save between 1 and ${MAX_GRID_UPDATE_ROWS} edited rows at a time.`);
  }
  const columns = new Map(structure.columns.map((column) => [column.name, column]));
  const seen = new Set<string>();
  return rows.map((row) => {
    if (!Array.isArray(row?.key) || row.key.length !== key.length || !key.every((column, i) => row.key[i]?.column === column.name && typeof row.key[i].value === 'string')) {
      throw makeError('config', 'The primary key no longer matches the table. Refresh the table and try again.');
    }
    const id = gridRowId(row.key);
    if (seen.has(id)) throw makeError('config', 'The same row appears twice in the changes.');
    seen.add(id);
    if (!Array.isArray(row.changes) || row.changes.length === 0 || row.changes.some((change) => typeof change?.column !== 'string') ||
      new Set(row.changes.map((change) => change.column)).size !== row.changes.length) {
      throw makeError('config', 'Invalid cell changes.');
    }

    const params: SqlParam[] = [];
    function bind(value: string) {
      return dialect.placeholder(params.push({ value }) - 1);
    }
    const assignments = row.changes.map(({ column: name, value }) => {
      const column = columns.get(name);
      if (!column || !canEditGridColumn(column, key)) throw makeError('config', `Column ${name} cannot be edited from the grid.`);
      validateValue(column, value);
      return `${dialect.quoteIdent(name)} = ${value === null ? 'NULL' : dialect.insertValueExpr(bind(value), column)}`;
    });
    const where = key.map((column, i) => {
      const value = row.key[i].value;
      validateValue(column, value);
      return dialect.gridUpdateMatch(column, bind(value), false);
    });
    for (const { column: name, original } of row.changes) {
      const column = columns.get(name)!;
      validateValue(column, original);
      where.push(original === null ? `${dialect.quoteIdent(name)} IS NULL` : dialect.gridUpdateMatch(column, bind(original), true));
    }
    return {
      sql: `UPDATE ${dialect.qualify(structure.object)} SET ${assignments.join(', ')} WHERE ${where.join(' AND ')}`,
      params,
    };
  });
}

/**
 * DELETE statements for existing rows, matched by primary key only (deleting is final — there is
 * no "original value" to additionally compare, unlike an edited column in buildGridUpdates).
 */
export function buildGridDeletes(dialect: Dialect, structure: TableStructure, rows: GridRowDelete[]): StatementInput[] {
  const key = gridPrimaryKey(structure);
  if (!structure.gridUpdate || structure.kind !== 'table' || structure.columnsStatus.state !== 'ok' || !key) {
    throw makeError('unsupported', 'Deleting rows requires a transactional table with an enforced primary key of supported types.');
  }
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > MAX_GRID_UPDATE_ROWS) {
    throw makeError('config', `Delete between 1 and ${MAX_GRID_UPDATE_ROWS} rows at a time.`);
  }
  const seen = new Set<string>();
  return rows.map((row) => {
    if (!Array.isArray(row?.key) || row.key.length !== key.length || !key.every((column, i) => row.key[i]?.column === column.name && typeof row.key[i].value === 'string')) {
      throw makeError('config', 'The primary key no longer matches the table. Refresh the table and try again.');
    }
    const id = gridRowId(row.key);
    if (seen.has(id)) throw makeError('config', 'The same row appears twice in the selection.');
    seen.add(id);

    const params: SqlParam[] = [];
    function bind(value: string) {
      return dialect.placeholder(params.push({ value }) - 1);
    }
    const where = key.map((column, i) => {
      const value = row.key[i].value;
      validateValue(column, value);
      return dialect.gridUpdateMatch(column, bind(value), false);
    });
    return { sql: `DELETE FROM ${dialect.qualify(structure.object)} WHERE ${where.join(' AND ')}`, params };
  });
}

export async function executeAtomicGridUpdates(statements: StatementInput[], transaction: {
  begin(): Promise<unknown>;
  update(statement: StatementInput): Promise<number | undefined>;
  commit(): Promise<unknown>;
  rollback(): Promise<unknown>;
  classifyError(error: unknown): ReturnType<DriverConnection['classifyError']>;
}): Promise<void> {
  await transaction.begin();
  try {
    for (const row of statements) {
      if (await transaction.update(row) !== 1) {
        throw makeError('constraint', 'A row changed or could not be uniquely matched. The batch was rolled back.', { code: 'GRID_CONFLICT' });
      }
    }
  } catch (error) {
    await transaction.rollback().catch(() => undefined);
    throw error;
  }
  try {
    await transaction.commit();
  } catch (error) {
    await transaction.rollback().catch(() => undefined);
    const info = transaction.classifyError(error);
    if (info.category === 'network' || info.category === 'timeout') throw makeError('outcome_unknown', 'The database did not confirm the commit. Refresh to verify the stored values before editing again.');
    throw error;
  }
}

export async function runGridUpdates(conn: DriverConnection, structure: TableStructure, rows: GridRowUpdate[]): Promise<WriteResult> {
  const started = Date.now();
  try {
    if (!conn.applyGridUpdates) throw makeError('unsupported', 'This driver does not support editing cells from the grid.');
    await conn.applyGridUpdates(structure.object, buildGridUpdates(conn.dialect, structure, rows));
    return { status: 'ok', rowsAffected: rows.length, durationMs: Date.now() - started };
  } catch (error) {
    const info = conn.classifyError(error);
    return { status: info.category === 'outcome_unknown' ? 'outcome_unknown' : 'error', error: info, durationMs: Date.now() - started };
  }
}

/** Deletes existing rows by primary key, in the same all-or-nothing transaction as grid edits. */
export async function runGridDeletes(conn: DriverConnection, structure: TableStructure, rows: GridRowDelete[]): Promise<WriteResult> {
  const started = Date.now();
  try {
    if (!conn.applyGridUpdates) throw makeError('unsupported', 'This driver does not support deleting rows from the grid.');
    await conn.applyGridUpdates(structure.object, buildGridDeletes(conn.dialect, structure, rows));
    return { status: 'ok', rowsAffected: rows.length, durationMs: Date.now() - started };
  } catch (error) {
    const info = conn.classifyError(error);
    return { status: info.category === 'outcome_unknown' ? 'outcome_unknown' : 'error', error: info, durationMs: Date.now() - started };
  }
}
