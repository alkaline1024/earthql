import mysql from 'mysql2';
import type { FieldPacket, Pool, PoolConnection, ResultSetHeader } from 'mysql2';
import {
  CATEGORY_HINTS,
  Dialect,
  PullBuffer,
  binaryCell,
  classifyNodeError,
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
  type ColumnSpec,
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
  type MysqlProfile,
  type ObjectPath,
  type ObjectPrivileges,
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

// ---------------------------------------------------------------------------
// Dialect
// ---------------------------------------------------------------------------

const MYSQL_TYPES: TypeOption[] = [
  { name: 'INT', group: 'number' },
  { name: 'BIGINT', group: 'number' },
  { name: 'SMALLINT', group: 'number' },
  { name: 'TINYINT', group: 'number' },
  { name: 'DECIMAL', group: 'number', params: 'precision_scale', defaultParams: '38,10' },
  { name: 'DOUBLE', group: 'number' },
  { name: 'FLOAT', group: 'number' },
  { name: 'VARCHAR', group: 'text', params: 'length', defaultParams: '255' },
  { name: 'CHAR', group: 'text', params: 'length', defaultParams: '1' },
  { name: 'TEXT', group: 'text' },
  { name: 'LONGTEXT', group: 'text' },
  { name: 'BOOLEAN', group: 'bool' },
  { name: 'DATE', group: 'date' },
  { name: 'DATETIME', group: 'date', params: 'precision', defaultParams: '3' },
  { name: 'TIMESTAMP', group: 'date', params: 'precision', defaultParams: '3' },
  { name: 'TIME', group: 'date' },
  { name: 'JSON', group: 'json' },
  { name: 'BLOB', group: 'binary' },
  { name: 'VARBINARY', group: 'binary', params: 'length', defaultParams: '255' },
];

export class MysqlDialect extends Dialect {
  readonly driver = 'mysql' as const;
  readonly types = MYSQL_TYPES;
  quoteIdent(name: string): string {
    return '`' + name.replace(/`/g, '``') + '`';
  }
  placeholder(): string {
    return '?';
  }
  stringLiteral(value: string): string {
    return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "''").replace(/\0/g, '\\0')}'`;
  }
  castToText(expr: string): string {
    return `CAST(${expr} AS CHAR)`;
  }
  ilike(textExpr: string, placeholder: string): string {
    // Case sensitivity follows the connection collation (utf8mb4 defaults are case-insensitive).
    return `${textExpr} LIKE ${placeholder}`;
  }
  likeEscapeClause(): string {
    return ''; // backslash is MySQL's default LIKE escape character
  }
  pathParts(p: ObjectPath): string[] {
    return p.database ? [p.database, p.name] : [p.name];
  }
  defaultClause(c: ColumnSpec): string | null {
    if (c.default.kind === 'none') return null;
    const blobLike = /^(tiny|medium|long)?(text|blob)\b|^json\b|^geometry\b/i.test(c.type.trim());
    if (c.default.kind === 'expression') {
      const v = c.default.value.trim();
      // MySQL 8.0.13+: expression defaults must be parenthesised, except CURRENT_TIMESTAMP-style values for temporal columns.
      if (/^(CURRENT_TIMESTAMP|NOW|LOCALTIME|LOCALTIMESTAMP)(\(\d*\))?$/i.test(v) || /^\(.*\)$/s.test(v)) return v;
      return `(${v})`;
    }
    const lit = this.literalForType(c.default.value, c.type);
    return blobLike ? `(${lit})` : lit;
  }
}

export const mysqlDialect = new MysqlDialect();

export const mysqlCapabilities: Capabilities = {
  driver: 'mysql',
  hierarchy: ['database', 'table'],
  cancel: 'server-confirmed',
  insert: true,
  createTable: true,
  columnDefaults: true,
  primaryKey: true,
  indexes: true,
  streamingExport: true,
  transactions: true,
  types: MYSQL_TYPES,
  quote: '`',
  notes: ['Expression defaults on TEXT/BLOB/JSON columns require MySQL 8.0.13 or later.'],
};

// ---------------------------------------------------------------------------
// Types and values
// ---------------------------------------------------------------------------

