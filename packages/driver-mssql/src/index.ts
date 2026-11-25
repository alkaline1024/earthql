import sql from 'mssql';
import {
  CATEGORY_HINTS,
  Dialect,
  PullBuffer,
  binaryCell,
  classifyNodeError,
  executeAtomicGridUpdates,
  isGridText,
  makeError,
  formatUtcDate,
  formatUtcDateTime,
  formatUtcTime,
  isEarthQLError,
  kindFromTypeName,
  redactInfo,
  timedStep,
  withTimeout,
  MAX_COMPLETION_COLUMNS,
  type BuiltStatement,
  type CancelRequestResult,
  type Capabilities,
  type Cell,
  type ColumnInfo,
  type CompletionSchema,
  type ConnectionProfile,
  type ConstraintInfo,
  type CreateTableSpec,
  type CursorChunk,
  type CursorOptions,
  type DriverConnection,
  type DriverModule,
  type ErrorCategory,
  type ErrorInfo,
  type ExecContext,
  type IndexInfo,
  type InsertSpec,
  type MssqlProfile,
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

const MSSQL_TYPES: TypeOption[] = [
  { name: 'INT', group: 'number' },
  { name: 'BIGINT', group: 'number' },
  { name: 'SMALLINT', group: 'number' },
  { name: 'TINYINT', group: 'number' },
  { name: 'DECIMAL', group: 'number', params: 'precision_scale', defaultParams: '38,10' },
  { name: 'FLOAT', group: 'number' },
  { name: 'REAL', group: 'number' },
  { name: 'MONEY', group: 'number' },
  { name: 'NVARCHAR', group: 'text', params: 'length', defaultParams: '255' },
  { name: 'VARCHAR', group: 'text', params: 'length', defaultParams: '255' },
  { name: 'NCHAR', group: 'text', params: 'length', defaultParams: '1' },
  { name: 'NVARCHAR(MAX)', group: 'text' },
  { name: 'UNIQUEIDENTIFIER', group: 'text' },
  { name: 'BIT', group: 'bool' },
  { name: 'DATE', group: 'date' },
  { name: 'DATETIME2', group: 'date', params: 'precision', defaultParams: '7' },
  { name: 'DATETIMEOFFSET', group: 'date', params: 'precision', defaultParams: '7' },
  { name: 'TIME', group: 'date', params: 'precision', defaultParams: '7' },
  { name: 'DATETIME', group: 'date' },
  { name: 'VARBINARY', group: 'binary', params: 'length', defaultParams: 'MAX' },
];

const MAX_PARAMS = 2000; // SQL Server allows 2100 parameters per request

export class MssqlDialect extends Dialect {
  readonly driver = 'mssql' as const;
  readonly types = MSSQL_TYPES;
  readonly maxInsertRows = 1000;
  quoteIdent(name: string): string {
    return `[${name.replace(/]/g, ']]')}]`;
  }
  placeholder(i: number): string {
    return `@p${i}`;
  }
  stringLiteral(value: string): string {
    return `N'${value.replace(/'/g, "''")}'`;
  }
  castToText(expr: string): string {
    return `CAST(${expr} AS NVARCHAR(MAX))`;
  }
  ilike(textExpr: string, placeholder: string): string {
    return `${textExpr} LIKE ${placeholder}`;
  }
  likeCaseSensitive(textExpr: string, placeholder: string): string {
    return `${textExpr} COLLATE Latin1_General_CS_AS LIKE ${placeholder}`;
  }
  escapeLike(value: string): string {
    return value.replace(/[\\%_[]/g, (m) => '\\' + m);
  }
  pathParts(p: ObjectPath): string[] {
    return p.database ? [p.database, p.schema ?? 'dbo', p.name] : [p.schema ?? 'dbo', p.name];
  }
  displayTarget(p: ObjectPath): string {
    return this.pathParts(p).join('.');
  }
  paginate(base: string, orderBy: string, limit: number, offset: number): string {
    return `${base}${orderBy || ' ORDER BY (SELECT NULL)'} OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`;
  }
  protected stripPagination(s: string): string {
    return s.replace(/ ORDER BY \(SELECT NULL\) OFFSET \d+ ROWS FETCH NEXT \d+ ROWS ONLY$/, '').replace(/ OFFSET \d+ ROWS FETCH NEXT \d+ ROWS ONLY$/, '');
  }
  booleanLiteral(v: boolean): string {
    return v ? '1' : '0';
  }
  browseSelectExpr(column: Pick<ColumnInfo, 'name' | 'type'>): string {
    const q = this.quoteIdent(column.name);
    // MONEY arrives as a JS number and temporal values as JS Dates (millisecond precision): convert them server-side
    // to keep every digit. DECIMAL/NUMERIC are exact strings already (patched tedious) but converting is harmless.
    if (/^(money|smallmoney)\b/i.test(column.type)) return `CONVERT(VARCHAR(64), ${q}, 2) AS ${q}`;
    if (/^(decimal|numeric)\b/i.test(column.type)) return `CONVERT(VARCHAR(64), ${q}) AS ${q}`;
    if (/^(datetime2|datetimeoffset|time|datetime|smalldatetime|date)\b/i.test(column.type)) return `CONVERT(VARCHAR(40), ${q}, 121) AS ${q}`;
    return q;
  }
  insertValueExpr(placeholder: string, column: { type: string }): string {
    const type = column.type.trim();
    if (/^(var)?binary|^image/i.test(type)) return `CONVERT(VARBINARY(MAX), ${placeholder}, 1)`;
    // Parameters are NVARCHAR. Inside a multi-row VALUES list SQL Server converts them before it knows the target column
    // (e.g. to a default-precision numeric, overflowing DECIMAL(38,10)), so cast to the column's own type.
    if (/^(n?(var)?char|n?text|xml|sysname)\b/i.test(type) || !this.validateTypeName(type)) return placeholder;
    return `CAST(${placeholder} AS ${type})`;
  }
  gridUpdateMatch(column: ColumnInfo, placeholder: string, compareOriginal: boolean): string {
    if (compareOriginal && isGridText(column)) {
      // Comparing bytes plus length makes case and trailing spaces significant.
      const text = `CONVERT(NVARCHAR(MAX), ${this.quoteIdent(column.name)})`;
      return `CONVERT(VARBINARY(MAX), ${text}) = CONVERT(VARBINARY(MAX), ${placeholder}) AND DATALENGTH(${text}) = DATALENGTH(${placeholder})`;
    }
    return super.gridUpdateMatch(column, placeholder, compareOriginal);
  }
  buildInsert(spec: InsertSpec): BuiltStatement {
    const b = super.buildInsert(spec);
    if (b.params.length > MAX_PARAMS) b.errors.push(`SQL Server accepts at most ${MAX_PARAMS} values per statement; insert fewer rows at once.`);
    return b;
  }
  createTablePrefix(spec: CreateTableSpec): string {
    const create = `CREATE TABLE ${this.qualify(spec.object)}`;
    if (!spec.ifNotExists) return create;
    return `IF OBJECT_ID(${this.stringLiteral(this.qualify(spec.object))}, N'U') IS NULL\n${create}`;
  }
  validateTypeName(type: string): boolean {
    return /^[A-Za-z][A-Za-z0-9_ ]*(\(\s*(\d+|max|MAX)(\s*,\s*\d+)?\s*\))?$/.test(type.trim());
  }
}

export const mssqlDialect = new MssqlDialect();

export const mssqlCapabilities: Capabilities = {
  driver: 'mssql',
  hierarchy: ['database', 'schema', 'table'],
  cancel: 'server-confirmed',
  insert: true,
  createTable: true,
  columnDefaults: true,
  primaryKey: true,
  indexes: true,
  streamingExport: true,
  transactions: true,
  types: MSSQL_TYPES,
  quote: '[]',
  notes: [
    'SQL Server Authentication (SQL login) only in this version.',
    'DECIMAL/NUMERIC values are read exactly (EarthQL patches the tedious driver; see patches/). MONEY values in the SQL editor are JS numbers; table browsing converts them to text.',
  ],
};

// ---------------------------------------------------------------------------
// Types / values
// ---------------------------------------------------------------------------

function columnTypeName(col: any): string {
  const t = col?.type;
  const name: string = (t && (t.declaration || t.name)) || 'unknown';
  const n = String(name).toUpperCase();
  if (/^(N?VAR)?CHAR$|^N?VARCHAR$|^VARBINARY$|^BINARY$|^NCHAR$/.test(n)) {
    const len = col.length;
    if (len === undefined || len === null) return n;
    if (len === -1 || len > 8000 || len === 65535) return `${n}(MAX)`;
    return `${n}(${/^N/.test(n) && len > 4000 ? 'MAX' : len})`;
  }
  if (n === 'DECIMAL' || n === 'NUMERIC') return `${n}(${col.precision},${col.scale})`;
  return n;
}

function cellFor(v: unknown, typeName: string): Cell {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) {
    if (/^DATE$/.test(typeName)) return formatUtcDate(v);
    if (/^TIME/.test(typeName)) return formatUtcTime(v);
    if (/^DATETIMEOFFSET/.test(typeName)) return `${formatUtcDateTime(v)} +00:00`;
    return formatUtcDateTime(v);
  }
  if (typeof v === 'string' || typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : String(v);
  if (typeof v === 'bigint') return v.toString();
  if (Buffer.isBuffer(v)) return binaryCell(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

function sqlErrorNumber(e: any): number | undefined {
  const n = e?.number ?? e?.originalError?.info?.number ?? e?.originalError?.number ?? e?.precedingErrors?.[0]?.number;
  return typeof n === 'number' ? n : undefined;
}

function classifyMssql(e: any): ErrorCategory {
  const code = String(e?.code ?? '');
  const num = sqlErrorNumber(e);
  const msg = String(e?.message ?? '');
  if (code === 'ECANCEL') return 'cancelled';
  if (/certificate|self[- ]signed|SSL|TLS|secure channel|encrypt/i.test(msg) && code !== 'ELOGIN') return 'tls';
  if (num === 4060 || /Cannot open database/i.test(msg)) return 'permission';
  if (code === 'ELOGIN' || num === 18456 || num === 18452 || num === 18486 || num === 18487 || num === 18488) return 'auth';
  if (num !== undefined) {
    if ([229, 230, 262, 297, 300, 916, 15247, 3906, 15151, 1088, 2760].includes(num)) return 'permission';
    if ([208, 207, 911, 2812, 3701, 15009].includes(num)) return 'not_found';
    if ([102, 105, 156, 170, 319, 1038, 4145].includes(num)) return 'syntax';
    if ([2627, 2601, 515, 547, 8152, 2628, 245, 8114, 241, 8115, 220, 1205].includes(num)) return num === 1205 ? 'timeout' : 'constraint';
  }
  if (code === 'ETIMEOUT') return 'timeout';
  if (['ESOCKET', 'ECONNCLOSED', 'ENOTOPEN', 'EINSTLOOKUP', 'ECONNRESET'].includes(code)) return 'network';
  return classifyNodeError(e) ?? 'unknown';
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

class MssqlConnection implements DriverConnection {
  readonly driver = 'mssql' as const;
  readonly dialect = mssqlDialect;
  private readonly pools = new Map<string, Promise<sql.ConnectionPool>>();

  constructor(
    private readonly profile: MssqlProfile,
    private readonly secrets: Secrets,
  ) {}

  config(database = this.profile.database): sql.config {
    const tls = this.profile.tls;
    return {
      server: this.profile.host,
      port: this.profile.port || 1433,
      database: database || undefined,
      user: this.profile.user,
      password: this.secrets.password ?? '',
      connectionTimeout: 15000,
      requestTimeout: 0, // long-running statements are cancelled by the user, not by a timer
      pool: { max: 6, min: 0, idleTimeoutMillis: 60000 },
      options: {
        encrypt: tls.mode !== 'disable',
        trustServerCertificate: tls.mode === 'require',
        serverName: tls.serverName || undefined,
        cryptoCredentialsDetails: tls.mode === 'verify' && tls.caCert ? { ca: tls.caCert } : undefined,
        appName: 'EarthQL',
        useUTC: true,
        enableArithAbort: true,
      } as any,
    };
  }

  pool(database = this.profile.database): Promise<sql.ConnectionPool> {
    const key = database || '';
    let existing = this.pools.get(key);
    if (!existing) {
      const p = new sql.ConnectionPool(this.config(database));
      p.on('error', () => undefined);
      existing = p.connect().catch((e) => {
        this.pools.delete(key);
        throw e;
      });
      this.pools.set(key, existing);
    }
    return existing;
  }

  private async q<T = any>(text: string, params: Array<string | null> = [], db?: string): Promise<T[]> {
    const pool = await this.pool(db);
    const req = pool.request();
    params.forEach((v, i) => req.input(`p${i}`, sql.NVarChar(sql.MAX), v));
    const res = await req.query(text);
    return (res.recordset ?? []) as T[];
  }

  capabilities(): Capabilities {
    return mssqlCapabilities;
  }

  defaultContext(): ExecContext {
    return { database: this.profile.database || undefined };
  }

  classifyError(e: unknown): ErrorInfo {
    if (isEarthQLError(e)) return redactInfo(e.toInfo(), [this.secrets.password]);
    const anyE = e as any;
    const category = classifyMssql(anyE);
    const num = sqlErrorNumber(anyE);
    let message = String(anyE?.originalError?.message ?? anyE?.message ?? e);
    const line = anyE?.lineNumber ?? anyE?.originalError?.info?.lineNumber;
    if (category === 'syntax' && line) message += ` (line ${line})`;
    let hint = CATEGORY_HINTS[category];
    if (num === 4060) hint = 'The database does not exist or this login has no access to it.';
    const info: ErrorInfo = {
      category,
      message,
      code: [anyE?.code, num !== undefined ? `Msg ${num}` : undefined].filter(Boolean).join(' · ') || undefined,
      hint,
      driver: 'mssql',
    };
    return redactInfo(info, [this.secrets.password]);
  }

  async test(): Promise<TestResult> {
    const steps: TestStep[] = [];
    const pool = new sql.ConnectionPool({ ...this.config(), pool: { max: 1, min: 0 } });
    pool.on('error', () => undefined);
    try {
      await timedStep(steps, `Connect and sign in to ${this.profile.host}:${this.profile.port || 1433}`, () =>
        withTimeout(pool.connect(), 25000, 'Connection'),
      );
      const r = await timedStep(
        steps,
        `SELECT 1 on database "${this.profile.database || '(login default)'}"`,
        () => pool.request().query('SELECT 1 AS ok, DB_NAME() AS db, @@VERSION AS v'),
        (res) => `current database: ${res.recordset[0]?.db}`,
      );
      const enc = await pool
        .request()
        .query('SELECT encrypt_option FROM sys.dm_exec_connections WHERE session_id = @@SPID')
        .then((x) => (String(x.recordset[0]?.encrypt_option).toUpperCase() === 'TRUE' ? 'TLS on' : 'TLS off'))
        .catch(() => (this.profile.tls.mode === 'disable' ? undefined : 'TLS requested'));
      if (enc) steps.push({ name: 'Transport', ok: true, detail: enc, durationMs: 0 });
      const version = String(r.recordset[0]?.v ?? '').split('\n')[0].trim();
      return { ok: true, steps, serverVersion: version };
    } catch (e) {
      return { ok: false, steps, error: this.classifyError(e) };
    } finally {
      await pool.close().catch(() => undefined);
    }
  }

  async listChildren(parent: TreeNode | null): Promise<TreeNode[]> {
    if (!parent) {
      const [server] = await this.q<{ edition: number; current_database: string }>(
        `SELECT CAST(SERVERPROPERTY('EngineEdition') AS INT) AS edition, DB_NAME() AS current_database`,
      );
      const azure = server.edition === 5;
      const query = azure
        ? `SELECT name, CASE WHEN name = 'master' THEN 1 ELSE 0 END AS sys FROM sys.databases
           WHERE state = 0 ORDER BY CASE WHEN name = 'master' THEN 0 ELSE 1 END, name`
        : `SELECT name, CASE WHEN database_id <= 4 THEN 1 ELSE 0 END AS sys FROM sys.databases
           WHERE HAS_DBACCESS(name) = 1 AND state = 0 ORDER BY CASE WHEN database_id <= 4 THEN 1 ELSE 0 END, name`;
      let limited = false;
      let rows: { name: string; sys: number }[];
      try {
        rows = await this.q(query, [], azure && server.current_database !== 'master' ? 'master' : undefined);
      } catch (e) {
        if (!azure || server.current_database === 'master' || ![4060, 18456].includes(sqlErrorNumber(e) ?? 0)) throw e;
        rows = await this.q(query);
        limited = true;
      }
      return rows.map((r) => ({
        kind: 'database' as const,
        name: r.name,
        path: {},
        hasChildren: true,
        detail: limited && r.name === server.current_database ? 'Database list limited: cannot connect to master' : r.name === this.profile.database ? 'default' : r.sys ? 'system' : undefined,
      }));
    }
    if (parent.kind === 'database') {
      const db = parent.name;
      const rows = await this.q<{ name: string }>(
        `SELECT name FROM sys.schemas WHERE name NOT IN ('sys','INFORMATION_SCHEMA','guest') AND schema_id < 16384
         ORDER BY CASE WHEN name = 'dbo' THEN 0 ELSE 1 END, name`,
        [],
        db,
      );
      return rows.map((r) => ({ kind: 'schema' as const, name: r.name, path: { database: db }, hasChildren: true }));
    }
    if (parent.kind === 'schema') {
      const db = parent.path.database!;
      const rows = await this.q<{ name: string; type: string }>(
        `SELECT o.name, RTRIM(o.type) AS type FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id
         WHERE s.name = @p0 AND o.type IN ('U','V') AND o.is_ms_shipped = 0 ORDER BY o.name`,
        [parent.name],
        db,
      );
      return rows.map((r) => ({
        kind: r.type === 'V' ? ('view' as const) : ('table' as const),
        name: r.name,
        path: { database: db, schema: parent.name, name: r.name },
        hasChildren: false,
      }));
    }
    return [];
  }

  private objectName(o: ObjectPath): string {
    return `${this.dialect.quoteIdent(o.schema ?? 'dbo')}.${this.dialect.quoteIdent(o.name)}`;
  }

  async getStructure(object: ObjectPath): Promise<TableStructure> {
    const db = object.database || this.profile.database;
    const name = this.objectName(object);
    const obj = await this.q<{ id: number; type: string }>(`SELECT OBJECT_ID(@p0) AS id, RTRIM(CAST(OBJECTPROPERTYEX(OBJECT_ID(@p0), 'BaseType') AS NVARCHAR(10))) AS type`, [name], db);
    if (!obj[0] || obj[0].id === null) {
      return {
        object,
        kind: 'table',
        columns: [],
        columnsStatus: { state: 'denied', message: 'The object is not visible to this login (no permission, or it does not exist).' },
        indexes: [],
        indexesStatus: { state: 'denied', message: 'Not visible.' },
        constraints: [],
        constraintsStatus: { state: 'denied', message: 'Not visible.' },
      };
    }
    const id = String(obj[0].id);
    const kind = obj[0].type === 'V' ? 'view' : 'table';
    const cols = await this.q<any>(
      `SELECT c.column_id, c.name, t.name AS tname, c.max_length, c.precision, c.scale, c.is_nullable, c.is_identity, c.is_computed, c.generated_always_type,
              dc.definition AS def, cc.definition AS computed,
              CASE WHEN EXISTS (SELECT 1 FROM sys.index_columns ic JOIN sys.indexes i ON i.object_id = ic.object_id AND i.index_id = ic.index_id
                                WHERE i.is_primary_key = 1 AND ic.object_id = c.object_id AND ic.column_id = c.column_id) THEN 1 ELSE 0 END AS pk,
              CAST(ep.value AS NVARCHAR(4000)) AS comment
       FROM sys.columns c
       JOIN sys.types t ON t.user_type_id = c.user_type_id
       LEFT JOIN sys.default_constraints dc ON dc.object_id = c.default_object_id
       LEFT JOIN sys.computed_columns cc ON cc.object_id = c.object_id AND cc.column_id = c.column_id
       LEFT JOIN sys.extended_properties ep ON ep.major_id = c.object_id AND ep.minor_id = c.column_id AND ep.name = 'MS_Description' AND ep.class = 1
       WHERE c.object_id = CAST(@p0 AS INT) ORDER BY c.column_id`,
      [id],
      db,
    );
    const columns: ColumnInfo[] = cols.map((c, i) => {
      const type = formatSysType(c.tname, c.max_length, c.precision, c.scale);
      return {
        ordinal: i + 1,
        name: c.name,
        type,
        nullable: !!c.is_nullable,
        defaultValue: c.def ?? (c.computed ? `AS ${c.computed}` : c.is_identity ? 'IDENTITY' : null),
        isPrimaryKey: !!c.pk,
        isIdentity: !!c.is_identity,
        isGenerated: !!c.is_computed || !!c.generated_always_type || /^(rowversion|timestamp)$/i.test(type),
        comment: c.comment ?? null,
        kind: kindFromTypeName(type),
      };
    });

    let indexes: IndexInfo[] = [];
    let indexesStatus: SectionStatus = { state: 'ok' };
    try {
      const rows = await this.q<any>(
        `SELECT i.name, i.is_unique, i.is_primary_key, i.type_desc, c.name AS col, ic.key_ordinal, ic.is_included_column
         FROM sys.indexes i JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
         JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
         WHERE i.object_id = CAST(@p0 AS INT) AND i.type > 0 ORDER BY i.is_primary_key DESC, i.name, ic.is_included_column, ic.key_ordinal`,
        [id],
        db,
      );
      const map = new Map<string, IndexInfo>();
      for (const r of rows) {
        let idx = map.get(r.name);
        if (!idx) {
          idx = { name: r.name, unique: !!r.is_unique, primary: !!r.is_primary_key, columns: [], definition: String(r.type_desc) };
          map.set(r.name, idx);
        }
        idx.columns.push(r.is_included_column ? `${r.col} (included)` : r.col);
      }
      indexes = [...map.values()];
      if (indexes.length === 0) indexesStatus = { state: 'empty' };
    } catch (e) {
      indexesStatus = { state: 'denied', message: this.classifyError(e).message };
    }

    let constraints: ConstraintInfo[] = [];
    let constraintsStatus: SectionStatus = { state: 'ok' };
    try {
      const keys = await this.q<any>(
        `SELECT kc.name, kc.type_desc AS type, c.name AS col
         FROM sys.key_constraints kc
         JOIN sys.index_columns ic ON ic.object_id = kc.parent_object_id AND ic.index_id = kc.unique_index_id
         JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
         WHERE kc.parent_object_id = CAST(@p0 AS INT) AND ic.key_ordinal > 0 ORDER BY kc.type, kc.name, ic.key_ordinal`,
        [id],
        db,
      );
      const fks = await this.q<any>(
        `SELECT fk.name, pc.name AS col, OBJECT_SCHEMA_NAME(fk.referenced_object_id) + '.' + OBJECT_NAME(fk.referenced_object_id) AS ref, OBJECT_SCHEMA_NAME(fk.referenced_object_id) AS rschema, OBJECT_NAME(fk.referenced_object_id) AS rtable, rc.name AS rcol
         FROM sys.foreign_keys fk
         JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
         JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
         JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
         WHERE fk.parent_object_id = CAST(@p0 AS INT) ORDER BY fk.name, fkc.constraint_column_id`,
        [id],
        db,
      );
      const checks = await this.q<any>(`SELECT name, definition FROM sys.check_constraints WHERE parent_object_id = CAST(@p0 AS INT) ORDER BY name`, [id], db);
      const map = new Map<string, ConstraintInfo>();
      for (const r of keys) {
        const type = r.type === 'PRIMARY_KEY_CONSTRAINT' ? 'PRIMARY KEY' : 'UNIQUE';
        let c = map.get(r.name);
        if (!c) map.set(r.name, (c = { name: r.name, type, columns: [] }));
        c.columns.push(r.col);
      }
      for (const r of fks) {
        let c = map.get(r.name);
        if (!c) map.set(r.name, (c = { name: r.name, type: 'FOREIGN KEY', columns: [], references: r.ref }));
        c.columns.push(r.col);
        if (r.rschema && r.rtable && r.rcol) {
          c.foreignTarget ??= { object: { database: db, schema: r.rschema, name: r.rtable }, columns: [] };
          c.foreignTarget.columns.push(r.rcol);
        }
      }
      for (const r of checks) map.set(r.name, { name: r.name, type: 'CHECK', columns: [], definition: `CHECK ${r.definition}` });
      constraints = [...map.values()];
      if (constraints.length === 0) constraintsStatus = { state: 'empty' };
    } catch (e) {
      constraintsStatus = { state: 'denied', message: this.classifyError(e).message };
    }

    return {
      object,
      kind,
      columns,
      columnsStatus: columns.length ? { state: 'ok' } : { state: 'denied', message: 'No columns are visible to this login.' },
      indexes,
      indexesStatus,
      constraints,
      constraintsStatus,
      gridUpdate: obj[0].type === 'U',
    };
  }

  async getPrivileges(object: ObjectPath): Promise<ObjectPrivileges> {
    const db = object.database || this.profile.database;
    try {
      const [r] = await this.q<any>(
        `SELECT HAS_PERMS_BY_NAME(@p0, 'OBJECT', 'SELECT') AS sel, HAS_PERMS_BY_NAME(@p0, 'OBJECT', 'INSERT') AS ins, HAS_PERMS_BY_NAME(@p0, 'OBJECT', 'UPDATE') AS edit,
                HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'CREATE TABLE') AS cdb,
                HAS_PERMS_BY_NAME(@p1, 'SCHEMA', 'ALTER') AS asch,
                CAST(DATABASEPROPERTYEX(DB_NAME(), 'Updateability') AS NVARCHAR(20)) AS upd`,
        [this.objectName(object), object.schema ?? 'dbo'],
        db,
      );
      const ro = r.upd === 'READ_ONLY';
      const tri = (v: any) => (v === 1 ? 'yes' : v === 0 ? 'no' : 'unknown') as 'yes' | 'no' | 'unknown';
      const insert = ro ? 'no' : tri(r.ins);
      return {
        select: tri(r.sel),
        insert,
        update: ro ? 'no' : tri(r.edit),
        create: ro ? 'no' : r.cdb === 1 && r.asch === 1 ? 'yes' : r.cdb === 0 || r.asch === 0 ? 'no' : 'unknown',
        reason: ro ? 'The database is read-only.' : insert === 'no' ? 'This login has no INSERT permission on the object.' : undefined,
      };
    } catch {
      return { select: 'unknown', insert: 'unknown', create: 'unknown' };
    }
  }

  async executeTableStatements(object: ObjectPath, statements: string[], options: { disableForeignKeys: boolean }): Promise<void> {
    if (options.disableForeignKeys) throw makeError('unsupported', 'SQL Server cannot truncate a referenced table by disabling foreign key checks.');
    const transaction = new sql.Transaction(await this.pool(object.database));
    await transaction.begin();
    try {
      for (const statement of statements) await transaction.request().batch(statement);
      await transaction.commit();
    } catch (error) {
      await transaction.rollback().catch(() => undefined);
      throw error;
    }
  }

  async applyGridUpdates(object: ObjectPath, statements: StatementInput[]): Promise<void> {
    const transaction = new sql.Transaction(await this.pool(object.database));
    await executeAtomicGridUpdates(statements, {
      begin: () => transaction.begin(),
      update: async (statement) => {
        const params = statement.params ?? [];
        if (params.length > MAX_PARAMS) throw makeError('config', 'Too many columns were edited in one row.');
        const request = transaction.request();
        params.forEach(({ value }, index) => request.input(`p${index}`, sql.NVarChar(sql.MAX), value));
        const result = await request.query(`${statement.sql}; SELECT @@ROWCOUNT AS earthql_affected_rows;`);
        return Array.isArray(result.recordsets) ? result.recordsets.at(-1)?.[0]?.earthql_affected_rows : undefined;
      },
      commit: () => transaction.commit(),
      rollback: () => transaction.rollback(),
      classifyError: (error) => this.classifyError(error),
    });
  }

  async completionSchema(ctx: ExecContext): Promise<CompletionSchema> {
    const db = ctx.database || this.profile.database;
    const rows = await this.q<{ s: string; t: string; c: string }>(
      `SELECT TOP (${MAX_COMPLETION_COLUMNS + 1}) s.name AS s, o.name AS t, c.name AS c
       FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id JOIN sys.columns c ON c.object_id = o.object_id
       WHERE o.type IN ('U','V') AND o.is_ms_shipped = 0 ORDER BY s.name, o.name, c.column_id`,
      [],
      db,
    );
    const namespaces: CompletionSchema['namespaces'] = {};
    for (const r of rows.slice(0, MAX_COMPLETION_COLUMNS)) ((namespaces[r.s] ??= {})[r.t] ??= []).push(r.c);
    return { defaultNamespace: ctx.schema ?? 'dbo', namespaces, truncated: rows.length > MAX_COMPLETION_COLUMNS };
  }

  openCursor(stmt: StatementInput, ctx: ExecContext, opts?: CursorOptions): QueryCursor {
    return new MssqlCursor(this, stmt, ctx, opts);
  }

  async close(): Promise<void> {
    const pools = [...this.pools.values()];
    this.pools.clear();
    await Promise.all(pools.map((p) => p.then((x) => x.close()).catch(() => undefined)));
  }
}

function formatSysType(name: string, maxLength: number, precision: number, scale: number): string {
  const n = name.toLowerCase();
  if (['varchar', 'char', 'varbinary', 'binary'].includes(n)) return `${n}(${maxLength === -1 ? 'max' : maxLength})`;
  if (['nvarchar', 'nchar'].includes(n)) return `${n}(${maxLength === -1 ? 'max' : maxLength / 2})`;
  if (['decimal', 'numeric'].includes(n)) return `${n}(${precision},${scale})`;
  if (['datetime2', 'datetimeoffset', 'time'].includes(n)) return `${n}(${scale})`;
  return n;
}

class MssqlCursor implements QueryCursor {
  private request?: sql.Request;
  private buf?: PullBuffer;
  private finished = false;
  private closed = false;
  private recordsets = 0;
  private colTypes: string[] = [];

  constructor(
    private readonly owner: MssqlConnection,
    private readonly stmt: StatementInput,
    private readonly ctx: ExecContext,
    private readonly opts?: CursorOptions,
  ) {}

  private async start(): Promise<void> {
    this.opts?.onPhase?.('connecting');
    const pool = await this.owner.pool(this.ctx.database);
    if (this.closed) throw Object.assign(new Error('Canceled.'), { code: 'ECANCEL' });
    const req = pool.request();
    req.stream = true;
    (req as any).arrayRowMode = true;
    this.request = req;
    const params = this.stmt.params ?? [];
    params.forEach((p, i) => req.input(`p${i}`, sql.NVarChar(sql.MAX), p.value));
    const buf = new PullBuffer({ pause: () => req.pause(), resume: () => req.resume() });
    this.buf = buf;
    req.on('recordset', (cols: any) => {
      this.recordsets++;
      if (this.recordsets > 1) {
        if (this.recordsets === 2) buf.notices.push('The batch returned more than one result set; only the first is shown.');
        return;
      }
      const list: any[] = Array.isArray(cols) ? cols : Object.values(cols);
      this.colTypes = list.map(columnTypeName);
      const columns: ResultColumn[] = list.map((c, i) => ({ name: c.name, type: this.colTypes[i], kind: kindFromTypeName(this.colTypes[i]) }));
      buf.setColumns(columns);
    });
    req.on('row', (row: any[]) => {
      if (this.recordsets > 1) return;
      buf.push(row.map((v, i) => cellFor(v, this.colTypes[i] ?? '')));
    });
    req.on('rowsaffected', (n: number) => {
      buf.rowsAffected = (buf.rowsAffected ?? 0) + n;
    });
    req.on('info', (info: any) => {
      if (info?.message) buf.notices.push(String(info.message));
    });
    req.on('error', (err: any) => buf.fail(err));
    req.on('done', () => {
      this.finished = true;
      buf.end();
    });
    this.opts?.onPhase?.('running');
    req.query(this.stmt.sql);
  }

  async fetch(maxRows: number): Promise<CursorChunk> {
    if (!this.buf) await this.start();
    const chunk = await this.buf!.take(maxRows);
    this.opts?.onPhase?.('fetching');
    if (chunk.done) await this.close();
    return chunk;
  }

  async cancel(): Promise<CancelRequestResult> {
    if (!this.request) {
      this.closed = true;
      return 'not-running';
    }
    if (this.finished) return 'not-running';
    try {
      this.request.cancel();
      return 'requested';
    } catch {
      return 'failed';
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    const req = this.request;
    this.request = undefined;
    if (req && !this.finished) {
      // Stop a partially read stream: cancel the request so the connection goes back to the pool.
      try {
        req.cancel();
        req.resume();
      } catch {
        /* ignore */
      }
    }
  }
}

export const mssqlDriver: DriverModule = {
  id: 'mssql',
  dialect: mssqlDialect,
  capabilities: mssqlCapabilities,
  connect(profile: ConnectionProfile, secrets: Secrets): DriverConnection {
    if (profile.driver !== 'mssql') throw new Error('Profile is not a SQL Server profile');
    return new MssqlConnection(profile, secrets);
  },
};

export default mssqlDriver;
