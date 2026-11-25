// Integration tests against real databases. Each driver runs only when its environment variables are set:
//   EARTHQL_IT_PG="host:port:user:password:database"
//   EARTHQL_IT_MYSQL="host:port:user:password:database"
//   EARTHQL_IT_MSSQL="host:port:user:password:database"
// Optional read-only accounts (created by the setup in this file when EARTHQL_IT_SETUP_RO=1):
//   user "eq_ro" / password "Eq-ro-pw1!"
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ScriptRun,
  runBrowse,
  runGridUpdates,
  runWrite,
  type ConnectionProfile,
  type DriverConnection,
  type DriverModule,
  type GridRowUpdate,
  type Secrets,
} from '@earthql/core';
import { postgresDriver } from '@earthql/driver-postgres';
import { mysqlDriver } from '@earthql/driver-mysql';
import { mssqlDriver } from '@earthql/driver-mssql';

interface Target {
  name: string;
  env: string;
  driver: DriverModule;
  profile: (host: string, port: number, user: string, db: string) => ConnectionProfile;
  sleepSql: string;
  intType: string;
  textType: string;
  tsType: string;
  tsDefault: string;
  schema?: string;
  setupRo: string[];
}

const base = { id: 'it', name: 'it', env: { name: 'Test', color: '#888' }, createdAt: 0, updatedAt: 0 };

const TARGETS: Target[] = [
  {
    name: 'PostgreSQL',
    env: 'EARTHQL_IT_PG',
    driver: postgresDriver,
    profile: (host, port, user, database) => ({ ...base, driver: 'postgres', host, port, user, database, tls: { mode: 'disable' } }),
    sleepSql: 'SELECT pg_sleep(30)',
    intType: 'integer',
    textType: 'varchar(100)',
    tsType: 'timestamp',
    tsDefault: 'CURRENT_TIMESTAMP',
    schema: 'public',
    setupRo: [
      `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'eq_ro') THEN CREATE ROLE eq_ro LOGIN PASSWORD 'Eq-ro-pw1!'; END IF; END $$`,
      'GRANT USAGE ON SCHEMA public TO eq_ro',
      'GRANT SELECT ON ALL TABLES IN SCHEMA public TO eq_ro',
    ],
  },
  {
    name: 'MySQL',
    env: 'EARTHQL_IT_MYSQL',
    driver: mysqlDriver,
    profile: (host, port, user, database) => ({ ...base, driver: 'mysql', host, port, user, database, tls: { mode: 'disable' } }),
    // SLEEP() and BENCHMARK() return normally when killed; a long scan fails with ER_QUERY_INTERRUPTED like a real query.
    sleepSql: 'SELECT COUNT(*) FROM information_schema.columns a, information_schema.columns b, information_schema.columns c',
    intType: 'INT',
    textType: 'VARCHAR(100)',
    tsType: 'DATETIME(3)',
    tsDefault: 'CURRENT_TIMESTAMP(3)',
    setupRo: ["CREATE USER IF NOT EXISTS 'eq_ro'@'%' IDENTIFIED BY 'Eq-ro-pw1!'", "GRANT SELECT ON earthql.* TO 'eq_ro'@'%'"],
  },
  {
    name: 'SQL Server',
    env: 'EARTHQL_IT_MSSQL',
    driver: mssqlDriver,
    profile: (host, port, user, database) => ({ ...base, driver: 'mssql', host, port, user, database, tls: { mode: 'require' } }),
    sleepSql: "WAITFOR DELAY '00:00:30'",
    intType: 'INT',
    textType: 'NVARCHAR(100)',
    tsType: 'DATETIME2(3)',
    tsDefault: 'SYSUTCDATETIME()',
    schema: 'dbo',
    setupRo: [
      "IF SUSER_ID('eq_ro') IS NULL CREATE LOGIN eq_ro WITH PASSWORD = 'Eq-ro-pw1!', CHECK_POLICY = OFF",
      "IF USER_ID('eq_ro') IS NULL CREATE USER eq_ro FOR LOGIN eq_ro",
      "ALTER ROLE db_datareader ADD MEMBER eq_ro",
    ],
  },
];

async function exec(conn: DriverConnection, sql: string, ctx = conn.defaultContext()) {
  const c = conn.openCursor({ sql }, ctx);
  try {
    return await c.fetch(100000);
  } finally {
    await c.close();
  }
}

