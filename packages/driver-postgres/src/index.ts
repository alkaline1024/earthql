import pg from 'pg';
import Cursor from 'pg-cursor';
import {
  CATEGORY_HINTS,
  Dialect,
  binaryCell,
  classifyNodeError,
  executeAtomicGridUpdates,
  isGridText,
  isEarthQLError,
  kindFromTypeName,
  redactInfo,
  timedStep,
  withTimeout,
  MAX_COMPLETION_COLUMNS,
  type CancelRequestResult,
  type Capabilities,
  type Cell,
  type ColumnInfo,
  type CompletionSchema,
  type ConnectionProfile,
  type ConstraintInfo,
  type CursorChunk,
  type CursorOptions,
  type DriverConnection,
  type DriverModule,
  type ErrorCategory,
  type ErrorInfo,
  type ExecContext,
  type IndexInfo,
  type ObjectPath,
  type ObjectPrivileges,
  type PostgresProfile,
  type QueryCursor,
  type ResultColumn,
  type Secrets,
  type SectionStatus,
  type StatementInput,
  type TableStructure,
  type TestResult,
  type TestStep,
  type TreeNode,
  type TypeOption,
} from '@earthql/core';

const { Pool, Client } = pg;

// ---------------------------------------------------------------------------
// Dialect
// ---------------------------------------------------------------------------

const PG_TYPES: TypeOption[] = [
  { name: 'integer', group: 'number' },
  { name: 'bigint', group: 'number' },
  { name: 'smallint', group: 'number' },
  { name: 'numeric', group: 'number', params: 'precision_scale', defaultParams: '38,10' },
  { name: 'real', group: 'number' },
  { name: 'double precision', group: 'number' },
  { name: 'serial', group: 'number' },
  { name: 'bigserial', group: 'number' },
  { name: 'text', group: 'text' },
  { name: 'varchar', group: 'text', params: 'length', defaultParams: '255' },
  { name: 'char', group: 'text', params: 'length', defaultParams: '1' },
  { name: 'uuid', group: 'text' },
  { name: 'boolean', group: 'bool' },
  { name: 'date', group: 'date' },
  { name: 'time', group: 'date' },
  { name: 'timestamp', group: 'date' },
  { name: 'timestamptz', group: 'date' },
  { name: 'interval', group: 'date' },
  { name: 'jsonb', group: 'json' },
  { name: 'json', group: 'json' },
  { name: 'bytea', group: 'binary' },
];

export class PostgresDialect extends Dialect {
  readonly driver = 'postgres' as const;
  readonly types = PG_TYPES;
  quoteIdent(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
  }
  placeholder(i: number): string {
    return `$${i + 1}`;
  }
  stringLiteral(value: string): string {
    // standard_conforming_strings is on by default since 9.1; use E'' only when needed for backslashes.
    if (value.includes('\\')) return `E'${value.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
    return `'${value.replace(/'/g, "''")}'`;
  }
  castToText(expr: string): string {
    return `CAST(${expr} AS TEXT)`;
  }
  ilike(textExpr: string, placeholder: string): string {
    return `${textExpr} ILIKE ${placeholder}`;
  }
  pathParts(p: ObjectPath): string[] {
    return [p.schema ?? 'public', p.name];
  }
  gridUpdateMatch(column: ColumnInfo, placeholder: string, compareOriginal: boolean): string {
    if (compareOriginal && isGridText(column)) return `${this.quoteIdent(column.name)} COLLATE "C" = ${placeholder}`;
    return super.gridUpdateMatch(column, placeholder, compareOriginal);
  }
}

export const postgresDialect = new PostgresDialect();

export const postgresCapabilities: Capabilities = {
  driver: 'postgres',
  hierarchy: ['database', 'schema', 'table'],
  cancel: 'server-confirmed',
  insert: true,
  createTable: true,
  columnDefaults: true,
  primaryKey: true,
  indexes: true,
  streamingExport: true,
  transactions: true,
  types: PG_TYPES,
  quote: '"',
  notes: ['Each database opens its own connection pool.'],
};

// ---------------------------------------------------------------------------
// Value handling
// ---------------------------------------------------------------------------

const RAW_TEXT_OIDS = new Set([
  20, // int8 -> keep exact
  1700, // numeric -> keep exact
  1082, // date
  1083, // time
  1114, // timestamp
  1184, // timestamptz
  1266, // timetz
  1186, // interval
  114, // json
  3802, // jsonb
  790, // money
]);

