import { describe, expect, it } from 'vitest';
import {
  PullBuffer,
  checkRawCondition,
  ScriptRun,
  isReadOnlyStatement,
  previewWithParams,
  redact,
  buildGridDeletes,
  splitStatements,
  statementAt,
  toCsv,
  toHtmlTable,
  toJsonRows,
  toMarkdownTable,
  toTsv,
  type CursorChunk,
  type TableStructure,
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

describe('grid-copy serializers', () => {
  const columns = [
    { name: 'id', type: 'int', kind: 'number' as const },
    { name: 'name', type: 'text', kind: 'text' as const },
  ];
  const rows = [
    [1, 'a|b'],
    [null, 'line1\nline2'],
  ];

  it('toTsv joins columns with tabs and rows with newlines, NULL as text', () => {
    expect(toTsv(columns, rows)).toBe('1\ta|b\nNULL\tline1\nline2');
  });

  it('toJsonRows produces one object per row keyed by column name', () => {
    expect(JSON.parse(toJsonRows(columns, rows))).toEqual([
      { id: 1, name: 'a|b' },
      { id: null, name: 'line1\nline2' },
    ]);
  });

  it('toHtmlTable escapes HTML-significant characters', () => {
    const html = toHtmlTable([{ name: '<col>', type: 'text', kind: 'text' as const }], [['<b>&"\'']]);
    expect(html).toContain('&lt;col&gt;');
    expect(html).toContain('&lt;b&gt;&amp;&quot;&#39;');
  });

  it('toMarkdownTable escapes pipes and newlines', () => {
    const md = toMarkdownTable(columns, rows);
    expect(md.split('\n')[0]).toBe('| id | name |');
    expect(md.split('\n')[1]).toBe('| --- | --- |');
    expect(md).toContain('a\\|b');
    expect(md).toContain('line1<br>line2');
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

describe('quick-filter operators', () => {
  const base = { object: { schema: 'public', name: 't' }, sort: undefined, offset: 0, pageSize: 10 };
  it('not_contains negates the LIKE predicate', () => {
    const b = postgresDialect.buildBrowse({ ...base, filters: [{ column: 'name', op: 'not_contains', value: 'x' }] });
    expect(b.sql).toContain(`WHERE NOT (CAST("name" AS TEXT) ILIKE $1 ESCAPE '\\')`);
    expect(b.params).toEqual([{ value: '%x%' }]);
  });
  it('ends_with matches a trailing pattern', () => {
    const b = postgresDialect.buildBrowse({ ...base, filters: [{ column: 'name', op: 'ends_with', value: 'x' }] });
    expect(b.params).toEqual([{ value: '%x' }]);
  });
  it('in/not_in split a comma-separated value into bound parameters', () => {
    const inB = postgresDialect.buildBrowse({ ...base, filters: [{ column: 'id', op: 'in', value: '1, 2 ,3' }] });
    expect(inB.sql).toContain('"id" IN ($1, $2, $3)');
    expect(inB.params).toEqual([{ value: '1' }, { value: '2' }, { value: '3' }]);
    const notInB = postgresDialect.buildBrowse({ ...base, filters: [{ column: 'id', op: 'not_in', value: '1' }] });
    expect(notInB.sql).toContain('"id" NOT IN ($1)');
  });
  it('in/not_in with no values produce no clause', () => {
    const b = postgresDialect.buildBrowse({ ...base, filters: [{ column: 'id', op: 'in', value: '' }] });
    expect(b.errors.length).toBeGreaterThan(0);
    expect(b.sql).not.toContain('WHERE');
  });
});

describe('filter AND / OR', () => {
  const base = { object: { schema: 'public', name: 't' }, sort: undefined, offset: 0, pageSize: 10 };
  const a = { column: 'a', op: '=' as const, value: '1' };
  const b = { column: 'b', op: '=' as const, value: '2' };
  const c = { column: 'c', op: '=' as const, value: '3' };

  it('ANDs filters by default, as before', () => {
    expect(postgresDialect.buildBrowse({ ...base, filters: [a, b] }).sql).toContain('WHERE "a" = $1 AND "b" = $2');
    expect(postgresDialect.buildBrowse({ ...base, filters: [a, { ...b, join: 'and' }] }).sql).toContain('WHERE "a" = $1 AND "b" = $2');
  });
  it('ORs a filter marked join: or', () => {
    const q = postgresDialect.buildBrowse({ ...base, filters: [a, { ...b, join: 'or' }] });
    expect(q.sql).toContain('WHERE "a" = $1 OR "b" = $2');
    expect(q.params).toEqual([{ value: '1' }, { value: '2' }]);
  });
  it('groups AND runs in parentheses when mixed with OR', () => {
    expect(postgresDialect.buildBrowse({ ...base, filters: [a, b, { ...c, join: 'or' }] }).sql).toContain('WHERE ("a" = $1 AND "b" = $2) OR "c" = $3');
    expect(postgresDialect.buildBrowse({ ...base, filters: [a, { ...b, join: 'or' }, c] }).sql).toContain('WHERE "a" = $1 OR ("b" = $2 AND "c" = $3)');
  });
  it('ignores the join on the first filter', () => {
    expect(postgresDialect.buildBrowse({ ...base, filters: [{ ...a, join: 'or' }, b] }).sql).toContain('WHERE "a" = $1 AND "b" = $2');
  });
  it('lets the next filter join the previous kept one when a filter is skipped', () => {
    const skipped = { column: 'x', op: 'in' as const, value: '' };
    const q = postgresDialect.buildBrowse({ ...base, filters: [a, { ...skipped, join: 'or' }, { ...c, join: 'or' }] });
    expect(q.sql).toContain('WHERE "a" = $1 OR "c" = $2');
    expect(q.errors.length).toBe(1);
  });
  it('works for every driver and in export-all queries', () => {
    const filters = [a, { ...b, join: 'or' as const }];
    for (const d of [mysqlDialect, mssqlDialect, databricksDialect]) expect(d.buildBrowseAll({ object: base.object, filters }).sql).toMatch(/ OR /);
  });
});

describe('operators: between, like and case-sensitive matching', () => {
  const base = { object: { schema: 'public', name: 't' }, sort: undefined, offset: 0, pageSize: 10 };
  const build = (d: Pick<typeof postgresDialect, 'buildBrowse'>, filter: Parameters<typeof postgresDialect.buildBrowse>[0]['filters'][number]) =>
    d.buildBrowse({ ...base, filters: [filter] });

  it('between / not between bind both bounds', () => {
    const q = build(postgresDialect, { column: 'n', op: 'between', value: '1', value2: '9' });
    expect(q.sql).toContain('"n" BETWEEN $1 AND $2');
    expect(q.params).toEqual([{ value: '1' }, { value: '9' }]);
    expect(build(postgresDialect, { column: 'n', op: 'not_between', value: '1', value2: '9' }).sql).toContain('"n" NOT BETWEEN $1 AND $2');
  });
  it('between needs both bounds', () => {
    for (const f of [{ value: '1' }, { value2: '9' }, {}]) {
      const q = build(postgresDialect, { column: 'n', op: 'between', ...f });
      expect(q.errors.length).toBeGreaterThan(0);
    }
  });
  it('like passes the pattern through untouched', () => {
    const q = build(postgresDialect, { column: 'name', op: 'like', value: 'a%b_' });
    expect(q.sql).toContain(`CAST("name" AS TEXT) LIKE $1 ESCAPE '\\'`);
    expect(q.params).toEqual([{ value: 'a%b_' }]);
  });
  it('case-sensitive variants use the engine-specific comparison', () => {
    const f = { column: 'name', op: 'contains_cs' as const, value: 'x' };
    expect(build(postgresDialect, f).sql).toContain(`CAST("name" AS TEXT) LIKE $1`);
    expect(build(postgresDialect, f).sql).not.toContain('ILIKE');
    expect(build(mysqlDialect, f).sql).toContain('LIKE BINARY ?');
    expect(build(mssqlDialect, f).sql).toContain('COLLATE Latin1_General_CS_AS LIKE');
    expect(build(databricksDialect, f).sql).not.toContain('ILIKE');
    expect(build(postgresDialect, { ...f, op: 'contains' }).sql).toContain('ILIKE');
  });
  it('builds each case-sensitive pattern', () => {
    const pattern = (op: 'contains_cs' | 'not_contains_cs' | 'starts_with_cs' | 'ends_with_cs') =>
      build(postgresDialect, { column: 'c', op, value: 'a_' }).params[0].value;
    expect(pattern('contains_cs')).toBe('%a\\_%');
    expect(pattern('starts_with_cs')).toBe('a\\_%');
    expect(pattern('ends_with_cs')).toBe('%a\\_');
    expect(build(postgresDialect, { column: 'c', op: 'not_contains_cs', value: 'x' }).sql).toContain('WHERE NOT (CAST("c" AS TEXT) LIKE $1');
  });
});

describe('raw SQL filter', () => {
  const base = { object: { schema: 'public', name: 't' }, sort: undefined, offset: 0, pageSize: 10 };
  const raw = (value: string, join?: 'and' | 'or') => ({ column: '', op: 'raw' as const, value, join });
  const a = { column: 'a', op: '=' as const, value: '1' };

  it('embeds the condition in parentheses, with no bound parameters', () => {
    const q = postgresDialect.buildBrowse({ ...base, filters: [raw("status = 'open' OR total > 100")] });
    expect(q.sql).toContain(`WHERE (status = 'open' OR total > 100)`);
    expect(q.params).toEqual([]);
    expect(q.errors).toEqual([]);
  });
  it('keeps its own OR from leaking into the other filters', () => {
    const q = postgresDialect.buildBrowse({ ...base, filters: [a, raw('x = 1 OR y = 2')] });
    expect(q.sql).toContain('WHERE "a" = $1 AND (x = 1 OR y = 2)');
  });
  it('combines with other filters through AND / OR', () => {
    expect(postgresDialect.buildBrowse({ ...base, filters: [a, raw('x = 1', 'or')] }).sql).toContain('WHERE "a" = $1 OR (x = 1)');
  });
  it('ends a trailing line comment so it cannot swallow the pagination', () => {
    const q = postgresDialect.buildBrowse({ ...base, filters: [raw('x = 1 -- note')] });
    expect(q.sql).toContain('WHERE (x = 1 -- note\n) LIMIT 11 OFFSET 0');
  });
  it('is not checked against the column list', () => {
    const q = postgresDialect.buildBrowse({ ...base, filters: [raw('lower(name) = 1')] }, [{ name: 'id', type: 'int' }]);
    expect(q.errors).toEqual([]);
  });
  it('rejects conditions that could escape the WHERE clause', () => {
    for (const bad of ['', '   ', '1=1); DROP TABLE t; --', 'a = 1; select 2', 'a = 1) OR (b = 2', "a = 'x", 'a = 1 /* x']) {
      const q = postgresDialect.buildBrowse({ ...base, filters: [raw(bad)] });
      expect(q.errors.length, bad).toBeGreaterThan(0);
      expect(q.sql, bad).not.toContain('WHERE');
    }
  });
});

describe('checkRawCondition', () => {
  it('accepts ordinary conditions', () => {
    for (const ok of ["status = 'open'", 'a IN (1, 2) AND (b > 3 OR c IS NULL)', "name = 'it''s; fine'", "note = '-- not a comment'", 'x = $$a;b$$', 'a = 1 -- trailing', '"odd;col" = 1']) {
      expect(checkRawCondition(ok), ok).toBeNull();
    }
  });
  it('explains what is wrong', () => {
    expect(checkRawCondition('a = 1;')).toMatch(/single condition/);
    expect(checkRawCondition('a = 1)')).toMatch(/unbalanced/i);
    expect(checkRawCondition("a = 'x")).toMatch(/quote/);
  });
});

describe('buildGridDeletes', () => {
  const structure: TableStructure = {
    object: { schema: 'public', name: 't' },
    kind: 'table',
    columns: [
      { ordinal: 0, name: 'id', type: 'integer', nullable: false, defaultValue: null, isPrimaryKey: true, kind: 'number' },
      { ordinal: 1, name: 'name', type: 'text', nullable: true, defaultValue: null, isPrimaryKey: false, kind: 'text' },
    ],
    columnsStatus: { state: 'ok' },
    indexes: [],
    indexesStatus: { state: 'ok' },
    constraints: [{ name: 'pk', type: 'PRIMARY KEY', columns: ['id'] }],
    constraintsStatus: { state: 'ok' },
    gridUpdate: true,
  };

  it('deletes by primary key only', () => {
    const [stmt] = buildGridDeletes(postgresDialect, structure, [{ key: [{ column: 'id', value: '1' }] }]);
    expect(stmt.sql).toBe('DELETE FROM "public"."t" WHERE "id" = $1');
    expect(stmt.params).toEqual([{ value: '1' }]);
  });

  it('builds one statement per row, in order', () => {
    const stmts = buildGridDeletes(postgresDialect, structure, [
      { key: [{ column: 'id', value: '1' }] },
      { key: [{ column: 'id', value: '2' }] },
    ]);
    expect(stmts.map((s) => s.params)).toEqual([[{ value: '1' }], [{ value: '2' }]]);
  });

  it('rejects a duplicate row in the same batch', () => {
    expect(() =>
      buildGridDeletes(postgresDialect, structure, [{ key: [{ column: 'id', value: '1' }] }, { key: [{ column: 'id', value: '1' }] }]),
    ).toThrow(/twice/);
  });

  it('rejects when the key shape does not match the table', () => {
    expect(() => buildGridDeletes(postgresDialect, structure, [{ key: [{ column: 'wrong', value: '1' }] }])).toThrow(/primary key/);
  });

  it('refuses a table without an enforced primary key', () => {
    expect(() => buildGridDeletes(postgresDialect, { ...structure, constraints: [] }, [{ key: [{ column: 'id', value: '1' }] }])).toThrow(/primary key/);
  });

  it('rejects an empty batch', () => {
    expect(() => buildGridDeletes(postgresDialect, structure, [])).toThrow();
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
