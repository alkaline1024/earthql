import { describe, expect, it } from 'vitest';
import {
  PullBuffer,
  ScriptRun,
  isReadOnlyStatement,
  previewWithParams,
  redact,
  splitStatements,
  statementAt,
  toCsv,
  type CursorChunk,
  type DriverConnection,
  type QueryCursor,
} from '@earthql/core';
import { postgresDialect } from '@earthql/driver-postgres';
import { mysqlDialect } from '@earthql/driver-mysql';
import { mssqlDialect } from '@earthql/driver-mssql';
import { databricksDialect } from '@earthql/driver-databricks';

describe('splitStatements', () => {
  it('splits on semicolons outside quotes and comments', () => {
    const s = splitStatements(`select ';' as a; -- c;\nselect "x;y" from t /* ; */; `, 'postgres');
    expect(s.map((x) => x.sql)).toEqual([`select ';' as a`, `-- c;\nselect "x;y" from t /* ; */`]);
  });
  it('handles PostgreSQL dollar quotes', () => {
    const s = splitStatements(`create function f() returns int as $body$ select 1; $body$ language sql; select 2`, 'postgres');
    expect(s).toHaveLength(2);
    expect(s[0].sql).toContain('$body$ select 1; $body$');
  });
  it('handles MySQL backslash escapes and backticks', () => {
    const s = splitStatements("select 'it\\'s; ok', `a;b` from t; select 1", 'mysql');
    expect(s).toHaveLength(2);
  });
  it('splits SQL Server batches on GO lines and brackets', () => {
    const s = splitStatements('select [a;b] from t\nGO\nselect 2\ngo\n', 'mssql');
    expect(s.map((x) => x.sql)).toEqual(['select [a;b] from t', 'select 2']);
  });
  it('drops comment-only fragments', () => {
    expect(splitStatements('-- nothing\n;  /* x */ ;', 'postgres')).toHaveLength(0);
  });
  it('reports offsets of each statement', () => {
    const text = '  select 1;\n  select 2';
    const s = splitStatements(text, 'postgres');
    expect(text.slice(s[1].start, s[1].end)).toBe('select 2');
  });
});

describe('statementAt', () => {
  const text = 'select 1;\n\nselect 2;\n\nselect 3';
  const s = splitStatements(text, 'postgres');
  it('finds the statement the cursor sits inside', () => {
    expect(statementAt(s, text.indexOf('2'))).toBe(s[1]);
    expect(statementAt(s, s[0].start)).toBe(s[0]);
    expect(statementAt(s, s[0].end)).toBe(s[0]);
  });
  it('falls forward to the next statement when the cursor is in a gap between statements', () => {
    expect(statementAt(s, s[0].end + 1)).toBe(s[1]);
  });
  it('falls back to the last statement when the cursor is past everything', () => {
    expect(statementAt(s, text.length + 10)).toBe(s[2]);
  });
  it('returns undefined for an empty statement list', () => {
    expect(statementAt([], 0)).toBeUndefined();
  });
});

describe('isReadOnlyStatement', () => {
  it('detects reads and writes', () => {
    expect(isReadOnlyStatement('SELECT * FROM t', 'postgres')).toBe(true);
    expect(isReadOnlyStatement('with x as (select 1) select * from x', 'postgres')).toBe(true);
    expect(isReadOnlyStatement('WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d', 'postgres')).toBe(false);
    expect(isReadOnlyStatement('insert into t values (1)', 'mysql')).toBe(false);
    expect(isReadOnlyStatement("select * into t2 from t", 'mssql')).toBe(false);
    expect(isReadOnlyStatement("select 'into' from t", 'mssql')).toBe(true);
  });
});

describe('redact', () => {
  it('removes secrets and token shapes', () => {
    const out = redact('login failed for pw S3cr3t! token dapi0123456789abcdef0123456789 Bearer abcdefghijkl', ['S3cr3t!']);
    expect(out).not.toContain('S3cr3t!');
    expect(out).not.toContain('dapi0123456789abcdef');
    expect(out).not.toContain('abcdefghijkl');
  });
});

