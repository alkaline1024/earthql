import { cellToText, isBinaryCell, makeError, type Cell, type ColumnInfo, type Dialect, type ResultColumn, type TableStructure } from '@earthql/core';
import { parse as parseCsv } from 'csv-parse/sync';
import { parse as parseJson, isLosslessNumber, stringify as stringifyJson } from 'lossless-json';
import type { TableExportOptions, TableImportFormat } from '../shared/api';

export function safeFileName(value: string): string {
  return value.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/^\.+|[. ]+$/g, '').trim().slice(0, 160) || 'export';
}

export function csvRecord(values: Cell[], options: TableExportOptions, numeric?: boolean[]): string {
  return values.map((value, index) => {
    if (value === null) return options.nullToEmpty ? '' : 'NULL';
    let text = cellToText(value);
    if (options.replaceLineBreaks) text = text.replace(/\r\n|\r|\n/g, ' ');
    if (options.decimal === ',' && numeric?.[index]) text = text.replace('.', ',');
    return options.quote === 'all' || text === '' || text.includes(options.delimiter) || /["\r\n]|^\s|\s$/.test(text)
      ? `"${text.replace(/"/g, '""')}"` : text;
  }).join(options.delimiter) + options.lineBreak;
}

export function jsonRecord(columns: ResultColumn[], row: Cell[]): string {
  const record = Object.create(null);
  columns.forEach((column, index) => { record[column.name] = row[index] ?? null; });
  return JSON.stringify(record);
}

export function sqlValue(value: Cell, column: ColumnInfo | undefined, dialect: Dialect): string {
  if (value === null) return 'NULL';
  if (isBinaryCell(value)) {
    if (value.truncated) throw makeError('unsupported', 'Binary values are truncated by this driver. A lossless SQL export is unavailable.');
    if (dialect.driver === 'postgres') return `decode('${value.$binary}', 'hex')`;
    if (dialect.driver === 'databricks') return `unhex('${value.$binary}')`;
    return `0x${value.$binary}`;
  }
  return dialect.literalForType(cellToText(value), column?.type ?? 'TEXT');
}

/** Metadata-based DDL; preserve known constraints and defaults rather than silently omitting them. */
export function structureSql(structure: TableStructure, dialect: Dialect): string {
  if (structure.columnsStatus.state !== 'ok') throw makeError('unsupported', 'Column metadata is required to export structure.');
  if (structure.columns.some((column) => column.isGenerated || column.isIdentity || /\bnextval\s*\(/i.test(column.defaultValue ?? ''))) {
    throw makeError('unsupported', 'This table has generated, identity, or sequence-backed columns. Use a native database dump for its exact structure, or export Data only.');
  }
  if (structure.constraintsStatus.state === 'denied' || structure.indexesStatus.state === 'denied') {
    throw makeError('permission', 'Constraint/index metadata is unavailable. Cannot export a complete table structure.');
  }
  const definitions = structure.columns.map((column) => {
    return `  ${dialect.quoteIdent(column.name)} ${column.type}${column.nullable === false ? ' NOT NULL' : ''}${column.defaultValue !== null ? ` DEFAULT ${column.defaultValue}` : ''}`;
  });
  const pk = structure.columns.filter((column) => column.isPrimaryKey);
  const constraints = structure.constraints.filter((constraint) => constraint.type !== 'PRIMARY KEY' && constraint.type !== 'PRIMARY_KEY_CONSTRAINT');
  if (pk.length) definitions.push(`  PRIMARY KEY (${pk.map((column) => dialect.quoteIdent(column.name)).join(', ')})`);
  for (const constraint of constraints) {
    if (!constraint.definition || !/^(UNIQUE|FOREIGN KEY|CHECK|EXCLUDE)\b/i.test(constraint.definition)) {
      throw makeError('unsupported', `Exact definition of constraint “${constraint.name}” is unavailable. Export Data only or use a native database dump.`);
    }
    definitions.push(`  CONSTRAINT ${dialect.quoteIdent(constraint.name)} ${constraint.definition}`);
  }
  let sql = `CREATE TABLE ${dialect.qualify(structure.object)} (\n${definitions.join(',\n')}\n);\n`;
  for (const index of structure.indexes.filter((index) => !index.primary && !constraints.some((constraint) => constraint.name === index.name))) {
    if (index.definition && /^CREATE\s/i.test(index.definition)) sql += `${index.definition.replace(/;\s*$/, '')};\n`;
    else {
      throw makeError('unsupported', `Exact definition of index “${index.name}” is unavailable. Export Data only or use a native database dump.`);
    }
  }
  return sql;
}

export function parseImport(text: string, format: TableImportFormat, options: { delimiter: string; headers: boolean }): { columns: string[]; rows: (string | null)[][] } {
  if (format === 'csv') {
    if (![',', ';', '\t', '|'].includes(options.delimiter)) throw makeError('config', 'Choose a supported CSV delimiter.');
    const records: string[][] = parseCsv(text, { bom: true, delimiter: options.delimiter, skip_empty_lines: true, relax_column_count: false, max_record_size: 4 * 1024 * 1024 });
    if (!records.length) throw makeError('config', 'The file contains no records.');
    const columns = options.headers ? records.shift()! : records[0].map((_, index) => `Column ${index + 1}`);
    if (columns.some((column) => !column.trim()) || new Set(columns).size !== columns.length) throw makeError('config', 'Column names must be non-empty and unique.');
    if (records.some((record) => record.length !== columns.length)) throw makeError('config', 'CSV rows do not match the column count.');
    return { columns, rows: records };
  }
  const value = parseJson(text.replace(/^\uFEFF/, ''));
  if (!Array.isArray(value) || !value.length || value.some((record) => !record || typeof record !== 'object' || Array.isArray(record) || isLosslessNumber(record))) {
    throw makeError('config', 'Choose a JSON array of objects, for example [{"id": 1, "name": "Alice"}].');
  }
  const columns = [...new Set(value.flatMap((record) => Object.keys(record)))];
  if (!columns.length) throw makeError('config', 'JSON objects have no fields.');
  const rows = value.map((record) => columns.map((column) => {
    const cell = record[column];
    if (cell === null || cell === undefined) return null;
    if (isLosslessNumber(cell)) return cell.value;
    if (typeof cell === 'object') return stringifyJson(cell) ?? 'null';
    return String(cell);
  }));
  return { columns, rows };
}
