import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MssqlProfile } from '@earthql/core';

const mock = vi.hoisted(() => ({
  edition: 5,
  loginDatabase: 'master',
  failMaster: false,
  masterError: 4060,
  queries: [] as { database: string; text: string }[],
  closed: [] as string[],
  transactions: [] as string[],
}));

vi.mock('mssql', async () => {
  const { EventEmitter } = await import('node:events');
  class Request extends EventEmitter {
    stream = false;
    constructor(private database: string) { super(); }
    input() { return this; }
    query(text: string) {
      mock.queries.push({ database: this.database, text });
      if (this.stream) {
        queueMicrotask(() => { this.emit('recordset', [{ name: 'value', type: { name: 'Int' } }]); this.emit('row', [1]); this.emit('done'); });
        return;
      }
      if (text.includes('SERVERPROPERTY')) return Promise.resolve({ recordset: [{ edition: mock.edition, current_database: this.database }] });
      if (text.includes('sys.databases')) return Promise.resolve({ recordset: this.database === 'master'
        ? [{ name: 'master', sys: 1 }, { name: 'app', sys: 0 }]
        : [{ name: this.database, sys: 0 }] });
      if (text.includes('sys.schemas')) return Promise.resolve({ recordset: [{ name: 'dbo' }] });
      return Promise.resolve({ recordset: [], recordsets: [[{ earthql_affected_rows: 1 }]] });
    }
    async batch(text: string) { mock.queries.push({ database: this.database, text }); }
    pause() {}
    resume() {}
    cancel() {}
  }
  class ConnectionPool {
    database: string;
    constructor(config: { database?: string }) { this.database = config.database || mock.loginDatabase; }
    on() {}
    async connect() {
      if (mock.failMaster && this.database === 'master') throw Object.assign(new Error('Cannot open database master'), { number: mock.masterError });
      return this;
    }
    request() { return new Request(this.database); }
    async close() { mock.closed.push(this.database); }
  }
  class Transaction {
    constructor(private pool: ConnectionPool) { mock.transactions.push(pool.database); }
    async begin() {}
    async commit() {}
    async rollback() {}
    request() { return this.pool.request(); }
  }
  return { default: { ConnectionPool, Transaction, NVarChar: () => 'nvarchar', MAX: -1 } };
});

import { mssqlDriver } from '../src';

const profile: MssqlProfile = {
  id: 'test', name: 'Test', driver: 'mssql', host: 'localhost', port: 1433, database: 'master', user: 'user',
  tls: { mode: 'require' }, env: { name: 'Local', color: '#888' }, createdAt: 0, updatedAt: 0,
};

beforeEach(() => {
  mock.edition = 5;
  mock.loginDatabase = 'master';
  mock.failMaster = false;
  mock.masterError = 4060;
  mock.queries = [];
  mock.closed = [];
  mock.transactions = [];
});

describe('SQL Server database discovery and routing', () => {
  it('lists Azure databases from master without filtering by cross-database access', async () => {
    const conn = mssqlDriver.connect({ ...profile, database: 'app' }, {});
    expect((await conn.listChildren(null)).map((node) => node.name)).toEqual(['master', 'app']);
    const listing = mock.queries.find(({ text }) => text.includes('sys.databases'))!;
    expect(listing.database).toBe('master');
    expect(listing.text).not.toContain('HAS_DBACCESS');
    await conn.close();
    expect(mock.closed.sort()).toEqual(['app', 'master']);
  });

  it('shows a limited list when a contained login cannot access master', async () => {
    mock.failMaster = true;
    const conn = mssqlDriver.connect({ ...profile, database: 'app' }, {});
    expect(await conn.listChildren(null)).toMatchObject([{ name: 'app', detail: 'Database list limited: cannot connect to master' }]);
    await conn.close();
  });

  it('surfaces other failures when loading the Azure database list', async () => {
    mock.failMaster = true;
    mock.masterError = 1234;
    const conn = mssqlDriver.connect({ ...profile, database: 'app' }, {});
    await expect(conn.listChildren(null)).rejects.toMatchObject({ number: 1234 });
    await conn.close();
  });

  it.each([3, 8])('retains the access filter for SQL Server engine edition %s', async (edition) => {
    mock.edition = edition;
    const conn = mssqlDriver.connect(profile, {});
    await conn.listChildren(null);
    expect(mock.queries.find(({ text }) => text.includes('sys.databases'))?.text).toContain('HAS_DBACCESS');
    await conn.close();
  });

  it('opens the target database for metadata, parameterized queries, and transactions without USE', async () => {
    const conn = mssqlDriver.connect(profile, {});
    await conn.listChildren({ kind: 'database', name: 'app', path: {}, hasChildren: true });
    const cursor = conn.openCursor({ sql: 'SELECT @p0', params: [{ value: '1' }] }, { database: 'app' });
    expect((await cursor.fetch(1)).rows).toEqual([[1]]);
    await cursor.close();
    await conn.applyGridUpdates!({ database: 'app', name: 'items' }, [{ sql: 'UPDATE dbo.items SET id = @p0', params: [{ value: '1' }] }]);
    await conn.executeTableStatements!({ database: 'app', name: 'items' }, ['DELETE FROM dbo.items'], { disableForeignKeys: false });
    expect(mock.transactions).toEqual(['app', 'app']);
    expect(mock.queries.every(({ database, text }) => database === 'app' && !/\bUSE\b/i.test(text))).toBe(true);
    await conn.close();
  });
});
