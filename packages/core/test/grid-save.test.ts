import { describe, expect, it, vi } from 'vitest';
import {
  buildGridInserts, buildGridUpdates, executeAtomicGridUpdates, isEarthQLError, makeError, runGridSave,
  type ColumnInfo, type DriverConnection, type InsertCell, type TableStructure,
} from '@earthql/core';
import { mysqlDialect } from '@earthql/driver-mysql';
import { postgresDialect } from '@earthql/driver-postgres';
import { mssqlDialect } from '@earthql/driver-mssql';
import { databricksDialect } from '@earthql/driver-databricks';

const column = (name: string, extra: Partial<ColumnInfo> = {}): ColumnInfo => ({
  name, type: 'text', kind: 'text', ordinal: 0, nullable: false, isPrimaryKey: false, defaultValue: null, ...extra,
});
const structure: TableStructure = {
  object: { database: 'demo', schema: 'public', name: 'items' }, kind: 'table', gridUpdate: true,
  columns: [
    column('id', { type: 'int', kind: 'number', isPrimaryKey: true, isIdentity: true }),
    column('name'), column('amount', { type: 'decimal(38,10)', kind: 'number' }),
    column('note', { nullable: true }), column('created_at', { defaultValue: 'CURRENT_TIMESTAMP' }),
    column('generated', { isGenerated: true }),
  ],
  columnsStatus: { state: 'ok' }, indexes: [], indexesStatus: { state: 'empty' },
  constraints: [{ name: 'pk', type: 'PRIMARY KEY', columns: ['id'] }], constraintsStatus: { state: 'ok' },
};
const insert: Record<string, InsertCell> = {
  id: { kind: 'default' }, name: { kind: 'value', value: "O'Brien" },
  amount: { kind: 'value', value: '12345678901234567890.0123456789' },
  note: { kind: 'null' }, created_at: { kind: 'default' }, generated: { kind: 'default' },
};
const update = { key: [{ column: 'id', value: '1' }], changes: [{ column: 'name', original: 'before', value: 'after' }] };

function connection() {
  const conn: DriverConnection = {
    driver: 'mysql', dialect: mysqlDialect,
    capabilities: vi.fn<DriverConnection['capabilities']>(), test: vi.fn<DriverConnection['test']>(),
    listChildren: vi.fn<DriverConnection['listChildren']>(), getStructure: vi.fn<DriverConnection['getStructure']>(),
    getPrivileges: vi.fn<DriverConnection['getPrivileges']>(), defaultContext: () => ({}),
    completionSchema: vi.fn<DriverConnection['completionSchema']>(), close: async () => undefined,
    classifyError: (error) => isEarthQLError(error) ? error.toInfo() : { category: 'unknown', message: String(error) },
    openCursor: vi.fn(() => ({
      fetch: async () => ({ columns: null, rows: [], done: true, rowsAffected: 2 }),
      close: async () => undefined, cancel: async () => 'requested' as const,
    })),
    applyGridUpdates: vi.fn(async () => undefined),
  };
  return conn;
}

