import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabricksProfile } from '@earthql/core';

const mock = vi.hoisted(() => ({
  options: [] as object[],
  sessions: [] as object[],
  statements: [] as { sql: string; options: object }[],
  closedSessions: 0,
  closedClients: 0,
  closedOperations: 0,
  cancelled: 0,
  failOnce: false,
  more: false,
}));

vi.mock('@databricks/sql', () => {
  class DBSQLClient {
    config = {};
    on() {}
    async connect(options: object) { mock.options.push(options); return this; }
    async openSession(options: object) {
      mock.sessions.push(options);
      return {
        executeStatement: async (sql: string, opts: object) => {
          mock.statements.push({ sql, options: opts });
          if (mock.failOnce) { mock.failOnce = false; throw new Error('Invalid SessionHandle'); }
          const records = sql === 'SHOW CATALOGS' ? [{ catalog: 'system' }, { catalog: 'main' }]
            : sql.startsWith('SHOW SCHEMAS') ? [{ databaseName: 'public' }, { databaseName: 'information_schema' }]
              : sql.includes('information_schema.table_constraints') ? []
                : sql.includes('information_schema.tables') ? [{ table_name: 'items', table_type: 'BASE TABLE' }]
                  : sql.includes('full_data_type') ? [{ column_name: 'id', full_data_type: 'INT', is_nullable: 'NO', column_default: null }]
                    : sql.includes('information_schema.columns') ? [{ s: 'public', t: 'items', c: 'id' }]
                      : [{ value: '9007199254740993' }];
          return {
            fetchAll: async () => records,
            fetchChunk: async () => records,
            getSchema: async () => ({ columns: [{ columnName: 'value', typeDesc: { types: [{ primitiveEntry: { type: 4 } }] } }] }),
            hasMoreRows: async () => mock.more,
            close: async () => { mock.closedOperations++; },
            cancel: async () => { mock.cancelled++; },
          };
        },
        close: async () => { mock.closedSessions++; },
      };
    }
    async close() { mock.closedClients++; }
  }
  return { DBSQLClient };
});

import { databricksDriver } from '../src';

const profile: DatabricksProfile = {
  id: 'test', name: 'Test', driver: 'databricks', host: 'https://example.azuredatabricks.net/',
  httpPath: 'sql/warehouse', authMode: 'access-token', catalog: 'main', schema: 'public',
  env: { name: 'Test', color: '#888' }, createdAt: 0, updatedAt: 0,
};

beforeEach(() => {
  mock.options = []; mock.sessions = []; mock.statements = [];
  mock.closedSessions = 0; mock.closedClients = 0; mock.closedOperations = 0; mock.cancelled = 0; mock.failOnce = false; mock.more = false;
});

describe('Databricks driver', () => {
  it('tests a token connection and closes its session and client', async () => {
    const conn = databricksDriver.connect(profile, { accessToken: 'token' });
    expect(await conn.test()).toMatchObject({ ok: true });
    expect(mock.options[0]).toMatchObject({ host: 'example.azuredatabricks.net', path: '/sql/warehouse', authType: 'access-token', token: 'token' });
    expect(mock.closedSessions).toBe(1);
    expect(mock.closedClients).toBe(1);
    await conn.close();
  });

  it('validates OAuth credentials and selects the Azure OAuth mode', async () => {
    const oauth = { ...profile, authMode: 'oauth-m2m' as const, clientId: 'client', azureTenantId: 'tenant' };
    const invalid = databricksDriver.connect(oauth, {});
    expect(await invalid.test()).toMatchObject({ ok: false, error: { category: 'config' } });
    const conn = databricksDriver.connect(oauth, { clientSecret: 'secret' });
    expect((await conn.test()).ok).toBe(true);
    expect(mock.options.at(-1)).toMatchObject({ authType: 'databricks-oauth', oauthClientId: 'client', oauthClientSecret: 'secret', azureTenantId: 'tenant' });
    await conn.close();
  });

  it('lists catalog, schema, tables and autocomplete with the correct paths', async () => {
    const conn = databricksDriver.connect(profile, { accessToken: 'token' });
    expect((await conn.listChildren(null)).map((node) => node.name)).toEqual(['main', 'system']);
    const [schema] = await conn.listChildren({ kind: 'catalog', name: 'main', path: {}, hasChildren: true });
    expect(schema).toMatchObject({ name: 'public', path: { catalog: 'main' } });
    expect(await conn.listChildren(schema)).toMatchObject([{ kind: 'table', name: 'items', path: { catalog: 'main', schema: 'public', name: 'items' } }]);
    expect(await conn.completionSchema(conn.defaultContext())).toMatchObject({ namespaces: { public: { items: ['id'] } } });
    expect(await conn.getStructure({ catalog: 'main', schema: 'public', name: 'items' })).toMatchObject({
      columns: [{ name: 'id', type: 'INT', nullable: false }], columnsStatus: { state: 'ok' },
      indexesStatus: { state: 'unsupported' }, constraintsStatus: { state: 'empty' },
    });
    expect(mock.sessions).toHaveLength(1);
    await conn.close();
    expect(mock.closedSessions).toBe(1);
    expect(mock.closedClients).toBe(1);
  });

  it('routes parameters to the chosen context, retries an expired session and preserves BIGINT', async () => {
    const conn = databricksDriver.connect(profile, { accessToken: 'token' });
    mock.failOnce = true;
    const cursor = conn.openCursor({ sql: 'SELECT :p0 AS value', params: [{ value: '9007199254740993' }] }, { catalog: 'other', schema: 'sales' });
    expect(await cursor.fetch(10)).toMatchObject({ rows: [['9007199254740993']], done: true });
    expect(mock.sessions).toEqual([{ initialCatalog: 'other', initialSchema: 'sales' }, { initialCatalog: 'other', initialSchema: 'sales' }]);
    expect(mock.statements.at(-1)).toMatchObject({ options: { namedParameters: { p0: '9007199254740993' } } });
    expect(mock.closedOperations).toBe(1);
    await conn.close();
  });

  it('surfaces unsupported atomic grid edits rather than claiming success', async () => {
    const conn = databricksDriver.connect(profile, { accessToken: 'token' });
    expect(conn.capabilities().transactions).toBe(false);
    expect(conn.applyGridUpdates).toBeUndefined();
    expect(await conn.getPrivileges({ catalog: 'main', schema: 'public', name: 'items' })).toMatchObject({ select: 'unknown', insert: 'unknown' });
    await conn.close();
  });

  it('cancels a partially fetched operation and closes it', async () => {
    mock.more = true;
    const conn = databricksDriver.connect(profile, { accessToken: 'token' });
    const cursor = conn.openCursor({ sql: 'SELECT 1' }, {});
    expect(await cursor.fetch(1)).toMatchObject({ done: false });
    expect(await cursor.cancel()).toBe('requested');
    await cursor.close();
    expect(mock.cancelled).toBeGreaterThan(0);
    expect(mock.closedOperations).toBe(1);
    await conn.close();
  });
});
