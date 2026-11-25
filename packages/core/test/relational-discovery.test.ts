import { beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  pgQueries: [] as { database: string; sql: string; params?: unknown[] }[],
  mysqlQueries: [] as { sql: string; params?: unknown[] }[],
  pgClosed: [] as string[],
  mysqlClosed: 0,
}));

vi.mock('pg', () => {
  class Pool {
    constructor(private config: { database: string }) {}
    on() {}
    async query(sql: string, params?: unknown[]) {
      mock.pgQueries.push({ database: this.config.database, sql, params });
      if (sql.includes('pg_database')) return { rows: [{ datname: 'other' }] };
      if (sql.includes('pg_namespace') && !sql.includes('pg_class')) return { rows: [{ nspname: 'public' }] };
      return { rows: [{ relname: 'items', relkind: 'r' }, { relname: 'report', relkind: 'v' }] };
    }
    async end() { mock.pgClosed.push(this.config.database); }
  }
  return { default: { Pool, Client: class {}, types: { getTypeParser: () => (value: string) => value } } };
});

vi.mock('mysql2', () => ({
  default: {
    createPool: () => ({
      on() {},
      promise: () => ({
        query: async (sql: string, params?: unknown[]) => {
          mock.mysqlQueries.push({ sql, params });
          return [sql === 'SHOW DATABASES' ? [{ Database: 'mysql' }, { Database: 'demo' }, { Database: 'other' }]
            : [{ name: 'items', type: 'BASE TABLE' }, { name: 'report', type: 'VIEW' }]];
        },
        end: async () => { mock.mysqlClosed++; },
      }),
    }),
  },
}));

import { postgresDriver } from '@earthql/driver-postgres';
import { mysqlDriver } from '@earthql/driver-mysql';

const base = {
  id: 'test', name: 'Test', host: 'localhost', port: 1, database: 'demo', user: 'user',
  tls: { mode: 'disable' as const }, env: { name: 'Test', color: '#888' }, createdAt: 0, updatedAt: 0,
};

beforeEach(() => {
  mock.pgQueries = []; mock.mysqlQueries = []; mock.pgClosed = []; mock.mysqlClosed = 0;
});

describe('relational database discovery', () => {
  it('lists PostgreSQL databases, routes schemas to the selected database and binds schema names', async () => {
    const conn = postgresDriver.connect({ ...base, driver: 'postgres' }, {});
    expect(await conn.listChildren(null)).toMatchObject([{ name: 'demo', detail: 'default' }, { name: 'other' }]);
    const [schema] = await conn.listChildren({ kind: 'database', name: 'other', path: {}, hasChildren: true });
    expect(schema).toMatchObject({ name: 'public', path: { database: 'other' } });
    expect(await conn.listChildren(schema)).toMatchObject([{ kind: 'table', name: 'items' }, { kind: 'view', name: 'report' }]);
    expect(mock.pgQueries.at(-1)).toMatchObject({ database: 'other', params: ['public'] });
    await conn.close();
    expect(mock.pgClosed.sort()).toEqual(['demo', 'other']);
  });

  it('lists MySQL databases and binds the selected database when listing tables', async () => {
    const conn = mysqlDriver.connect({ ...base, driver: 'mysql' }, {});
    expect(await conn.listChildren(null)).toMatchObject([{ name: 'demo', detail: 'default' }, { name: 'other' }, { name: 'mysql', detail: 'system' }]);
    expect(await conn.listChildren({ kind: 'database', name: 'other', path: {}, hasChildren: true }))
      .toMatchObject([{ kind: 'table', name: 'items', path: { database: 'other' } }, { kind: 'view', name: 'report' }]);
    expect(mock.mysqlQueries.at(-1)?.params).toEqual(['other']);
    await conn.close();
    expect(mock.mysqlClosed).toBe(1);
  });
});