const TYPE_NAMES: Record<number, string> = {
  0: 'DECIMAL',
  1: 'TINYINT',
  2: 'SMALLINT',
  3: 'INT',
  4: 'FLOAT',
  5: 'DOUBLE',
  6: 'NULL',
  7: 'TIMESTAMP',
  8: 'BIGINT',
  9: 'MEDIUMINT',
  10: 'DATE',
  11: 'TIME',
  12: 'DATETIME',
  13: 'YEAR',
  14: 'DATE',
  15: 'VARCHAR',
  16: 'BIT',
  242: 'VECTOR',
  245: 'JSON',
  246: 'DECIMAL',
  247: 'ENUM',
  248: 'SET',
  249: 'TINYBLOB',
  250: 'MEDIUMBLOB',
  251: 'LONGBLOB',
  252: 'BLOB',
  253: 'VARCHAR',
  254: 'CHAR',
  255: 'GEOMETRY',
};

const BINARY_CHARSET = 63;

function fieldType(f: FieldPacket): string {
  const t = (f as any).columnType as number;
  let name = TYPE_NAMES[t] ?? `TYPE${t}`;
  const binary = (f as any).characterSet === BINARY_CHARSET;
  if (!binary) {
    if (name.endsWith('BLOB')) name = name.replace('BLOB', 'TEXT');
  } else {
    if (name === 'VARCHAR') name = 'VARBINARY';
    if (name === 'CHAR') name = 'BINARY';
  }
  if (name === 'DECIMAL' && typeof (f as any).decimals === 'number') {
    // columnLength includes sign and point; good enough for display
    return `DECIMAL(${Math.max(1, ((f as any).columnLength ?? 0) - ((f as any).decimals > 0 ? 2 : 1))},${(f as any).decimals})`;
  }
  return name;
}

