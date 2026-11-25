import { describe, expect, it } from 'vitest';
import { makeError, type ConnectionProfile, type DriverModule, type Filter } from '@earthql/core';
import { postgresDriver } from '@earthql/driver-postgres';
import { mysqlDriver } from '@earthql/driver-mysql';
import { mssqlDriver } from '@earthql/driver-mssql';
import { databricksDriver } from '@earthql/driver-databricks';

const base = { id: 'test', name: 'Test', env: { name: 'Test', color: '#888' }, createdAt: 0, updatedAt: 0 };
const sqlProfile = { ...base, host: 'localhost', port: 1, database: 'demo', user: 'user', tls: { mode: 'disable' as const } };
const targets: { driver: DriverModule; profile: ConnectionProfile; authError: object; permissionError: object; syntaxError: object }[] = [
  { driver: postgresDriver, profile: { ...sqlProfile, driver: 'postgres' }, authError: { code: '28P01' }, permissionError: { code: '42501' }, syntaxError: { code: '42601' } },
  { driver: mysqlDriver, profile: { ...sqlProfile, driver: 'mysql' }, authError: { errno: 1045 }, permissionError: { errno: 1142 }, syntaxError: { errno: 1064 } },
  { driver: mssqlDriver, profile: { ...sqlProfile, driver: 'mssql' }, authError: { number: 18456 }, permissionError: { number: 229 }, syntaxError: { number: 102 } },
  { driver: databricksDriver, profile: { ...base, driver: 'databricks', host: 'host', httpPath: '/sql', authMode: 'access-token', catalog: 'demo', schema: 'public' }, authError: { status: 401 }, permissionError: { message: 'PERMISSION_DENIED' }, syntaxError: { message: 'PARSE_SYNTAX_ERROR' } },
];

const object = { catalog: 'demo', database: 'demo', schema: 'public', name: 'items' };
const columns = [
  { name: 'id', type: 'INT', kind: 'number' as const },
  { name: 'name', type: 'VARCHAR(100)', kind: 'text' as const },
  { name: 'note', type: 'VARCHAR(100)', kind: 'text' as const },
];