describe('csv', () => {
  it('keeps NULL distinct from empty string and quotes specials', () => {
    const csv = toCsv(
      [
        { name: 'a', type: 'text', kind: 'text' },
        { name: 'b', type: 'text', kind: 'text' },
      ],
      [
        [null, ''],
        ['x,y', 'say "hi"'],
        ['ไทย', '12345678901234567890.123'],
      ],
    );
    expect(csv).toBe('a,b\r\n,""\r\n"x,y","say ""hi"""\r\nไทย,12345678901234567890.123\r\n');
  });
});

describe('dialect quoting and browse', () => {
  const req = {
    object: { database: 'db', schema: 'sales', catalog: 'main', name: 'or"ders' },
    filters: [
      { column: 'name', op: 'contains' as const, value: '50%_off' },
      { column: 'id', op: '>=' as const, value: '10' },
      { column: 'note', op: 'is_null' as const },
    ],
    sort: { column: 'id', dir: 'desc' as const },
    offset: 100,
    pageSize: 50,
  };
  it('postgres', () => {
    const b = postgresDialect.buildBrowse(req);
    expect(b.sql).toBe(
      `SELECT * FROM "sales"."or""ders" WHERE CAST("name" AS TEXT) ILIKE $1 ESCAPE '\\' AND "id" >= $2 AND "note" IS NULL ORDER BY "id" DESC LIMIT 51 OFFSET 100`,
    );
    expect(b.params).toEqual([{ value: '%50\\%\\_off%' }, { value: '10' }]);
  });
  it('mysql', () => {
    const b = mysqlDialect.buildBrowse(req);
    expect(b.sql).toBe('SELECT * FROM `db`.`or"ders` WHERE CAST(`name` AS CHAR) LIKE ? AND `id` >= ? AND `note` IS NULL ORDER BY `id` DESC LIMIT 51 OFFSET 100');
  });
  it('mssql paginates with OFFSET/FETCH and converts decimals', () => {
    const b = mssqlDialect.buildBrowse({ ...req, sort: undefined }, [
      { name: 'id', type: 'int' },
      { name: 'amount', type: 'decimal(38,10)' },
      { name: 'name', type: 'nvarchar(50)' },
      { name: 'note', type: 'nvarchar(max)' },
    ]);
    expect(b.sql).toContain('FROM [db].[sales].[or"ders]');
    expect(b.sql).toContain('CONVERT(VARCHAR(64), [amount]) AS [amount]');
    expect(b.sql).toMatch(/ORDER BY \(SELECT NULL\) OFFSET 100 ROWS FETCH NEXT 51 ROWS ONLY$/);
    expect(b.params[0].value).toBe('%50\\%\\_off%');
    const all = mssqlDialect.buildBrowseAll({ object: req.object, filters: [] });
    expect(all.sql).not.toMatch(/OFFSET/);
  });
  it('databricks uses catalog.schema.table and named params', () => {
    const b = databricksDialect.buildBrowse(req);
    expect(b.sql).toBe('SELECT * FROM `main`.`sales`.`or"ders` WHERE CAST(`name` AS STRING) ILIKE :p0 AND `id` >= :p1 AND `note` IS NULL ORDER BY `id` DESC LIMIT 51 OFFSET 100');
  });
  it('rejects unknown columns when structure is known', () => {
    const b = postgresDialect.buildBrowse({ ...req, filters: [{ column: 'nope', op: '=', value: '1' }] }, [{ name: 'id', type: 'int' }]);
    expect(b.errors.length).toBeGreaterThan(0);
  });
});

