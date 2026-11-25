import type { Dialect } from './dialect';
import type { DriverConnection, StatementInput } from './driver';
import { makeError } from './errors';
import { ctxForObject, runWrite } from './runner';
import type { BuiltStatement, ColumnInfo, GridChanges, GridRowDelete, GridRowUpdate, InsertCell, SqlParam, TableStructure, WriteResult } from './types';

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

export function canEditGridInsertColumn(column: ColumnInfo): boolean {
  return !column.isIdentity && !column.isGenerated && !/^AS |GENERATED ALWAYS/i.test(column.defaultValue ?? '');
}

export function isGridDateTime(column: Pick<ColumnInfo, 'type' | 'kind'>): boolean {
  return column.kind === 'date' && /^(?:datetime2?|datetimeoffset|smalldatetime|timestamp(?:_ntz)?|timestamptz)(?:\(\d+\))?(?: (?:with|without) time zone)?$/i.test(column.type.trim());
}

/** Recognize only NOW() in datetime input; all other text remains a bound value. */
export function gridInputCell(column: Pick<ColumnInfo, 'type' | 'kind'>, value: string | null): InsertCell {
  if (value === null) return { kind: 'null' };
  if (isGridDateTime(column) && /^\s*now\s*\(\s*\)\s*$/i.test(value)) return { kind: 'now' };
  return { kind: 'value', value };
}