const customTypes = {
  getTypeParser(oid: number, format?: any) {
    if (RAW_TEXT_OIDS.has(oid)) return (v: string) => v;
    return (pg.types as any).getTypeParser(oid, format);
  },
};

const KNOWN_OIDS: Record<number, string> = {
  16: 'boolean',
  17: 'bytea',
  18: 'char',
  19: 'name',
  20: 'bigint',
  21: 'smallint',
  23: 'integer',
  25: 'text',
  26: 'oid',
  114: 'json',
  142: 'xml',
  700: 'real',
  701: 'double precision',
  790: 'money',
  1042: 'character',
  1043: 'character varying',
  1082: 'date',
  1083: 'time',
  1114: 'timestamp',
  1184: 'timestamptz',
  1186: 'interval',
  1266: 'timetz',
  1700: 'numeric',
  2950: 'uuid',
  3802: 'jsonb',
  1000: 'boolean[]',
  1005: 'smallint[]',
  1007: 'integer[]',
  1016: 'bigint[]',
  1009: 'text[]',
  1015: 'character varying[]',
  2951: 'uuid[]',
};

function toCell(v: unknown, oid: number): Cell {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' || typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : String(v);
  if (v instanceof Uint8Array) return binaryCell(v);
  if (Array.isArray(v) || typeof v === 'object') {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  void oid;
  return String(v);
}

/** Arrays of types pg does not parse (e.g. name[]) arrive as '{a,b}' text. */
function pgArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string' && v.startsWith('{') && v.endsWith('}')) {
    const body = v.slice(1, -1);
    if (!body) return [];
    return body.split(',').map((x) => x.replace(/^"(.*)"$/, '$1').replace(/\\(.)/g, '$1'));
  }
  return [];
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

