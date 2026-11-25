import { describe, expect, it } from 'vitest';
import { mysqlDialect } from '@earthql/driver-mysql';
import { postgresDialect } from '@earthql/driver-postgres';
import { csvRecord, jsonRecord, parseImport, safeFileName, sqlValue, structureSql } from '../src/main/table-file-formats';
import { tableFileName } from '../src/renderer/src/table-file-name';
import type { TableExportOptions } from '../src/shared/api';
import type { TableStructure } from '@earthql/core';

export const options: TableExportOptions = { format: 'csv', suggestedName: 'test', delimiter: ',', quote: 'needed', lineBreak: '\n', decimal: '.', headers: true, nullToEmpty: true, replaceLineBreaks: false, bom: true, gzip: false };
describe('table transfer formats', () => {
  it('round trips quoted CSV fields, line breaks, NULL and Thai text', () => {
    const csv = csvRecord(['name', 'value'], options) + csvRecord(['ไทย, "quoted"\nnext', ''], options);
    expect(parseImport(csv, 'csv', { delimiter: ',', headers: true })).toEqual({ columns: ['name', 'value'], rows: [['ไทย, "quoted"\nnext', '']] });
    expect(csvRecord([null, ''], options)).toBe(',""\n');
    expect(csvRecord(['1.25', 'a\nb'], { ...options, decimal: ',', delimiter: ';', replaceLineBreaks: true }, [true, false])).toBe('1,25;a b\n');
  });
  it('rejects duplicate CSV headers and preserves JSON numeric precision and null', () => {
    expect(() => parseImport('x,x\n1,2', 'csv', { delimiter: ',', headers: true })).toThrow();
    expect(parseImport('[{"id":9223372036854775807,"value":1.234567890123456789,"flag":true,"missing":null}]', 'json', { delimiter: ',', headers: true })).toMatchObject({ rows: [['9223372036854775807', '1.234567890123456789', 'true', null]] });
    expect(() => parseImport('{"x":1}', 'json', { delimiter: ',', headers: true })).toThrow();
  });
  it('does not lose dangerous property names when serializing JSON rows', () => {
    expect(JSON.parse(jsonRecord([{ name: '__proto__', type: 'text', kind: 'text' }], ['safe']))).toEqual(JSON.parse('{"__proto__":"safe"}'));
  });
  it('escapes SQL literals and rejects truncated binary values', () => {
    expect(sqlValue("O'Brien", undefined, mysqlDialect)).toBe(mysqlDialect.stringLiteral("O'Brien"));
    expect(sqlValue(null, undefined, mysqlDialect)).toBe('NULL');
    expect(sqlValue('123.45', { type: 'DECIMAL(20,2)' } as any, mysqlDialect)).toBe('123.45');
    expect(() => sqlValue({ $binary: 'ab', bytes: 200, truncated: true }, undefined, mysqlDialect)).toThrow();
  });
  it('refuses an incomplete generated/identity structure', () => {
    const structure = { object: { name: 't' }, columnsStatus: { state: 'ok' }, columns: [{ name: 'id', type: 'int', isIdentity: true }], constraints: [], indexes: [], constraintsStatus: { state: 'ok' }, indexesStatus: { state: 'ok' } } as unknown as TableStructure;
    expect(() => structureSql(structure, postgresDialect)).toThrow();
  });
  it('uses local calendar parts for file patterns and sanitizes path separators', () => {
    const name = tableFileName('{database}_{table}_{year}-{month}-{day}_{hour}-{minute}-{second}', { connection: 'Local', object: { database: 'demo', name: 'a/b' }, tag: 'test' }, new Date(2026, 10, 25, 9, 7, 3));
    expect(name).toBe('demo_a_b_2026-11-25_09-07-03');
    expect(safeFileName('../../path:name')).not.toContain('/');
  });
});