describe('insert builder', () => {
  const spec = {
    object: { schema: 'public', name: 't', catalog: 'main', database: 'db' },
    columns: [
      { name: 'id', type: 'integer', kind: 'number' as const },
      { name: 'name', type: 'text', kind: 'text' as const },
      { name: 'amount', type: 'DECIMAL(38,10)', kind: 'number' as const },
    ],
    rows: [
      { id: { kind: 'default' as const }, name: { kind: 'value' as const, value: 'สวัสดี' }, amount: { kind: 'null' as const } },
      { id: { kind: 'default' as const }, name: { kind: 'value' as const, value: '' }, amount: { kind: 'value' as const, value: '12345678901234567890.0123456789' } },
    ],
  };
  it('binds values, writes NULL and DEFAULT keywords', () => {
    const b = postgresDialect.buildInsert(spec);
    expect(b.sql).toBe('INSERT INTO "public"."t" ("name", "amount")\nVALUES\n  ($1, NULL),\n  ($2, $3)');
    expect(b.params.map((p) => p.value)).toEqual(['สวัสดี', '', '12345678901234567890.0123456789']);
    expect(b.errors).toEqual([]);
  });
  it('databricks casts non-string params', () => {
    const b = databricksDialect.buildInsert({ ...spec, columns: spec.columns.map((c) => (c.name === 'name' ? { ...c, type: 'STRING' } : c)) });
    expect(b.sql).toContain('(:p0, NULL)');
    expect(b.sql).toContain('(:p1, CAST(:p2 AS DECIMAL(38,10)))');
  });
  it('all-default rows list every column with DEFAULT', () => {
    const b = mssqlDialect.buildInsert({ ...spec, rows: [{}] });
    expect(b.sql).toBe('INSERT INTO [db].[public].[t] ([id], [name], [amount])\nVALUES\n  (DEFAULT, DEFAULT, DEFAULT)');
  });
  it('preview inlines params for display', () => {
    const b = mysqlDialect.buildInsert(spec);
    expect(previewWithParams(b, mysqlDialect)).toContain("('สวัสดี', NULL)");
  });
});

describe('create table builder', () => {
  const base = {
    object: { schema: 'public', name: 'people', catalog: 'main', database: 'db' },
    ifNotExists: true,
    columns: [
      { name: 'id', type: 'BIGINT', nullable: true, default: { kind: 'none' as const }, primaryKey: true },
      { name: 'name', type: 'VARCHAR(100)', nullable: false, default: { kind: 'literal' as const, value: "O'Brien" }, primaryKey: false },
      { name: 'score', type: 'DECIMAL(38,10)', nullable: true, default: { kind: 'literal' as const, value: '1.5' }, primaryKey: false },
      { name: 'active', type: 'BOOLEAN', nullable: true, default: { kind: 'literal' as const, value: 'true' }, primaryKey: false },
    ],
  };
  it('postgres', () => {
    const b = postgresDialect.buildCreateTable(base);
    expect(b.sql).toBe(
      `CREATE TABLE IF NOT EXISTS "public"."people" (\n  "id" BIGINT NOT NULL,\n  "name" VARCHAR(100) NOT NULL DEFAULT 'O''Brien',\n  "score" DECIMAL(38,10) DEFAULT 1.5,\n  "active" BOOLEAN DEFAULT TRUE,\n  PRIMARY KEY ("id")\n)`,
    );
    expect(b.errors).toEqual([]);
  });
  it('mssql uses OBJECT_ID guard and BIT literals', () => {
    const b = mssqlDialect.buildCreateTable({ ...base, columns: [...base.columns.slice(0, 3), { ...base.columns[3], type: 'BIT' }] });
    expect(b.sql.startsWith(`IF OBJECT_ID(N'[db].[public].[people]', N'U') IS NULL\nCREATE TABLE [db].[public].[people]`)).toBe(true);
    expect(b.sql).toContain("[name] VARCHAR(100) NOT NULL DEFAULT N'O''Brien'");
    expect(b.sql).toContain('[active] BIT DEFAULT 1');
  });
  it('databricks adds the column defaults table feature and named PK', () => {
    const b = databricksDialect.buildCreateTable(base);
    expect(b.sql).toContain("TBLPROPERTIES ('delta.feature.allowColumnDefaults' = 'supported')");
    expect(b.sql).toContain('CONSTRAINT `pk_people` PRIMARY KEY (`id`)');
    expect(b.sql).toContain("`name` VARCHAR(100) NOT NULL DEFAULT 'O\\'Brien'");
  });
  it('mysql parenthesises defaults on TEXT and expressions', () => {
    const b = mysqlDialect.buildCreateTable({
      ...base,
      columns: [
        { name: 'body', type: 'TEXT', nullable: true, default: { kind: 'literal', value: 'x' }, primaryKey: false },
        { name: 'uid', type: 'VARCHAR(36)', nullable: true, default: { kind: 'expression', value: 'UUID()' }, primaryKey: false },
        { name: 'at', type: 'DATETIME(3)', nullable: true, default: { kind: 'expression', value: 'CURRENT_TIMESTAMP(3)' }, primaryKey: false },
      ],
    });
    expect(b.sql).toContain("`body` TEXT DEFAULT ('x')");
    expect(b.sql).toContain('`uid` VARCHAR(36) DEFAULT (UUID())');
    expect(b.sql).toContain('`at` DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3)');
  });
  it('validates names, duplicates and types', () => {
    const b = postgresDialect.buildCreateTable({
      ...base,
      object: { ...base.object, name: '' },
      columns: [
        { name: 'a', type: 'int; drop table x', nullable: true, default: { kind: 'none' }, primaryKey: false },
        { name: 'A', type: 'int', nullable: true, default: { kind: 'none' }, primaryKey: false },
      ],
    });
    expect(b.errors.join('\n')).toMatch(/table name/);
    expect(b.errors.join('\n')).toMatch(/not a valid type/);
    expect(b.errors.join('\n')).toMatch(/duplicate/);
  });
});