for (const t of TARGETS) {
  const spec = process.env[t.env];
  describe.skipIf(!spec)(t.name, () => {
    const [host, portS, user, password, database] = (spec ?? '::::').split(':');
    const port = Number(portS);
    const profile = t.profile(host, port, user, database);
    const secrets: Secrets = { password };
    let conn: DriverConnection;
    const table = `eq_it_${Date.now().toString(36)}`;
    const object = { database, schema: t.schema, name: table };

    beforeAll(async () => {
      conn = t.driver.connect(profile, secrets);
      // MSSQL: make sure the test database exists.
      if (t.driver.id === 'mssql') {
        const master = t.driver.connect({ ...profile, database: 'master' } as ConnectionProfile, secrets);
        await exec(master, `IF DB_ID('${database}') IS NULL CREATE DATABASE [${database}]`);
        await master.close();
      }
    });

    afterAll(async () => {
      await exec(conn, `DROP TABLE ${conn.dialect.qualify(object)}`).catch(() => undefined);
      await conn?.close();
    });

    it('Test Connection opens a session and runs SELECT 1', async () => {
      const r = await conn.test();
      expect(r.error).toBeUndefined();
      expect(r.ok).toBe(true);
      expect(r.steps.some((s) => /SELECT 1/.test(s.name) && s.ok)).toBe(true);
    });

    it('a wrong password is an auth error that does not reveal the password', async () => {
      const wrong = 'Wr0ng-Secret-xyz';
      const bad = t.driver.connect(profile, { password: wrong });
      const r = await bad.test();
      await bad.close();
      expect(r.ok).toBe(false);
      expect(r.error?.category).toBe('auth');
      expect(JSON.stringify(r)).not.toContain(wrong);
    });

    it('an unreachable host is a network error', async () => {
      const bad = t.driver.connect({ ...profile, host: '127.0.0.1', port: 1 } as ConnectionProfile, secrets);
      const r = await bad.test();
      await bad.close();
      expect(r.error?.category).toBe('network');
    });

    it('creates a table from a form spec and reads its structure back', async () => {
      const stmt = conn.dialect.buildCreateTable({
        object,
        ifNotExists: false,
        columns: [
          { name: 'id', type: t.intType, nullable: false, primaryKey: true, default: { kind: 'none' } },
          { name: 'name', type: t.textType, nullable: false, primaryKey: false, default: { kind: 'literal', value: "คุณ O'Brien" } },
          { name: 'amount', type: 'DECIMAL(38,10)', nullable: true, primaryKey: false, default: { kind: 'literal', value: '1.5' } },
          { name: 'note', type: t.textType, nullable: true, primaryKey: false, default: { kind: 'none' } },
          { name: 'created', type: t.tsType, nullable: true, primaryKey: false, default: { kind: 'expression', value: t.tsDefault } },
        ],
      });
      expect(stmt.errors).toEqual([]);
      const w = await runWrite(conn, stmt, conn.defaultContext());
      expect(w.error).toBeUndefined();
      expect(w.status).toBe('ok');

      const s = await conn.getStructure(object);
      expect(s.columnsStatus.state).toBe('ok');
      expect(s.columns.map((c) => c.name)).toEqual(['id', 'name', 'amount', 'note', 'created']);
      const byName = Object.fromEntries(s.columns.map((c) => [c.name, c]));
      expect(byName.id.isPrimaryKey).toBe(true);
      expect(byName.id.nullable).toBe(false);
      expect(byName.amount.type.toLowerCase()).toMatch(/(decimal|numeric)\(38,\s?10\)/);
      expect(byName.name.defaultValue).toContain('คุณ');
      expect(byName.amount.defaultValue).toContain('1.5');
      expect(byName.created.defaultValue?.toLowerCase()).toMatch(/current_timestamp|now|sysutcdatetime/);

      const pk = s.constraints.find((c) => /PRIMARY KEY/.test(c.type));
      expect(pk?.columns).toEqual(['id']);
      for (const c of s.constraints) expect(Array.isArray(c.columns)).toBe(true);
      for (const i of s.indexes) expect(Array.isArray(i.columns)).toBe(true);

      const tree = await conn.listChildren(null);
      expect(tree.some((n) => n.name === database)).toBe(true);
    });

    it('inserts typed values, NULL and DEFAULT and reads them back exactly', async () => {
      const s = await conn.getStructure(object);
      const columns = s.columns.map((c) => ({ name: c.name, type: c.type, kind: c.kind }));
      const stmt = conn.dialect.buildInsert({
        object,
        columns,
        rows: [
          { id: { kind: 'value', value: '1' }, name: { kind: 'value', value: 'สวัสดี 👋' }, amount: { kind: 'value', value: '1234567890123456789012345678.0123456789' }, note: { kind: 'null' }, created: { kind: 'default' } },
          { id: { kind: 'value', value: '2' }, name: { kind: 'default' }, amount: { kind: 'default' }, note: { kind: 'value', value: '' }, created: { kind: 'default' } },
          { id: { kind: 'value', value: '3' }, name: { kind: 'value', value: 'zeta' }, amount: { kind: 'null' }, note: { kind: 'value', value: 'x' }, created: { kind: 'null' } },
        ],
      });
      expect(stmt.errors).toEqual([]);
      const w = await runWrite(conn, stmt, conn.defaultContext());
      expect(w.error?.message).toBeUndefined();
      expect(w.rowsAffected).toBe(3);

      const r = await runBrowse(conn, { object, filters: [], sort: { column: 'id', dir: 'asc' }, offset: 0, pageSize: 10 }, s.columns);
      const idx = (n: string) => r.columns.findIndex((c) => c.name === n);
      expect(r.rows.length).toBe(3);
      const [r1, r2, r3] = r.rows;
      expect(r1[idx('name')]).toBe('สวัสดี 👋');
      expect(r1[idx('amount')]).toBe('1234567890123456789012345678.0123456789');
      expect(r1[idx('note')]).toBeNull();
      expect(r1[idx('created')]).not.toBeNull();
      expect(r2[idx('name')]).toBe("คุณ O'Brien");
      expect(String(r2[idx('amount')])).toMatch(/^1\.50*$/);
      expect(r2[idx('note')]).toBe('');
      expect(r3[idx('created')]).toBeNull();
      expect(r.hasMore).toBe(false);
    });

    it('filters, sorts and pages in the database', async () => {
      const s = await conn.getStructure(object);
      const p1 = await runBrowse(conn, { object, filters: [], sort: { column: 'id', dir: 'desc' }, offset: 0, pageSize: 2 }, s.columns);
      expect(p1.rows.map((r) => Number(r[0]))).toEqual([3, 2]);
      expect(p1.hasMore).toBe(true);
      const p2 = await runBrowse(conn, { object, filters: [], sort: { column: 'id', dir: 'desc' }, offset: 2, pageSize: 2 }, s.columns);
      expect(p2.rows.map((r) => Number(r[0]))).toEqual([1]);
      expect(p2.hasMore).toBe(false);
      const f = await runBrowse(conn, { object, filters: [{ column: 'name', op: 'contains', value: 'สวัส' }], offset: 0, pageSize: 10 }, s.columns);
      expect(f.rows.length).toBe(1);
      const n = await runBrowse(conn, { object, filters: [{ column: 'note', op: 'is_null' }], offset: 0, pageSize: 10 }, s.columns);
      expect(n.rows.map((r) => Number(r[0]))).toEqual([1]);
      const pct = await runBrowse(conn, { object, filters: [{ column: 'name', op: 'contains', value: '%' }], offset: 0, pageSize: 10 }, s.columns);
      expect(pct.rows.length).toBe(0);
    });

    it('keeps duplicate column names in order and preserves BIGINT', async () => {
      const big = t.driver.id === 'mysql' ? 'CAST(9007199254740993 AS SIGNED)' : 'CAST(9007199254740993 AS BIGINT)';
      const r = await exec(conn, `SELECT 1 AS a, 2 AS a, ${big} AS big`);
      expect(r.columns?.map((c) => c.name)).toEqual(['a', 'a', 'big']);
      expect(r.rows[0].slice(0, 2).map(Number)).toEqual([1, 2]);
      expect(String(r.rows[0][2])).toBe('9007199254740993');
    });

    it('saves keyed grid edits atomically and rejects stale cells', async () => {
      const editObject = { ...object, name: `${table}_edit` };
      const qualified = conn.dialect.qualify(editObject);
      const row = (id: string, original: string | null, value: string | null): GridRowUpdate => ({
        key: [{ column: 'tenant_id', value: '1' }, { column: 'id', value: id }],
        changes: [{ column: 'note', original, value }],
      });
      const firstId = '9007199254740992';
      const secondId = '9007199254740993';
      const read = async () => (await exec(conn, `SELECT note FROM ${qualified} ORDER BY tenant_id, id`)).rows.flat();
      await exec(conn, `CREATE TABLE ${qualified} (tenant_id INT NOT NULL, id BIGINT NOT NULL, note ${t.textType} NULL, PRIMARY KEY (tenant_id, id))`);
      try {
        await exec(conn, `INSERT INTO ${qualified} VALUES (1, ${firstId}, 'First'), (1, ${secondId}, NULL), (2, ${secondId}, 'Other tenant')`);
        const structure = await conn.getStructure(editObject);
        expect(structure.gridUpdate).toBe(true);
        const text = "O'Brien ☀";
        expect(await runGridUpdates(conn, structure, [row(secondId, null, text)])).toMatchObject({ status: 'ok', rowsAffected: 1 });
        expect(await read()).toEqual(['First', text, 'Other tenant']);

        await exec(conn, `UPDATE ${qualified} SET note = 'Changed' WHERE tenant_id = 1 AND id = ${secondId}`);
        const conflict = await runGridUpdates(conn, structure, [row(firstId, 'First', 'staged'), row(secondId, text, 'stale')]);
        expect(conflict).toMatchObject({ status: 'error', error: { code: 'GRID_CONFLICT' } });
        expect(await read()).toEqual(['First', 'Changed', 'Other tenant']);

        expect(await runGridUpdates(conn, structure, [row(firstId, 'First', ''), row(secondId, 'Changed', null)]))
          .toMatchObject({ status: 'ok', rowsAffected: 2 });
        expect(await read()).toEqual(['', null, 'Other tenant']);
      } finally {
        await exec(conn, `DROP TABLE ${qualified}`);
      }
    });

    it('returns high-precision DECIMAL values exactly from ad-hoc SQL', async () => {
      const r = await exec(conn, 'SELECT CAST(12345678901234567890.123 AS DECIMAL(38,3)) AS d, CAST(-0.0000000001 AS DECIMAL(38,10)) AS e');
      expect(String(r.rows[0][0])).toBe('12345678901234567890.123');
      expect(String(r.rows[0][1])).toBe('-0.0000000001');
    });

    it('limits large results and keeps the cursor open for more', async () => {
      const gen =
        t.driver.id === 'postgres'
          ? 'SELECT g AS n FROM generate_series(1, 5000) g'
          : t.driver.id === 'mysql'
            ? 'SELECT a.d + 10 * b.d + 100 * c.d + 1000 * e.d + 1 AS n FROM (SELECT 0 d UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) a, (SELECT 0 d UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) b, (SELECT 0 d UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) c, (SELECT 0 d UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) e WHERE e.d < 5'
            : 'SELECT TOP 5000 ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS n FROM sys.all_objects a CROSS JOIN sys.all_objects b';
      const out = await new ScriptRun(conn, gen, conn.defaultContext(), { limit: 100 }).run();
      expect(out.results[0].rows?.length).toBe(100);
      expect(out.results[0].hasMore).toBe(true);
      const more = await out.open!.cursor.fetch(10000);
      expect(more.rows.length).toBe(4900);
      expect(more.done).toBe(true);
      await out.open!.cursor.close();
    });

    it('reports SQL errors as syntax errors', async () => {
      const out = await new ScriptRun(conn, 'SELEC 1', conn.defaultContext(), { limit: 10 }).run();
      expect(out.results[0].status).toBe('error');
      expect(out.results[0].error?.category).toBe('syntax');
    });

    it('cancels a long statement with confirmation and can run the next one', async () => {
      const run = new ScriptRun(conn, t.sleepSql, conn.defaultContext(), { limit: 10 });
      const p = run.run();
      await new Promise((r) => setTimeout(r, 1500));
      expect(await run.cancel()).toBe('requested');
      const started = Date.now();
      const out = await p;
      expect(Date.now() - started).toBeLessThan(10000);
      expect(out.results[0].status).toBe('cancelled');
      expect(out.cancel).toBe('confirmed');
      const next = await new ScriptRun(conn, 'SELECT 1 AS ok', conn.defaultContext(), { limit: 10 }).run();
      expect(next.results[0].status).toBe('ok');
    });

    it('autocomplete schema includes the new table and its columns', async () => {
      const c = await conn.completionSchema(conn.defaultContext());
      const ns = Object.values(c.namespaces).find((n) => n[table]);
      expect(ns?.[table]).toEqual(['id', 'name', 'amount', 'note', 'created']);
    });

    describe.skipIf(!process.env.EARTHQL_IT_SETUP_RO)('read-only account', () => {
      let ro: DriverConnection;
      beforeAll(async () => {
        for (const sql of t.setupRo) await exec(conn, sql);
        ro = t.driver.connect(t.profile(host, port, 'eq_ro', database), { password: 'Eq-ro-pw1!' });
      });
      afterAll(async () => ro?.close());

      it('can read data', async () => {
        const r = await runBrowse(ro, { object, filters: [], offset: 0, pageSize: 10 }, undefined);
        expect(r.rows.length).toBe(3);
      });

      it('write attempts are rejected by the database with a permission error', async () => {
        const s = await ro.getStructure(object);
        const stmt = ro.dialect.buildInsert({
          object,
          columns: s.columns.map((c) => ({ name: c.name, type: c.type, kind: c.kind })),
          rows: [{ id: { kind: 'value', value: '99' }, name: { kind: 'value', value: 'ro' } }],
        });
        const w = await runWrite(ro, stmt, ro.defaultContext());
        expect(w.status).toBe('error');
        expect(w.error?.category).toBe('permission');
        const priv = await ro.getPrivileges(object);
        expect(priv.select).toBe('yes');
        expect(['no', 'unknown']).toContain(priv.insert);
      });
    });
  });
}