function toCell(v: unknown): Cell {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' || typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : String(v);
  if (typeof v === 'bigint') return v.toString();
  if (Buffer.isBuffer(v)) return binaryCell(v);
  if (v instanceof Date) return v.toISOString();
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

function classifyMysql(e: any): ErrorCategory {
  const errno: number | undefined = typeof e?.errno === 'number' ? e.errno : undefined;
  const code: string = String(e?.code ?? '');
  if (errno !== undefined) {
    if ([1045, 1698, 1251, 2059, 1862, 1820].includes(errno)) return 'auth';
    if ([1044, 1142, 1143, 1227, 1370, 1290, 1792, 1036, 1356, 1419, 1211].includes(errno)) return 'permission';
    if ([1049, 1146, 1054, 1305, 1109].includes(errno)) return 'not_found';
    if (errno === 1064 || errno === 1149) return 'syntax';
    if (errno === 1317) return 'cancelled';
    if (errno === 3024 || errno === 1205) return 'timeout';
    if ([1062, 1048, 1452, 1451, 1366, 1264, 1406, 1292, 3819, 1265, 1364].includes(errno)) return 'constraint';
    if ([2002, 2003, 2005, 2006, 2013, 1040, 1053, 1158, 1159, 1160, 1161].includes(errno)) return 'network';
  }
  if (/^HANDSHAKE_(SSL|NO_SSL)/.test(code) || /ssl|tls|certificate/i.test(String(e?.message))) return 'tls';
  if (code === 'PROTOCOL_CONNECTION_LOST' || code === 'PROTOCOL_SEQUENCE_TIMEOUT') return 'network';
  return classifyNodeError(e) ?? 'unknown';
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

function sslOptions(p: MysqlProfile): mysql.SslOptions | undefined {
  switch (p.tls.mode) {
    case 'disable':
      return undefined;
    case 'require':
      return { rejectUnauthorized: false };
    case 'verify':
      return { rejectUnauthorized: true, ca: p.tls.caCert || undefined };
  }
}

const SYSTEM_DBS = new Set(['information_schema', 'performance_schema', 'mysql', 'sys']);

class MysqlConnection implements DriverConnection {
  readonly driver = 'mysql' as const;
  readonly dialect = mysqlDialect;
  private _pool?: Pool;

  constructor(
    private readonly profile: MysqlProfile,
    private readonly secrets: Secrets,
  ) {}

  connOptions(): mysql.ConnectionOptions {
    return {
      host: this.profile.host,
      port: this.profile.port || 3306,
      user: this.profile.user,
      password: this.secrets.password ?? '',
      database: this.profile.database || undefined,
      ssl: sslOptions(this.profile),
      connectTimeout: 15000,
      supportBigNumbers: true,
      bigNumberStrings: true,
      decimalNumbers: false,
      dateStrings: true,
      multipleStatements: false,
      charset: 'utf8mb4',
      timezone: 'Z',
    };
  }

  pool(): Pool {
    if (!this._pool) {
      this._pool = mysql.createPool({ ...this.connOptions(), connectionLimit: 6, waitForConnections: true, enableKeepAlive: true });
      this._pool.on('connection', (c) => c.on('error', () => undefined));
    }
    return this._pool;
  }

  private async q<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
    const [rows] = await this.pool().promise().query(sql, params);
    return rows as T[];
  }

  capabilities(): Capabilities {
    return mysqlCapabilities;
  }

  defaultContext(): ExecContext {
    return { database: this.profile.database || undefined };
  }

  classifyError(e: unknown): ErrorInfo {
    if (isEarthQLError(e)) return redactInfo(e.toInfo(), [this.secrets.password]);
    const anyE = e as any;
    const category = classifyMysql(anyE);
    const info: ErrorInfo = {
      category,
      message: String(anyE?.sqlMessage ?? anyE?.message ?? e),
      code: anyE?.errno ? `${anyE.code ?? ''} (${anyE.errno})`.trim() : anyE?.code,
      hint: CATEGORY_HINTS[category],
      driver: 'mysql',
    };
    return redactInfo(info, [this.secrets.password]);
  }

  async test(): Promise<TestResult> {
    const steps: TestStep[] = [];
    const raw = mysql.createConnection(this.connOptions());
    raw.on('error', () => undefined);
    const c = raw.promise();
    try {
      await timedStep(steps, `Connect to ${this.profile.host}:${this.profile.port || 3306}`, () => withTimeout(c.connect(), 20000, 'Connection'));
      await timedStep(steps, `SELECT 1${this.profile.database ? ` on database "${this.profile.database}"` : ''}`, () => c.query('SELECT 1'));
      const [v] = await c.query('SELECT VERSION() AS v');
      const [ssl] = await c.query("SHOW SESSION STATUS LIKE 'Ssl_cipher'").catch(() => [[]] as any);
      const cipher = (ssl as any[])[0]?.Value;
      steps.push({ name: 'Transport', ok: true, detail: cipher ? `TLS (${cipher})` : 'TLS off', durationMs: 0 });
      return { ok: true, steps, serverVersion: `MySQL ${(v as any[])[0]?.v ?? ''}` };
    } catch (e) {
      return { ok: false, steps, error: this.classifyError(e) };
    } finally {
      // end() can wait forever on a connection whose handshake failed: give it a moment, then destroy.
      await withTimeout(c.end(), 2000, 'Close').catch(() => raw.destroy());
    }
  }

  async listChildren(parent: TreeNode | null): Promise<TreeNode[]> {
    if (!parent) {
      const rows = await this.q<{ Database: string }>('SHOW DATABASES');
      const names = rows.map((r) => r.Database);
      const user = names.filter((n) => !SYSTEM_DBS.has(n)).sort();
      const sys = names.filter((n) => SYSTEM_DBS.has(n)).sort();
      return [...user, ...sys].map((d) => ({
        kind: 'database' as const,
        name: d,
        path: {},
        hasChildren: true,
        detail: d === this.profile.database ? 'default' : SYSTEM_DBS.has(d) ? 'system' : undefined,
      }));
    }
    if (parent.kind === 'database') {
      const rows = await this.q<{ name: string; type: string }>(
        'SELECT TABLE_NAME AS name, TABLE_TYPE AS type FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME',
        [parent.name],
      );
      return rows.map((r) => ({
        kind: /VIEW/.test(r.type) ? ('view' as const) : ('table' as const),
        name: r.name,
        path: { database: parent.name, name: r.name },
        hasChildren: false,
      }));
    }
    return [];
  }

  private db(object: ObjectPath): string {
    const db = object.database || this.profile.database;
    if (!db) throw Object.assign(new Error('No database selected'), { errno: 1046 });
    return db;
  }

  async getStructure(object: ObjectPath): Promise<TableStructure> {
    const db = this.db(object);
    const t = await this.q<{ type: string }>('SELECT TABLE_TYPE AS type FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?', [
      db,
      object.name,
    ]);
    const kind = t[0] && /VIEW/.test(t[0].type) ? 'view' : 'table';
    const cols = await this.q<any>(
      `SELECT ORDINAL_POSITION AS pos, COLUMN_NAME AS name, COLUMN_TYPE AS type, DATA_TYPE AS dtype, IS_NULLABLE AS nullable,
              COLUMN_DEFAULT AS def, COLUMN_KEY AS ckey, EXTRA AS extra, COLUMN_COMMENT AS comment
       FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`,
      [db, object.name],
    );
    const columns: ColumnInfo[] = cols.map((c, i) => ({
      ordinal: i + 1,
      name: c.name,
      type: c.type,
      nullable: c.nullable === 'YES',
      defaultValue: formatMysqlDefault(c.def, c.dtype, c.extra),
      isPrimaryKey: c.ckey === 'PRI',
      isIdentity: /auto_increment/i.test(c.extra ?? ''),
      comment: c.comment || null,
      kind: kindFromTypeName(c.type),
    }));
    const columnsStatus: SectionStatus =
      columns.length > 0
        ? { state: 'ok' }
        : t.length === 0
          ? { state: 'denied', message: 'The table is not visible to this account (no privileges, or it does not exist).' }
          : { state: 'empty' };

    let indexes: IndexInfo[] = [];
    let indexesStatus: SectionStatus = { state: 'ok' };
    if (kind === 'view') indexesStatus = { state: 'unsupported', message: 'Views have no indexes in MySQL.' };
    else {
      try {
        const rows = await this.q<any>(
          `SELECT INDEX_NAME AS name, NON_UNIQUE AS nonUnique, COLUMN_NAME AS col, EXPRESSION AS expr, SEQ_IN_INDEX AS seq
           FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY INDEX_NAME = 'PRIMARY' DESC, INDEX_NAME, SEQ_IN_INDEX`,
          [db, object.name],
        ).catch(async (e) => {
          // MySQL 5.7 has no EXPRESSION column
          if (e?.errno === 1054)
            return this.q<any>(
              `SELECT INDEX_NAME AS name, NON_UNIQUE AS nonUnique, COLUMN_NAME AS col, SEQ_IN_INDEX AS seq
               FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY INDEX_NAME = 'PRIMARY' DESC, INDEX_NAME, SEQ_IN_INDEX`,
              [db, object.name],
            );
          throw e;
        });
        const map = new Map<string, IndexInfo>();
        for (const r of rows) {
          let idx = map.get(r.name);
          if (!idx) {
            idx = { name: r.name, columns: [], unique: Number(r.nonUnique) === 0, primary: r.name === 'PRIMARY' };
            map.set(r.name, idx);
          }
          idx.columns.push(r.col ?? r.expr ?? '?');
        }
        indexes = [...map.values()];
        if (indexes.length === 0) indexesStatus = { state: 'empty' };
      } catch (e) {
        indexesStatus = { state: 'denied', message: this.classifyError(e).message };
      }
    }

    let constraints: ConstraintInfo[] = [];
    let constraintsStatus: SectionStatus = { state: 'ok' };
    if (kind === 'view') constraintsStatus = { state: 'unsupported', message: 'Views have no constraints in MySQL.' };
    else {
      try {
        const rows = await this.q<any>(
          `SELECT tc.CONSTRAINT_NAME AS name, tc.CONSTRAINT_TYPE AS type, k.COLUMN_NAME AS col,
                  k.REFERENCED_TABLE_SCHEMA AS rdb, k.REFERENCED_TABLE_NAME AS rtable, k.REFERENCED_COLUMN_NAME AS rcol
           FROM information_schema.TABLE_CONSTRAINTS tc
           LEFT JOIN information_schema.KEY_COLUMN_USAGE k
             ON k.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA AND k.CONSTRAINT_NAME = tc.CONSTRAINT_NAME AND k.TABLE_NAME = tc.TABLE_NAME
           WHERE tc.TABLE_SCHEMA = ? AND tc.TABLE_NAME = ? ORDER BY tc.CONSTRAINT_TYPE, tc.CONSTRAINT_NAME, k.ORDINAL_POSITION`,
          [db, object.name],
        );
        const map = new Map<string, ConstraintInfo>();
        for (const r of rows) {
          let c = map.get(r.name + r.type);
          if (!c) {
            c = { name: r.name, type: r.type, columns: [], references: r.rtable ? `${r.rdb}.${r.rtable}` : undefined };
            map.set(r.name + r.type, c);
          }
          if (r.col) c.columns.push(r.col);
        }
        // CHECK constraint definitions (MySQL 8.0.16+)
        const checks = await this.q<any>(
          `SELECT CONSTRAINT_NAME AS name, CHECK_CLAUSE AS clause FROM information_schema.CHECK_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = ?`,
          [db],
        ).catch(() => []);
        for (const ch of checks) {
          const c = map.get(ch.name + 'CHECK');
          if (c) c.definition = `CHECK (${ch.clause})`;
        }
        constraints = [...map.values()];
        if (constraints.length === 0) constraintsStatus = { state: 'empty' };
      } catch (e) {
        constraintsStatus = { state: 'denied', message: this.classifyError(e).message };
      }
    }
    return { object, kind, columns, columnsStatus, indexes, indexesStatus, constraints, constraintsStatus };
  }

  async getPrivileges(object: ObjectPath): Promise<ObjectPrivileges> {
    try {
      const db = this.db(object);
      const [ro] = await this.q<any>('SELECT @@transaction_read_only AS tro, CURRENT_USER() AS cu');
      if (Number(ro.tro) === 1) {
        return { select: 'yes', insert: 'no', create: 'no', reason: 'The session is read-only (transaction_read_only = 1).' };
      }
      const cu = String(ro.cu);
      const at = cu.lastIndexOf('@');
      const grantee = `'${cu.slice(0, at)}'@'${cu.slice(at + 1)}'`;
      const rows = await this.q<{ p: string }>(
        `SELECT PRIVILEGE_TYPE AS p FROM information_schema.USER_PRIVILEGES WHERE GRANTEE = ?
         UNION SELECT PRIVILEGE_TYPE FROM information_schema.SCHEMA_PRIVILEGES WHERE GRANTEE = ? AND TABLE_SCHEMA = ?
         UNION SELECT PRIVILEGE_TYPE FROM information_schema.TABLE_PRIVILEGES WHERE GRANTEE = ? AND TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
        [grantee, grantee, db, grantee, db, object.name],
      );
      const privs = new Set(rows.map((r) => r.p.toUpperCase()));
      // Roles and wildcard schema grants are not fully visible through information_schema: only answer "no" when no role is active.
      const [role] = await this.q<any>('SELECT CURRENT_ROLE() AS r').catch(() => [{ r: 'NONE' }]);
      const rolesActive = role && role.r && role.r !== 'NONE';
      const tri = (p: string) => (privs.has(p) ? 'yes' : rolesActive || privs.size === 0 ? 'unknown' : 'no') as 'yes' | 'no' | 'unknown';
      const insert = tri('INSERT');
      return { select: tri('SELECT'), insert, create: tri('CREATE'), reason: insert === 'no' ? 'This account has no INSERT privilege on the table.' : undefined };
    } catch {
      return { select: 'unknown', insert: 'unknown', create: 'unknown' };
    }
  }

  async completionSchema(ctx: ExecContext): Promise<CompletionSchema> {
    const rows = await this.q<{ s: string; t: string; c: string }>(
      `SELECT TABLE_SCHEMA AS s, TABLE_NAME AS t, COLUMN_NAME AS c FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA NOT IN ('information_schema','performance_schema','mysql','sys')
       ORDER BY TABLE_SCHEMA = ? DESC, TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION LIMIT ${MAX_COMPLETION_COLUMNS + 1}`,
      [ctx.database ?? ''],
    );
    const namespaces: CompletionSchema['namespaces'] = {};
    for (const r of rows.slice(0, MAX_COMPLETION_COLUMNS)) ((namespaces[r.s] ??= {})[r.t] ??= []).push(r.c);
    return { defaultNamespace: ctx.database, namespaces, truncated: rows.length > MAX_COMPLETION_COLUMNS };
  }

  openCursor(stmt: StatementInput, ctx: ExecContext, opts?: CursorOptions): QueryCursor {
    return new MysqlCursor(this, stmt, ctx, opts);
  }

  acquire(): Promise<PoolConnection> {
    return new Promise((resolve, reject) => this.pool().getConnection((err, c) => (err ? reject(err) : resolve(c))));
  }

  async killQuery(threadId: number): Promise<void> {
    const raw = mysql.createConnection({ ...this.connOptions(), database: undefined });
    raw.on('error', () => undefined);
    const c = raw.promise();
    try {
      await withTimeout(c.connect(), 10000, 'Cancel connection');
      await c.query(`KILL QUERY ${Number(threadId)}`);
    } finally {
      await withTimeout(c.end(), 2000, 'Close').catch(() => raw.destroy());
    }
  }

  async close(): Promise<void> {
    const p = this._pool;
    this._pool = undefined;
    if (p) await p.promise().end().catch(() => undefined);
  }
}

function formatMysqlDefault(def: string | null, dtype: string, extra: string | null): string | null {
  if (def === null || def === undefined) return null;
  if (/DEFAULT_GENERATED/i.test(extra ?? '')) return def; // expression default
  if (/^'.*'$/s.test(def)) return def; // MariaDB already quotes literals
  if (/^(tinyint|smallint|mediumint|int|integer|bigint|decimal|numeric|float|double|bit|year)$/i.test(dtype)) return def;
  if (/^NULL$/i.test(def)) return 'NULL';
  return `'${def.replace(/'/g, "''")}'`;
}

class MysqlCursor implements QueryCursor {
  private conn?: PoolConnection;
  private buf?: PullBuffer;
  private finished = false;
  private closed = false;
  private broken = false;
  private threadId?: number;

  constructor(
    private readonly owner: MysqlConnection,
    private readonly stmt: StatementInput,
    private readonly ctx: ExecContext,
    private readonly opts?: CursorOptions,
  ) {}

  private async start(): Promise<void> {
    this.opts?.onPhase?.('connecting');
    const conn = await this.owner.acquire();
    this.conn = conn;
    this.threadId = conn.threadId;
    if (this.ctx.database) {
      await conn.promise().query(`USE ${mysqlDialect.quoteIdent(this.ctx.database)}`);
    }
    if (this.closed) throw Object.assign(new Error('Query execution was interrupted'), { errno: 1317 });
    this.opts?.onPhase?.('running');
    const buf = new PullBuffer({ pause: () => conn.pause(), resume: () => conn.resume() });
    this.buf = buf;
    const values = (this.stmt.params ?? []).map((p) => p.value);
    const q = conn.query({ sql: this.stmt.sql, values, rowsAsArray: true } as any);
    q.on('fields', (fields: FieldPacket[]) => {
      if (!fields) return;
      buf.setColumns(fields.map((f) => {
        const type = fieldType(f);
        return { name: f.name, type, kind: kindFromTypeName(type) } satisfies ResultColumn;
      }));
    });
    q.on('result', (row: any) => {
      if (Array.isArray(row)) buf.push(row.map(toCell));
      else if (row && typeof row === 'object' && 'affectedRows' in row) {
        const h = row as ResultSetHeader;
        buf.rowsAffected = h.affectedRows;
        if (h.info) buf.notices.push(h.info);
        if ((h as any).warningStatus) buf.notices.push(`${(h as any).warningStatus} warning(s)`);
      }
    });
    q.on('error', (err: any) => {
      if (err?.fatal) this.broken = true;
      buf.fail(err);
    });
    q.on('end', () => {
      this.finished = true;
      buf.end();
    });
  }

  async fetch(maxRows: number): Promise<CursorChunk> {
    if (!this.buf) await this.start();
    const chunk = await this.buf!.take(maxRows);
    this.opts?.onPhase?.('fetching');
    if (chunk.done) await this.close();
    return chunk;
  }

  async cancel(): Promise<CancelRequestResult> {
    if (!this.conn) {
      this.closed = true;
      return 'not-running';
    }
    if (this.finished) return 'not-running';
    try {
      await this.owner.killQuery(this.threadId!);
      return 'requested';
    } catch {
      return 'failed';
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    const conn = this.conn;
    this.conn = undefined;
    if (!conn) return;
    if (!this.finished && !this.broken) {
      // Abandoning a streaming result: the remaining rows would still have to be read off the wire.
      // Kill the statement and drop the connection instead of draining a potentially huge result.
      try {
        await this.owner.killQuery(this.threadId!);
      } catch {
        /* ignore */
      }
      this.broken = true;
    }
    if (this.broken) conn.destroy();
    else conn.release();
  }
}

export const mysqlDriver: DriverModule = {
  id: 'mysql',
  dialect: mysqlDialect,
  capabilities: mysqlCapabilities,
  connect(profile: ConnectionProfile, secrets: Secrets): DriverConnection {
    if (profile.driver !== 'mysql') throw new Error('Profile is not a MySQL profile');
    return new MysqlConnection(profile, secrets);
  },
};

export default mysqlDriver;