describe('PullBuffer', () => {
  it('applies back-pressure and delivers rows in batches', async () => {
    let paused = 0;
    let resumed = 0;
    const b = new PullBuffer({ pause: () => paused++, resume: () => resumed++ }, 3);
    b.setColumns([{ name: 'a', type: 'int', kind: 'number' }]);
    for (let i = 0; i < 5; i++) b.push([i]);
    expect(paused).toBe(1);
    const c1 = await b.take(2);
    expect(c1.rows).toEqual([[0], [1]]);
    expect(c1.done).toBe(false);
    b.end();
    const c2 = await b.take(10);
    expect(c2.rows).toEqual([[2], [3], [4]]);
    expect(c2.done).toBe(true);
  });
});

describe('ScriptRun', () => {
  function fakeConn(behaviour: (sql: string) => { chunk?: CursorChunk; error?: any; hang?: boolean }): DriverConnection {
    return {
      driver: 'postgres',
      dialect: postgresDialect,
      classifyError: (e: any) => ({ category: e.category ?? 'unknown', message: e.message }),
      openCursor: ({ sql }: { sql: string }) => {
        let reject: (e: any) => void = () => undefined;
        const cursor: QueryCursor = {
          fetch: () =>
            new Promise((res, rej) => {
              const b = behaviour(sql);
              reject = rej;
              if (b.hang) return;
              if (b.error) rej(b.error);
              else res(b.chunk!);
            }),
          cancel: async () => {
            setTimeout(() => reject({ category: 'cancelled', message: 'canceling statement due to user request' }), 5);
            return 'requested';
          },
          close: async () => undefined,
        };
        return cursor;
      },
    } as unknown as DriverConnection;
  }

  it('runs statements in order and keeps the last cursor open when limited', async () => {
    const conn = fakeConn((sql) => ({
      chunk: sql.startsWith('select')
        ? { columns: [{ name: 'x', type: 'int', kind: 'number' }], rows: [[1], [2]], done: false }
        : { columns: null, rows: [], done: true, rowsAffected: 3 },
    }));
    const out = await new ScriptRun(conn, 'update t set a=1; select x from t', {}, { limit: 2 }).run();
    expect(out.results.map((r) => r.status)).toEqual(['ok', 'ok']);
    expect(out.results[0].rowsAffected).toBe(3);
    expect(out.results[1].hasMore).toBe(true);
    expect(out.results[1].limit).toBe(2);
    expect(out.open?.statementIndex).toBe(1);
  });

  it('stops after an error and marks a lost write as outcome unknown', async () => {
    const conn = fakeConn(() => ({ error: { category: 'network', message: 'Connection terminated' } }));
    const out = await new ScriptRun(conn, 'insert into t values (1); select 1', {}, { limit: 10 }).run();
    expect(out.results[0].status).toBe('outcome_unknown');
    expect(out.results[0].error?.category).toBe('outcome_unknown');
    expect(out.results[1].status).toBe('skipped');
  });

  it('confirms cancellation from the database error and skips the rest', async () => {
    const conn = fakeConn(() => ({ hang: true }));
    const run = new ScriptRun(conn, 'select pg_sleep(100); select 1', {}, { limit: 10 });
    const p = run.run();
    await new Promise((r) => setTimeout(r, 5));
    expect(await run.cancel()).toBe('requested');
    const out = await p;
    expect(out.cancel).toBe('confirmed');
    expect(out.results.map((r) => r.status)).toEqual(['cancelled', 'skipped']);
  });
});
