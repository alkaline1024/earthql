// Opt in with EARTHQL_IT_DATABRICKS_HOST, _HTTP_PATH, _CATALOG, _SCHEMA and _TOKEN.
// The identity must be allowed to create and drop a disposable table in that schema.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ScriptRun, runBrowse, runGridSave, runWrite, type DatabricksProfile, type DriverConnection } from '@earthql/core';
import { databricksDriver } from '@earthql/driver-databricks';

const host = process.env.EARTHQL_IT_DATABRICKS_HOST;
const httpPath = process.env.EARTHQL_IT_DATABRICKS_HTTP_PATH;
const catalog = process.env.EARTHQL_IT_DATABRICKS_CATALOG;
const schema = process.env.EARTHQL_IT_DATABRICKS_SCHEMA;
const token = process.env.EARTHQL_IT_DATABRICKS_TOKEN;
const configured = !!(host && httpPath && catalog && schema && token);

describe.skipIf(!configured)('Databricks SQL warehouse', () => {
  const profile: DatabricksProfile = {
    id: 'it-databricks', name: 'Integration', driver: 'databricks', host: host!, httpPath: httpPath!,
    authMode: 'access-token', catalog: catalog!, schema: schema!,
    env: { name: 'Test', color: '#888' }, createdAt: 0, updatedAt: 0,
  };
  const object = { catalog: catalog!, schema: schema!, name: `earthql_it_${randomUUID().replaceAll('-', '')}` };
  let conn: DriverConnection;
  let created = false;

  beforeAll(() => { conn = databricksDriver.connect(profile, { accessToken: token }); });
  afterAll(async () => {
    if (created) {
      const cursor = conn.openCursor({ sql: `DROP TABLE ${conn.dialect.qualify(object)}` }, conn.defaultContext());
      try { await cursor.fetch(10); } finally { await cursor.close(); }
    }
    await conn.close();
  });

  it('connects and lists the configured catalog and schema', async () => {
    const result = await conn.test();
    expect(result.error).toBeUndefined();
    expect(result.ok).toBe(true);
    const catalogs = await conn.listChildren(null);
    const selected = catalogs.find((node) => node.name === catalog);
    expect(selected).toBeDefined();
    expect((await conn.listChildren(selected!)).some((node) => node.name === schema)).toBe(true);
  });

  it('reports invalid credentials without exposing the token', async () => {
    const invalid = 'earthql-invalid-integration-token';
    const bad = databricksDriver.connect(profile, { accessToken: invalid });
    try {
      const result = await bad.test();
      expect(result.ok).toBe(false);
      expect(result.error?.category).toBe('auth');
      expect(JSON.stringify(result)).not.toContain(invalid);
    } finally { await bad.close(); }
  });

  it('creates a table and reads its structure and tree entry', async () => {
    const stmt = conn.dialect.buildCreateTable({
      object, ifNotExists: false,
      columns: [
        { name: 'id', type: 'INT', nullable: false, primaryKey: false, default: { kind: 'none' } },
        { name: 'name', type: 'STRING', nullable: true, primaryKey: false, default: { kind: 'none' } },
        { name: 'amount', type: 'DECIMAL(38,10)', nullable: true, primaryKey: false, default: { kind: 'none' } },
      ],
    });
    expect(stmt.errors).toEqual([]);
    const result = await runWrite(conn, stmt, conn.defaultContext());
    expect(result.error).toBeUndefined();
    expect(result.status).toBe('ok');
    created = true;
    const structure = await conn.getStructure(object);
    expect(structure.columns.map((column) => column.name)).toEqual(['id', 'name', 'amount']);
    expect(structure.indexesStatus.state).toBe('unsupported');
    const tables = await conn.listChildren({ kind: 'schema', name: schema!, path: { catalog }, hasChildren: true });
    expect(tables.some((node) => node.name === object.name)).toBe(true);
  });

  it('inserts Unicode, NULL and precise decimals, then filters, sorts and pages', async () => {
    const structure = await conn.getStructure(object);
    const result = await runGridSave(conn, structure, { updates: [], inserts: [
      { id: { kind: 'value', value: '1' }, name: { kind: 'value', value: "สวัสดี O'Brien" }, amount: { kind: 'value', value: '12345678901234567890.1234567890' } },
      { id: { kind: 'value', value: '2' }, name: { kind: 'null' }, amount: { kind: 'null' } },
    ] });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe('ok');
    const request = { object, filters: [], sort: { column: 'id', dir: 'asc' as const }, offset: 0, pageSize: 1 };
    const first = await runBrowse(conn, request, structure.columns);
    expect(first.hasMore).toBe(true);
    expect(first.rows[0][1]).toBe("สวัสดี O'Brien");
    expect(String(first.rows[0][2])).toBe('12345678901234567890.1234567890');
    const second = await runBrowse(conn, { ...request, offset: 1 }, structure.columns);
    expect(second.rows[0][1]).toBeNull();
    const filtered = await runBrowse(conn, { ...request, filters: [{ column: 'name', op: 'contains', value: 'สวัสดี' }] }, structure.columns);
    expect(filtered.rows).toHaveLength(1);
  });

  it('runs SQL, reports syntax errors and finds columns for autocomplete', async () => {
    const out = await new ScriptRun(conn, 'SELECT 1 AS value; SELEC 1', conn.defaultContext(), { limit: 10 }).run();
    expect(out.results[0].status).toBe('ok');
    expect(out.results[1]).toMatchObject({ status: 'error', error: { category: 'syntax' } });
    const completion = await conn.completionSchema(conn.defaultContext());
    expect(completion.namespaces[schema!]?.[object.name]).toEqual(['id', 'name', 'amount']);
  });

  it('rejects atomic grid updates because Databricks does not provide them', async () => {
    const structure = await conn.getStructure(object);
    expect(conn.capabilities().transactions).toBe(false);
    expect(structure.gridUpdate).not.toBe(true);
    const result = await runGridSave(conn, structure, {
      updates: [{ key: [{ column: 'id', value: '1' }], changes: [{ column: 'name', original: "สวัสดี O'Brien", value: 'changed' }] }],
      inserts: [],
    });
    expect(result.status).toBe('error');
  });
});