function gridInsertCell(column: ColumnInfo, row: Record<string, InsertCell>): InsertCell {
  const cell = Object.hasOwn(row, column.name) ? row[column.name] : { kind: 'default' as const };
  return cell.kind === 'value' ? gridInputCell(column, cell.value) : cell;
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
    const assignments = row.changes.map(({ column: name, value, expression }) => {
      const column = columns.get(name);
      if (!column || !canEditGridColumn(column, key)) throw makeError('config', `Column ${name} cannot be edited from the grid.`);
      if (expression === undefined && gridInputCell(column, value).kind === 'now') expression = 'now';
      if (expression !== undefined) {
        if (!isGridDateTime(column) || (expression !== 'now' && expression !== 'default')) {
          throw makeError('config', `Invalid date/time expression for ${name}.`);
        }
        if (expression === 'default' && column.nullable === false && column.defaultValue === null) {
          throw makeError('config', `Column ${name} has no default. Enter a value or choose NOW().`);
        }
        return `${dialect.quoteIdent(name)} = ${expression === 'default' ? 'DEFAULT' : dialect.insertValueExpr('CURRENT_TIMESTAMP', column)}`;
      }
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

export function buildGridInserts(dialect: Dialect, structure: TableStructure, rows: Record<string, InsertCell>[]): BuiltStatement[] {
  if (structure.kind !== 'table' || structure.columnsStatus.state !== 'ok') {
    throw makeError('unsupported', 'Inserting rows requires readable table columns.');
  }
  if (!Array.isArray(rows) || !rows.length || rows.length > MAX_GRID_UPDATE_ROWS) {
    throw makeError('config', `Save between 1 and ${MAX_GRID_UPDATE_ROWS} new rows at a time.`);
  }
  const known = new Map(structure.columns.map((column) => [column.name, column]));
  return rows.map((row, index) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw makeError('config', 'Invalid new row.');
    for (const [name, cell] of Object.entries(row)) {
      const column = known.get(name);
      if (!column || !cell || !['default', 'null', 'value', 'now'].includes(cell.kind)) throw makeError('config', `Invalid new-row value for ${name}.`);
      if (cell.kind !== 'default') {
        if (!canEditGridInsertColumn(column)) throw makeError('config', `Column ${name} is generated by the database. Use DEFAULT.`);
        if (cell.kind === 'now') {
          if (!isGridDateTime(column)) throw makeError('config', `NOW() requires a date/time column: ${name}.`);
        } else validateValue(column, cell.kind === 'null' ? null : cell.value);
      }
    }
    for (const column of structure.columns) {
      if (canEditGridInsertColumn(column) && (!Object.hasOwn(row, column.name) || row[column.name].kind === 'default') &&
        column.nullable === false && column.defaultValue === null) {
        throw makeError('config', `New row ${index + 1}: enter a value for ${column.name}.`);
      }
    }
    const columns = structure.columns.filter((column) => canEditGridInsertColumn(column) && Object.hasOwn(row, column.name) && row[column.name].kind !== 'default');
    if (!columns.length) {
      if (dialect.driver === 'databricks') {
        const writable = structure.columns.filter(canEditGridInsertColumn);
        if (!writable.length) throw makeError('unsupported', 'This table has no writable columns for a new row.');
        const statement = dialect.buildInsert({
          object: structure.object, columns: writable,
          rows: [Object.fromEntries(writable.map(({ name }) => [name, { kind: 'default' as const }]))],
        });
        if (statement.errors.length) throw makeError('config', statement.errors.join('\n'));
        return statement;
      }
      return {
        sql: dialect.driver === 'mysql' ? `INSERT INTO ${dialect.qualify(structure.object)} () VALUES ()` :
          `INSERT INTO ${dialect.qualify(structure.object)} DEFAULT VALUES`,
        params: [], target: dialect.displayTarget(structure.object), errors: [], warnings: [],
      };
    }
    const statement = dialect.buildInsert({
      object: structure.object, columns,
      rows: [Object.fromEntries(columns.map((column) => [column.name, gridInsertCell(column, row)]))],
    });
    if (statement.errors.length) throw makeError('config', statement.errors.join('\n'));
    return statement;
  });
}

export async function runGridSave(conn: DriverConnection, structure: TableStructure, changes: GridChanges): Promise<WriteResult> {
  const started = Date.now();
  try {
    if (!changes || !Array.isArray(changes.updates) || !Array.isArray(changes.inserts)) throw makeError('config', 'Invalid grid changes.');
    if (changes.deletes !== undefined && !Array.isArray(changes.deletes)) throw makeError('config', 'Invalid grid deletions.');
    const removed = changes.deletes ?? [];
    const count = changes.updates.length + changes.inserts.length + removed.length;
    if (!count || count > MAX_GRID_UPDATE_ROWS) throw makeError('config', `Save between 1 and ${MAX_GRID_UPDATE_ROWS} changed rows at a time.`);
    const updates = changes.updates.length ? buildGridUpdates(conn.dialect, structure, changes.updates) : [];
    const inserts = changes.inserts.length ? buildGridInserts(conn.dialect, structure, changes.inserts) : [];
    const deletes = removed.length ? buildGridDeletes(conn.dialect, structure, removed) : [];
    const deletedIds = new Set(removed.map(({ key }) => gridRowId(key)));
    if (changes.updates.some(({ key }) => deletedIds.has(gridRowId(key)))) {
      throw makeError('config', 'A row cannot be updated and deleted in the same Save.');
    }
    if (structure.gridUpdate && conn.applyGridUpdates) {
      await conn.applyGridUpdates(structure.object, [...updates, ...deletes, ...inserts]);
      return { status: 'ok', rowsAffected: count, durationMs: Date.now() - started };
    }
    if (updates.length || deletes.length) throw makeError('unsupported', 'This table does not support saving cell updates and deletions atomically.');
    if (inserts.length === 1) return await runWrite(conn, inserts[0], ctxForObject(structure.object));
    const columns = structure.columns.filter(canEditGridInsertColumn);
    if (!columns.length) {
      if (conn.driver !== 'mysql') throw makeError('unsupported', 'Save one default-only row at a time on this table.');
      return await runWrite(conn, {
        ...inserts[0], sql: `INSERT INTO ${conn.dialect.qualify(structure.object)} () VALUES ${inserts.map(() => '()').join(', ')}`,
      }, ctxForObject(structure.object));
    }
    const rows = changes.inserts.map((row) => Object.fromEntries(columns.map((column) => [
      column.name, gridInsertCell(column, row),
    ])));
    return await runWrite(conn, conn.dialect.buildInsert({ object: structure.object, columns, rows }), ctxForObject(structure.object));
  } catch (error) {
    const info = conn.classifyError(error);
    return { status: info.category === 'outcome_unknown' ? 'outcome_unknown' : 'error', error: info, durationMs: Date.now() - started };
  }
}