describe.each(targets)('$driver.id database feature contract', ({ driver, profile, authError, permissionError, syntaxError }) => {
  const dialect = driver.dialect;
  const conn = driver.connect(profile, { password: 'secret-value', accessToken: 'secret-value' });

  it('classifies errors and redacts credentials', () => {
    expect(conn.classifyError(authError).category).toBe('auth');
    expect(conn.classifyError(permissionError).category).toBe('permission');
    expect(conn.classifyError(syntaxError).category).toBe('syntax');
    expect(JSON.stringify(conn.classifyError(makeError('config', 'secret-value')))).not.toContain('secret-value');
  });

  it('binds filter values, preserves AND/OR precedence, and builds unpaginated export SQL', () => {
    const filters: Filter[] = [
      { column: 'id', op: 'in', value: '1, 2' },
      { column: 'name', op: 'contains', value: "O'Brien", join: 'or' },
      { column: 'note', op: 'is_null' },
    ];
    const request = { object, filters, sort: { column: 'id', dir: 'desc' as const }, offset: 2, pageSize: 1 };
    const page = dialect.buildBrowse(request, columns);
    const all = dialect.buildBrowseAll(request, columns);
    expect(page.errors).toEqual([]);
    expect(page.params).toEqual([{ value: '1' }, { value: '2' }, { value: "%O'Brien%" }]);
    expect(page.sql).not.toContain("O'Brien");
    expect(page.sql).toMatch(/ IN \(.+\) OR \(.+ AND .+ IS NULL\)/);
    expect(all.params).toEqual(page.params);
    expect(all.sql).not.toMatch(/\b(?:LIMIT|OFFSET|FETCH)\b/i);
  });

  it('rejects invalid filters and unsafe raw SQL before execution', () => {
    const request = { object, offset: 0, pageSize: 10 };
    expect(dialect.buildBrowse({ ...request, filters: [{ column: 'missing', op: '=', value: '1' }] }, columns).errors).not.toEqual([]);
    expect(dialect.buildBrowse({ ...request, filters: [{ column: '', op: 'raw', value: '1=1; DROP TABLE items' }] }).errors).not.toEqual([]);
    expect(dialect.buildBrowse({ ...request, filters: [{ column: 'id', op: 'between', value: '1' }] }, columns).errors).not.toEqual([]);
  });

  it('binds each supported filter operator and does not embed filter values in SQL', () => {
    const cases: { filter: Filter; params: (string | null)[] }[] = [
      ...(['=', '!=', '<', '<=', '>', '>='] as const).map((op) => ({ filter: { column: 'name', op, value: 'sample_value' }, params: ['sample_value'] })),
      ...(['contains', 'not_contains', 'contains_cs', 'not_contains_cs'] as const).map((op) => ({ filter: { column: 'name', op, value: 'sample_value' }, params: ['%sample\\_value%'] })),
      ...(['starts_with', 'starts_with_cs'] as const).map((op) => ({ filter: { column: 'name', op, value: 'sample_value' }, params: ['sample\\_value%'] })),
      ...(['ends_with', 'ends_with_cs'] as const).map((op) => ({ filter: { column: 'name', op, value: 'sample_value' }, params: ['%sample\\_value'] })),
      { filter: { column: 'name', op: 'like', value: 'sample%' }, params: ['sample%'] },
      ...(['in', 'not_in'] as const).map((op) => ({ filter: { column: 'id', op, value: '1, 2' }, params: ['1', '2'] })),
      ...(['between', 'not_between'] as const).map((op) => ({ filter: { column: 'id', op, value: '1', value2: '2' }, params: ['1', '2'] })),
      ...(['is_null', 'is_not_null'] as const).map((op) => ({ filter: { column: 'note', op }, params: [] })),
    ];
    for (const { filter, params } of cases) {
      const stmt = dialect.buildBrowse({ object, filters: [filter], offset: 0, pageSize: 10 }, columns);
      expect(stmt.errors, filter.op).toEqual([]);
      expect(stmt.params.map(({ value }) => value), filter.op).toEqual(params);
      expect(stmt.sql, filter.op).not.toContain('sample_value');
    }
  });

  it('builds inserts with bound Unicode and distinct NULL and DEFAULT values', () => {
    const stmt = dialect.buildInsert({
      object, columns,
      rows: [
        { id: { kind: 'value', value: '1' }, name: { kind: 'value', value: "สวัสดี O'Brien" }, note: { kind: 'null' } },
        { id: { kind: 'value', value: '2' }, name: { kind: 'default' }, note: { kind: 'value', value: '' } },
      ],
    });
    expect(stmt.errors).toEqual([]);
    expect(stmt.params).toEqual([{ value: '1' }, { value: "สวัสดี O'Brien" }, { value: '2' }, { value: '' }]);
    expect(stmt.sql).toContain('NULL');
    expect(stmt.sql).toContain('DEFAULT');
    expect(stmt.sql).not.toContain("O'Brien");
  });

  it('validates table creation and rejects unsafe types and expressions', () => {
    const spec = { object, ifNotExists: false, columns: [{ name: 'id', type: 'INT', nullable: false, primaryKey: true, default: { kind: 'none' as const } }] };
    expect(dialect.buildCreateTable(spec).errors).toEqual([]);
    expect(dialect.buildCreateTable({ ...spec, columns: [{ ...spec.columns[0], type: 'INT; DROP TABLE x' }] }).errors).not.toEqual([]);
    expect(dialect.buildCreateTable({ ...spec, columns: [{ ...spec.columns[0], default: { kind: 'expression', value: '1; DROP TABLE x' } }] }).errors).not.toEqual([]);
  });
});