describe('saving staged grid inserts', () => {
  it('binds values and omits identity, generated and DEFAULT columns for every driver', () => {
    for (const dialect of [mysqlDialect, postgresDialect, mssqlDialect, databricksDialect]) {
      const [statement] = buildGridInserts(dialect, structure, [insert]);
      expect(statement.errors).toEqual([]);
      expect(statement.params).toEqual([{ value: "O'Brien" }, { value: '12345678901234567890.0123456789' }]);
      expect(statement.sql).not.toMatch(/id|generated|created_at/);
      expect(statement.sql).toContain('NULL');
      expect(statement.sql).not.toContain("O'Brien");
    }
  });

  it('builds dialect-correct default-only rows without inserting an identity', () => {
    const identityOnly = { ...structure, columns: [structure.columns[0]] };
    expect(buildGridInserts(mysqlDialect, identityOnly, [{ id: { kind: 'default' } }])[0].sql)
      .toBe('INSERT INTO `demo`.`items` () VALUES ()');
    for (const dialect of [postgresDialect, mssqlDialect]) {
      expect(buildGridInserts(dialect, identityOnly, [{}])[0].sql).toMatch(/DEFAULT VALUES$/);
    }
  });

  it('rejects invalid values, missing required values and explicit generated values before any write', async () => {
    for (const row of [
      { ...insert, name: { kind: 'null' as const } },
      { ...insert, amount: { kind: 'value' as const, value: '' } },
      { ...insert, amount: { kind: 'default' as const } },
      { ...insert, id: { kind: 'value' as const, value: '1' } },
      { ...insert, unknown: { kind: 'value' as const, value: 'x' } },
    ]) {
      const conn = connection();
      expect((await runGridSave(conn, structure, { updates: [], inserts: [row] })).status).toBe('error');
      expect(conn.applyGridUpdates).not.toHaveBeenCalled();
      expect(conn.openCursor).not.toHaveBeenCalled();
    }
  });

  it('saves existing edits and new rows in one atomic batch', async () => {
    const conn = connection();
    const result = await runGridSave(conn, structure, { updates: [update], inserts: [insert] });
    expect(result).toMatchObject({ status: 'ok', rowsAffected: 2 });
    expect(conn.applyGridUpdates).toHaveBeenCalledOnce();
    const statements = vi.mocked(conn.applyGridUpdates!).mock.calls[0][1];
    expect(statements.map(({ sql }) => sql.split(' ')[0])).toEqual(['UPDATE', 'INSERT']);
    expect(conn.openCursor).not.toHaveBeenCalled();
  });

  it('rolls back the batch if an insert fails after an update', async () => {
    const conn = connection();
    const transaction = {
      begin: vi.fn(async () => undefined), update: vi.fn(async () => 1),
      commit: vi.fn(async () => undefined), rollback: vi.fn(async () => undefined), classifyError: conn.classifyError,
    };
    transaction.update.mockResolvedValueOnce(1).mockRejectedValueOnce(makeError('constraint', 'Duplicate key'));
    conn.applyGridUpdates = (object, statements) => executeAtomicGridUpdates(statements, transaction);
    const result = await runGridSave(conn, structure, { updates: [update], inserts: [insert] });
    expect(result).toMatchObject({ status: 'error', error: { category: 'constraint' } });
    expect(transaction.rollback).toHaveBeenCalledOnce();
    expect(transaction.commit).not.toHaveBeenCalled();
  });

  it('reports an unknown outcome if a mixed save loses its commit confirmation', async () => {
    const conn = connection();
    const transaction = {
      begin: async () => undefined, update: async () => 1, rollback: async () => undefined,
      commit: async () => { throw makeError('network', 'Disconnected'); }, classifyError: conn.classifyError,
    };
    conn.applyGridUpdates = (object, statements) => executeAtomicGridUpdates(statements, transaction);
    expect(await runGridSave(conn, structure, { updates: [update], inserts: [insert] }))
      .toMatchObject({ status: 'outcome_unknown', error: { category: 'outcome_unknown' } });
  });

  it('supports insert-only tables without a primary key or atomic grid updates', async () => {
    const conn = connection();
    conn.applyGridUpdates = undefined;
    const result = await runGridSave(conn, { ...structure, gridUpdate: false, constraints: [] }, { updates: [], inserts: [insert, insert] });
    expect(result).toMatchObject({ status: 'ok', rowsAffected: 2 });
    expect(conn.openCursor).toHaveBeenCalledOnce();
    const statement = vi.mocked(conn.openCursor).mock.calls[0][0];
    expect(statement.sql).toMatch(/^INSERT/);
    expect(statement.sql).not.toContain('`id`');
  });

  it('enforces the combined staged-row limit before writing', async () => {
    const conn = connection();
    const result = await runGridSave(conn, structure, { updates: [update], inserts: Array.from({ length: 1000 }, () => insert) });
    expect(result).toMatchObject({ status: 'error', error: { category: 'config' } });
    expect(conn.applyGridUpdates).not.toHaveBeenCalled();
  });
  it('supports multiple identity-only rows on a nontransactional MySQL table', async () => {
    const conn = connection();
    conn.applyGridUpdates = undefined;
    const result = await runGridSave(conn, { ...structure, gridUpdate: false, columns: [structure.columns[0]] }, { updates: [], inserts: [{}, {}] });
    expect(result.status).toBe('ok');
    expect(vi.mocked(conn.openCursor).mock.calls[0][0].sql).toBe('INSERT INTO `demo`.`items` () VALUES (), ()');
  });
  it('does not confuse a constructor-named column with an inherited object property', () => {
    const target = { ...structure, columns: [column('constructor')] };
    expect(() => buildGridInserts(mysqlDialect, target, [{}])).toThrow(/enter a value for constructor/);
    const row = Object.fromEntries([['constructor', { kind: 'value' as const, value: 'provided' }]]);
    expect(buildGridInserts(mysqlDialect, target, [row])[0].params).toEqual([{ value: 'provided' }]);
  });

  it('evaluates NOW() on the database for inserted datetime cells, not as a bound string', () => {
    const target = { ...structure, columns: [column('created_at', { type: 'timestamp', kind: 'date' })] };
    for (const dialect of [mysqlDialect, postgresDialect, mssqlDialect, databricksDialect]) {
      const statement = buildGridInserts(dialect, target, [{ created_at: { kind: 'now' } }])[0];
      expect(statement.sql).toContain('CURRENT_TIMESTAMP');
      expect(statement.params).toEqual([]);
      const typed = buildGridInserts(dialect, target, [{ created_at: { kind: 'value', value: 'NOW()' } }])[0];
      expect(typed.sql).toContain('CURRENT_TIMESTAMP');
      expect(typed.params).toEqual([]);
      const literal = buildGridInserts(dialect, { ...target, columns: [column('name')] }, [{ name: { kind: 'value', value: 'NOW()' } }])[0];
      expect(literal.params).toEqual([{ value: 'NOW()' }]);
    }
    expect(() => buildGridInserts(mysqlDialect, structure, [{ ...insert, name: { kind: 'now' } }])).toThrow(/date\/time column/);
  });

  it('supports datetime expressions on updates while preserving optimistic row matching', () => {
    const date = column('created_at', { type: 'datetime', kind: 'date', defaultValue: 'CURRENT_TIMESTAMP' });
    const target = { ...structure, columns: [structure.columns[0], date] };
    for (const dialect of [mysqlDialect, postgresDialect, mssqlDialect]) {
      for (const expression of ['now', 'default'] as const) {
        const [statement] = buildGridUpdates(dialect, target, [{
          key: update.key, changes: [{ column: 'created_at', original: '2026-01-01 12:00:00', value: null, expression }],
        }]);
        expect(statement.sql).toContain(expression === 'now' ? 'CURRENT_TIMESTAMP' : '= DEFAULT');
        expect(statement.params).toEqual([{ value: '1' }, { value: '2026-01-01 12:00:00' }]);
      }
    }
    expect(() => buildGridUpdates(mysqlDialect, structure, [{
      key: update.key, changes: [{ column: 'name', original: 'before', value: null, expression: 'now' }],
    }])).toThrow(/Invalid date\/time expression/);
    expect(() => buildGridUpdates(mysqlDialect, { ...target, columns: [structure.columns[0], { ...date, defaultValue: null }] }, [{
      key: update.key, changes: [{ column: 'created_at', original: null, value: null, expression: 'default' }],
    }])).toThrow(/has no default/);
  });

  it('interprets typed NOW() for datetime(6) updates without treating other SQL text as an expression', () => {
    const target = { ...structure, columns: [structure.columns[0], column('updated_at', { type: 'datetime(6)', kind: 'date' })] };
    for (const value of ['NOW()', ' now ( ) ']) {
      const [statement] = buildGridUpdates(mysqlDialect, target, [{
        key: update.key, changes: [{ column: 'updated_at', original: '2026-01-01 12:00:00.000000', value }],
      }]);
      expect(statement.sql).toContain('SET `updated_at` = CURRENT_TIMESTAMP');
      expect(statement.params).toEqual([{ value: '1' }, { value: '2026-01-01 12:00:00.000000' }]);
    }
    const [literal] = buildGridUpdates(mysqlDialect, target, [{
      key: update.key, changes: [{ column: 'updated_at', original: '2026-01-01 12:00:00.000000', value: 'NOW(); SELECT 1' }],
    }]);
    expect(literal.sql).not.toContain('SELECT 1');
    expect(literal.params).toEqual([{ value: 'NOW(); SELECT 1' }, { value: '1' }, { value: '2026-01-01 12:00:00.000000' }]);
  });

  it('handles typed NOW() in the insert-only bulk save fallback', async () => {
    const conn = connection();
    conn.applyGridUpdates = undefined;
    const target = { ...structure, gridUpdate: false, constraints: [], columns: [column('created_at', { type: 'datetime(6)', kind: 'date' })] };
    const result = await runGridSave(conn, target, { updates: [], inserts: [
      { created_at: { kind: 'value', value: 'NOW()' } }, { created_at: { kind: 'value', value: 'now()' } },
    ] });
    expect(result.status).toBe('ok');
    const statement = vi.mocked(conn.openCursor).mock.calls[0][0];
    expect(statement.sql.match(/CURRENT_TIMESTAMP/g)).toHaveLength(2);
    expect(statement.params).toEqual([]);
  });

  it('saves updates, staged deletions and inserts in one atomic transaction', async () => {
    const conn = connection();
    const result = await runGridSave(conn, structure, {
      updates: [update], inserts: [insert], deletes: [{ key: [{ column: 'id', value: '2' }] }],
    });
    expect(result).toMatchObject({ status: 'ok', rowsAffected: 3 });
    const statements = vi.mocked(conn.applyGridUpdates!).mock.calls[0][1];
    expect(statements.map(({ sql }) => sql.split(' ')[0])).toEqual(['UPDATE', 'DELETE', 'INSERT']);
    expect(statements[1].params).toEqual([{ value: '2' }]);
    expect(conn.openCursor).not.toHaveBeenCalled();
  });

  it('rolls back updates and retains an error if a staged deletion no longer matches', async () => {
    const conn = connection();
    const transaction = {
      begin: vi.fn(async () => undefined), update: vi.fn(async () => 1),
      commit: vi.fn(async () => undefined), rollback: vi.fn(async () => undefined), classifyError: conn.classifyError,
    };
    transaction.update.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    conn.applyGridUpdates = (_object, statements) => executeAtomicGridUpdates(statements, transaction);
    const result = await runGridSave(conn, structure, {
      updates: [update], inserts: [], deletes: [{ key: [{ column: 'id', value: '2' }] }],
    });
    expect(result).toMatchObject({ status: 'error', error: { category: 'constraint', code: 'GRID_CONFLICT' } });
    expect(transaction.rollback).toHaveBeenCalledOnce();
    expect(transaction.commit).not.toHaveBeenCalled();
  });

  it('rejects updating and deleting the same row, and includes deletions in the save limit', async () => {
    const conn = connection();
    expect(await runGridSave(conn, structure, { updates: [update], inserts: [], deletes: [{ key: update.key }] }))
      .toMatchObject({ status: 'error', error: { category: 'config', message: expect.stringContaining('updated and deleted') } });
    expect(await runGridSave(conn, structure, {
      updates: [update], inserts: [], deletes: Array.from({ length: 1000 }, (_, i) => ({ key: [{ column: 'id', value: String(i + 2) }] })),
    })).toMatchObject({ status: 'error', error: { category: 'config', message: expect.stringContaining('between 1 and 1000') } });
    expect(conn.applyGridUpdates).not.toHaveBeenCalled();
  });

  it('never falls back to insert-only writes when deletions cannot be saved atomically', async () => {
    const conn = connection();
    conn.applyGridUpdates = undefined;
    expect(await runGridSave(conn, structure, { updates: [], inserts: [insert], deletes: [{ key: update.key }] }))
      .toMatchObject({ status: 'error', error: { category: 'unsupported' } });
    expect(conn.openCursor).not.toHaveBeenCalled();
  });
});