function classifyPg(e: any): ErrorCategory {
  const code: string | undefined = typeof e?.code === 'string' ? e.code : undefined;
  if (code && /^[0-9A-Z]{5}$/.test(code)) {
    if (code === '28P01' || code === '28000') return 'auth';
    if (code === '42501' || code === '25006') return 'permission';
    if (code === '57014') return /timeout/i.test(String(e.message)) ? 'timeout' : 'cancelled';
    if (code === '3D000' || code === '42P01' || code === '3F000' || code === '42703' || code === '42883') return 'not_found';
    if (code === '42601') return 'syntax';
    if (code.startsWith('23') || code.startsWith('22')) return 'constraint';
    if (code.startsWith('08') || code === '57P01' || code === '57P02' || code === '57P03') return 'network';
    if (code.startsWith('42')) return 'syntax';
  }
  if (/does not support SSL|SSL off|no pg_hba.conf entry.*SSL|SSL connection/i.test(String(e?.message))) return 'tls';
  if (/pg_hba\.conf/i.test(String(e?.message))) return 'permission';
  return classifyNodeError(e) ?? 'unknown';
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

type PgProfile = PostgresProfile;

function sslConfig(p: PgProfile): pg.ClientConfig['ssl'] {
  switch (p.tls.mode) {
    case 'disable':
      return false;
    case 'require':
      return { rejectUnauthorized: false };
    case 'verify':
      return { rejectUnauthorized: true, ca: p.tls.caCert || undefined, servername: p.tls.serverName || undefined };
  }
}

class PostgresConnection implements DriverConnection {
  readonly driver = 'postgres' as const;
  readonly dialect = postgresDialect;
  private pools = new Map<string, pg.Pool>();
  private typeNames = new Map<number, string>(Object.entries(KNOWN_OIDS).map(([k, v]) => [Number(k), v]));

  constructor(
    private readonly profile: PgProfile,
    private readonly secrets: Secrets,
  ) {}

  private baseConfig(database: string): pg.PoolConfig {
    return {
      host: this.profile.host,
      port: this.profile.port || 5432,
      user: this.profile.user,
      password: this.secrets.password ?? '',
      database,
      ssl: sslConfig(this.profile),
      connectionTimeoutMillis: 15000,
      idleTimeoutMillis: 60000,
      max: 6,
      application_name: 'EarthQL',
      types: customTypes as any,
    } as pg.PoolConfig;
  }

  private pool(database?: string): pg.Pool {
    const db = database || this.profile.database || 'postgres';
    let p = this.pools.get(db);
    if (!p) {
      p = new Pool(this.baseConfig(db));
      // Idle client errors (e.g. server restart) must not crash the app.
      p.on('error', () => undefined);
      this.pools.set(db, p);
    }
    return p;
  }

  capabilities(): Capabilities {
    return postgresCapabilities;
  }

  defaultContext(): ExecContext {
    return { database: this.profile.database || 'postgres', schema: undefined };
  }

  classifyError(e: unknown): ErrorInfo {
    if (isEarthQLError(e)) return redactInfo(e.toInfo(), [this.secrets.password]);
    const anyE = e as any;
    const category = classifyPg(anyE);
    const parts = [String(anyE?.message ?? e)];
    if (anyE?.detail) parts.push(String(anyE.detail));
    const info: ErrorInfo = {
      category,
      message: parts.join('\n'),
      code: anyE?.code ? String(anyE.code) : undefined,
      hint: anyE?.hint ? String(anyE.hint) : CATEGORY_HINTS[category],
      driver: 'postgres',
    };
    if (anyE?.position && category === 'syntax') info.message += ` (at character ${anyE.position})`;
    return redactInfo(info, [this.secrets.password]);
  }

  private async q<T = any>(sql: string, params: unknown[] = [], database?: string): Promise<T[]> {
    const res = await this.pool(database).query(sql, params);
    return res.rows as T[];
  }

  async test(): Promise<TestResult> {
    const steps: TestStep[] = [];
    // Use a dedicated client so a stale pool cannot mask the result.
    const client = new Client(this.baseConfig(this.profile.database || 'postgres'));
    client.on('error', () => undefined);
    try {
      await timedStep(steps, `Connect to ${this.profile.host}:${this.profile.port || 5432}`, () =>
        withTimeout(client.connect(), 20000, 'Connection'),
      );
      await timedStep(steps, `SELECT 1 on database "${this.profile.database || 'postgres'}"`, () => client.query('SELECT 1'));
      const v = await client.query('SHOW server_version');
      const version = `PostgreSQL ${v.rows[0]?.server_version ?? ''}`.trim();
      const ssl = await client
        .query('SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()')
        .then((r) => (r.rows[0]?.ssl ? 'TLS on' : 'TLS off'))
        .catch(() => undefined);
      if (ssl) steps.push({ name: 'Transport', ok: true, detail: ssl, durationMs: 0 });
      return { ok: true, steps, serverVersion: version };
    } catch (e) {
      return { ok: false, steps, error: this.classifyError(e) };
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  async listChildren(parent: TreeNode | null): Promise<TreeNode[]> {
    if (!parent) {
      const rows = await this.q<{ datname: string }>(
        `SELECT datname FROM pg_database
         WHERE datallowconn AND NOT datistemplate AND has_database_privilege(datname, 'CONNECT')
         ORDER BY datname`,
      );
      const def = this.profile.database || 'postgres';
      const names = rows.map((r) => r.datname);
      if (!names.includes(def)) names.unshift(def);
      return names.map((d) => ({
        kind: 'database' as const,
        name: d,
        path: {},
        hasChildren: true,
        detail: d === def ? 'default' : undefined,
      }));
    }
    if (parent.kind === 'database') {
      const db = parent.name;
      const rows = await this.q<{ nspname: string }>(
        `SELECT nspname FROM pg_namespace
         WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema'
           AND has_schema_privilege(nspname, 'USAGE')
         ORDER BY nspname = 'public' DESC, nspname`,
        [],
        db,
      );
      return rows.map((r) => ({ kind: 'schema' as const, name: r.nspname, path: { database: db }, hasChildren: true }));
    }
    if (parent.kind === 'schema') {
      const db = parent.path.database!;
      const schema = parent.name;
      const rows = await this.q<{ relname: string; relkind: string }>(
        `SELECT c.relname, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND c.relkind IN ('r','p','v','m','f')
         ORDER BY c.relname`,
        [schema],
        db,
      );
      return rows.map((r) => ({
        kind: r.relkind === 'v' || r.relkind === 'm' ? ('view' as const) : ('table' as const),
        name: r.relname,
        path: { database: db, schema, name: r.relname },
        hasChildren: false,
        detail: r.relkind === 'm' ? 'materialized' : r.relkind === 'f' ? 'foreign' : r.relkind === 'p' ? 'partitioned' : undefined,
      }));
    }
    return [];
  }

  async getStructure(object: ObjectPath): Promise<TableStructure> {
    const db = object.database;
    const schema = object.schema ?? 'public';
    const rel = await this.q<{ oid: number; relkind: string; has_children: boolean }>(
      `SELECT c.oid, c.relkind, EXISTS (SELECT 1 FROM pg_inherits WHERE inhparent = c.oid) AS has_children
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2`,
      [schema, object.name],
      db,
    );
    if (rel.length === 0) {
      throw Object.assign(new Error(`Relation ${schema}.${object.name} not found`), { code: '42P01' });
    }
    const oid = rel[0].oid;
    const kind = rel[0].relkind === 'v' || rel[0].relkind === 'm' ? 'view' : 'table';

    const cols = await this.q<any>(
      `SELECT a.attnum, a.attname, format_type(a.atttypid, a.atttypmod) AS type, NOT a.attnotnull AS nullable,
              pg_get_expr(d.adbin, d.adrelid) AS def, a.attidentity, a.attgenerated, col_description(a.attrelid, a.attnum) AS comment,
              COALESCE((SELECT true FROM pg_index ix WHERE ix.indrelid = a.attrelid AND ix.indisprimary AND a.attnum = ANY(ix.indkey)), false) AS pk
       FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`,
      [oid],
      db,
    );
    const columns: ColumnInfo[] = cols.map((c, i) => ({
      ordinal: i + 1,
      name: c.attname,
      type: c.type,
      nullable: c.nullable,
      defaultValue:
        c.def ?? (c.attidentity === 'a' ? 'GENERATED ALWAYS AS IDENTITY' : c.attidentity === 'd' ? 'GENERATED BY DEFAULT AS IDENTITY' : null),
      isPrimaryKey: !!c.pk,
      isIdentity: !!c.attidentity,
      isGenerated: !!c.attgenerated,
      comment: c.comment,
      kind: kindFromTypeName(c.type),
    }));

    let indexes: IndexInfo[] = [];
    let indexesStatus: SectionStatus = { state: 'ok' };
    try {
      const rows = await this.q<any>(
        `SELECT i.relname AS name, ix.indisunique AS unique, ix.indisprimary AS primary, pg_get_indexdef(ix.indexrelid) AS def,
                ARRAY(SELECT pg_get_indexdef(ix.indexrelid, k + 1, true) FROM generate_subscripts(ix.indkey, 1) AS k ORDER BY k) AS cols
         FROM pg_index ix JOIN pg_class i ON i.oid = ix.indexrelid WHERE ix.indrelid = $1 ORDER BY ix.indisprimary DESC, i.relname`,
        [oid],
        db,
      );
      indexes = rows.map((r) => ({ name: r.name, unique: r.unique, primary: r.primary, columns: pgArray(r.cols), definition: r.def }));
      if (indexes.length === 0) indexesStatus = { state: 'empty' };
    } catch (e) {
      indexesStatus = { state: 'denied', message: this.classifyError(e).message };
    }

    let constraints: ConstraintInfo[] = [];
    let constraintsStatus: SectionStatus = { state: 'ok' };
    try {
      const rows = await this.q<any>(
        `SELECT con.conname AS name, con.contype AS type, pg_get_constraintdef(con.oid) AS def,
                ARRAY(SELECT a.attname::text FROM unnest(con.conkey) WITH ORDINALITY AS k(attnum, ord)
                      JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum ORDER BY k.ord) AS cols,
                CASE WHEN con.confrelid <> 0 THEN con.confrelid::regclass::text END AS ref
         FROM pg_constraint con WHERE con.conrelid = $1 ORDER BY con.contype, con.conname`,
        [oid],
        db,
      );
      const typeName: Record<string, string> = { p: 'PRIMARY KEY', f: 'FOREIGN KEY', u: 'UNIQUE', c: 'CHECK', x: 'EXCLUDE', n: 'NOT NULL' };
      constraints = rows
        .filter((r) => r.type !== 'n')
        .map((r) => ({ name: r.name, type: typeName[r.type] ?? r.type, columns: pgArray(r.cols), definition: r.def, references: r.ref ?? undefined }));
      if (constraints.length === 0) constraintsStatus = { state: 'empty' };
    } catch (e) {
      constraintsStatus = { state: 'denied', message: this.classifyError(e).message };
    }

    return {
      object,
      kind,
      columns,
      columnsStatus: columns.length ? { state: 'ok' } : { state: 'empty' },
      indexes,
      indexesStatus,
      constraints,
      constraintsStatus,
      gridUpdate: rel[0].relkind === 'p' || (rel[0].relkind === 'r' && !rel[0].has_children),
    };
  }

  async getPrivileges(object: ObjectPath): Promise<ObjectPrivileges> {
    const schema = object.schema ?? 'public';
    const qualified = `${this.dialect.quoteIdent(schema)}.${this.dialect.quoteIdent(object.name)}`;
    try {
      const rows = await this.q<any>(
        `SELECT has_table_privilege($1, 'SELECT') AS sel, has_table_privilege($1, 'INSERT') AS ins, has_any_column_privilege($1, 'UPDATE') AS upd,
                has_schema_privilege($2, 'CREATE') AS cre, current_setting('transaction_read_only') AS ro`,
        [qualified, schema],
        object.database,
      );
      const r = rows[0];
      const ro = r.ro === 'on';
      return {
        select: r.sel ? 'yes' : 'no',
        insert: ro ? 'no' : r.ins ? 'yes' : 'no',
        update: ro || !r.upd ? 'no' : 'yes',
        create: ro ? 'no' : r.cre ? 'yes' : 'no',
        reason: ro ? 'The session is read-only (transaction_read_only = on).' : !r.ins ? 'This account has no INSERT privilege on the table.' : undefined,
      };
    } catch {
      return { select: 'unknown', insert: 'unknown', create: 'unknown' };
    }
  }

  async completionSchema(ctx: ExecContext): Promise<CompletionSchema> {
    const rows = await this.q<{ s: string; t: string; c: string }>(
      `SELECT n.nspname AS s, c.relname AS t, a.attname AS c
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
       WHERE c.relkind IN ('r','p','v','m','f') AND n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema'
         AND has_schema_privilege(n.oid, 'USAGE')
       ORDER BY n.nspname, c.relname, a.attnum LIMIT ${MAX_COMPLETION_COLUMNS + 1}`,
      [],
      ctx.database,
    );
    const namespaces: CompletionSchema['namespaces'] = {};
    for (const r of rows.slice(0, MAX_COMPLETION_COLUMNS)) {
      ((namespaces[r.s] ??= {})[r.t] ??= []).push(r.c);
    }
    return { defaultNamespace: ctx.schema ?? 'public', namespaces, truncated: rows.length > MAX_COMPLETION_COLUMNS };
  }

  async resolveTypeNames(oids: number[], database?: string): Promise<void> {
    const missing = [...new Set(oids)].filter((o) => !this.typeNames.has(o));
    if (missing.length === 0) return;
    try {
      const rows = await this.q<{ oid: number; name: string }>(`SELECT oid::int AS oid, format_type(oid, NULL) AS name FROM pg_type WHERE oid = ANY($1)`, [missing], database);
      for (const r of rows) this.typeNames.set(Number(r.oid), r.name);
    } catch {
      /* best effort */
    }
  }

  typeName(oid: number): string {
    return this.typeNames.get(oid) ?? `oid:${oid}`;
  }

  openCursor(stmt: StatementInput, ctx: ExecContext, opts?: CursorOptions): QueryCursor {
    return new PgCursor(this, stmt, ctx, opts);
  }

  acquire(database?: string): Promise<pg.PoolClient> {
    return this.pool(database).connect();
  }

  async applyGridUpdates(object: ObjectPath, statements: StatementInput[]): Promise<void> {
    const client = await this.acquire(object.database);
    let discard = false;
    try {
      await executeAtomicGridUpdates(statements, {
        begin: () => client.query('BEGIN'),
        update: async (statement) => (await client.query(statement.sql, statement.params?.map(({ value }) => value))).rowCount ?? undefined,
        commit: () => client.query('COMMIT'),
        rollback: async () => { try { await client.query('ROLLBACK'); } catch { discard = true; } },
        classifyError: (error) => this.classifyError(error),
      });
    } finally {
      client.release(discard);
    }
  }

  async cancelBackend(pid: number, database?: string): Promise<boolean> {
    // Use a separate short-lived client: the pool may be exhausted by the running query.
    const c = new Client(this.baseConfig(database || this.profile.database || 'postgres'));
    c.on('error', () => undefined);
    try {
      await withTimeout(c.connect(), 10000, 'Cancel connection');
      const r = await c.query('SELECT pg_cancel_backend($1) AS ok', [pid]);
      return !!r.rows[0]?.ok;
    } finally {
      await c.end().catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    const pools = [...this.pools.values()];
    this.pools.clear();
    await Promise.all(pools.map((p) => p.end().catch(() => undefined)));
  }
}

class PgCursor implements QueryCursor {
  private client?: pg.PoolClient;
  private cursor?: Cursor;
  private pid?: number;
  private closed = false;
  private notices: string[] = [];
  private columns: ResultColumn[] | null = null;
  private oids: number[] = [];
  private broken = false;

  constructor(
    private readonly conn: PostgresConnection,
    private readonly stmt: StatementInput,
    private readonly ctx: ExecContext,
    private readonly opts?: CursorOptions,
  ) {}

  private onNotice = (n: any) => {
    this.notices.push(`${n.severity ?? 'NOTICE'}: ${n.message}`);
  };

  private onError = () => {
    this.broken = true;
  };

  private async start(): Promise<void> {
    this.opts?.onPhase?.('connecting');
    const client = await this.conn.acquire(this.ctx.database);
    this.client = client;
    client.on('notice', this.onNotice);
    client.on('error', this.onError);
    this.pid = (client as any).processID;
    // Make the tab's schema the first on the search path (explicitly reset otherwise: pooled clients keep state).
    if (this.ctx.schema) {
      await client.query(`SELECT set_config('search_path', $1, false)`, [`${this.conn.dialect.quoteIdent(this.ctx.schema)}, public`]);
    } else {
      await client.query('RESET search_path');
    }
    if (this.closed) throw Object.assign(new Error('canceling statement due to user request'), { code: '57014' });
    this.opts?.onPhase?.('running');
    const values = (this.stmt.params ?? []).map((p) => p.value);
    this.cursor = client.query(new Cursor(this.stmt.sql, values, { rowMode: 'array' } as any));
  }

  async fetch(maxRows: number): Promise<CursorChunk> {
    if (!this.cursor) await this.start();
    const cursor = this.cursor!;
    const { rows, result } = await new Promise<{ rows: any[][]; result: any }>((resolve, reject) => {
      cursor.read(maxRows, (err: Error | undefined, rows: any[], result: any) => (err ? reject(err) : resolve({ rows, result })));
    });
    const res = result ?? (cursor as any)._result;
    const fields: any[] = res?.fields ?? [];
    if (!this.columns && fields.length > 0) {
      this.oids = fields.map((f) => f.dataTypeID);
      await this.conn.resolveTypeNames(this.oids, this.ctx.database);
      this.columns = fields.map((f) => {
        const type = this.conn.typeName(f.dataTypeID);
        return { name: f.name, type, kind: kindFromTypeName(type) };
      });
    }
    this.opts?.onPhase?.('fetching');
    const done = (cursor as any).state === 'done' || (maxRows > 0 && rows.length < maxRows);
    const out: CursorChunk = {
      columns: this.columns,
      rows: rows.map((r) => r.map((v, i) => toCell(v, this.oids[i]))),
      done,
      command: res?.command ?? undefined,
      rowsAffected: typeof res?.rowCount === 'number' ? res.rowCount : undefined,
      notices: this.notices.length ? this.notices.splice(0) : undefined,
    };
    if (done) await this.close();
    return out;
  }

  async cancel(): Promise<CancelRequestResult> {
    if (!this.client) {
      this.closed = true;
      return 'not-running';
    }
    if (this.pid === undefined) return 'failed';
    try {
      return (await this.conn.cancelBackend(this.pid, this.ctx.database)) ? 'requested' : 'not-running';
    } catch {
      return 'failed';
    }
  }

  async close(): Promise<void> {
    if (this.closed && !this.client) return;
    this.closed = true;
    const client = this.client;
    this.client = undefined;
    if (!client) return;
    try {
      const state = (this.cursor as any)?.state;
      // After an error the cursor has already synced; after 'done' there is nothing to close.
      if (this.cursor && state !== 'error' && state !== 'done') {
        await withTimeout(this.cursor.close(), 5000, 'Closing cursor').catch(() => (this.broken = true));
      }
    } finally {
      client.off('notice', this.onNotice);
      client.off('error', this.onError);
      // Destroy the client if the connection is in doubt rather than returning it to the pool.
      client.release(this.broken ? true : undefined);
    }
  }
}

export const postgresDriver: DriverModule = {
  id: 'postgres',
  dialect: postgresDialect,
  capabilities: postgresCapabilities,
  connect(profile: ConnectionProfile, secrets: Secrets): DriverConnection {
    if (profile.driver !== 'postgres') throw new Error('Profile is not a PostgreSQL profile');
    return new PostgresConnection(profile, secrets);
  },
};

export default postgresDriver;
