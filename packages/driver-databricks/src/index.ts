import { DBSQLClient } from '@databricks/sql';
import type IDBSQLSession from '@databricks/sql/dist/contracts/IDBSQLSession';
import type IOperation from '@databricks/sql/dist/contracts/IOperation';
import {
  CATEGORY_HINTS,
  Dialect,
  binaryCell,
  classifyNodeError,
  formatUtcDateTime,
  isEarthQLError,
  makeError,
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
  type CreateTableSpec,
  type CursorChunk,
  type CursorOptions,
  type DatabricksProfile,
  type DriverConnection,
  type DriverModule,
  type ErrorCategory,
  type ErrorInfo,
  type ExecContext,
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

const DBX_TYPES: TypeOption[] = [
  { name: 'INT', group: 'number' },
  { name: 'BIGINT', group: 'number' },
  { name: 'SMALLINT', group: 'number' },
  { name: 'TINYINT', group: 'number' },
  { name: 'DECIMAL', group: 'number', params: 'precision_scale', defaultParams: '38,10' },
  { name: 'DOUBLE', group: 'number' },
  { name: 'FLOAT', group: 'number' },
  { name: 'STRING', group: 'text' },
  { name: 'VARCHAR', group: 'text', params: 'length', defaultParams: '255' },
  { name: 'BOOLEAN', group: 'bool' },
  { name: 'DATE', group: 'date' },
  { name: 'TIMESTAMP', group: 'date' },
  { name: 'TIMESTAMP_NTZ', group: 'date' },
  { name: 'BINARY', group: 'binary' },
];

export class DatabricksDialect extends Dialect {
  readonly driver = 'databricks' as const;
  readonly types = DBX_TYPES;
  quoteIdent(name: string): string {
    return '`' + name.replace(/`/g, '``') + '`';
  }
  placeholder(i: number): string {
    return `:p${i}`;
  }
  stringLiteral(value: string): string {
    // Spark SQL string literals process backslash escapes.
    return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  }
  castToText(expr: string): string {
    return `CAST(${expr} AS STRING)`;
  }
  ilike(textExpr: string, placeholder: string): string {
    return `${textExpr} ILIKE ${placeholder}`;
  }
  likeEscapeClause(): string {
    return ''; // backslash is the default escape character
  }
  pathParts(p: ObjectPath): string[] {
    return [p.catalog, p.schema, p.name].filter((x): x is string => !!x);
  }
  insertValueExpr(placeholder: string, column: { type: string }): string {
    // Parameters are bound as STRING; ANSI store assignment does not cast strings to other types implicitly.
    if (/^(string|varchar|char)\b/i.test(column.type.trim())) return placeholder;
    return `CAST(${placeholder} AS ${column.type.trim()})`;
  }
  literalForType(value: string, type: string): string {
    const base = super.literalForType(value, type);
    if (base.startsWith("'") && !/^(string|varchar|char)\b/i.test(type.trim())) return `CAST(${base} AS ${type.trim()})`;
    return base;
  }
  primaryKeyClause(spec: CreateTableSpec, pk: ColumnSpec[]): string {
    const name = `pk_${spec.object.name}`.replace(/[^A-Za-z0-9_]/g, '_');
    return `CONSTRAINT ${this.quoteIdent(name)} PRIMARY KEY (${pk.map((c) => this.quoteIdent(c.name)).join(', ')})`;
  }
  createTableSuffix(spec: CreateTableSpec): string {
    const parts: string[] = [];
    if (spec.comment) parts.push(`\nCOMMENT ${this.stringLiteral(spec.comment)}`);
    // Column defaults on Delta tables need the allowColumnDefaults table feature.
    if (spec.columns.some((c) => c.default.kind !== 'none')) parts.push(`\nTBLPROPERTIES ('delta.feature.allowColumnDefaults' = 'supported')`);
    return parts.join('');
  }
  validateCreate(spec: CreateTableSpec) {
    const r = super.validateCreate(spec);
    if (!spec.object.catalog || !spec.object.schema) r.errors.push('Choose a catalog and schema.');
    return r;
  }
}

export const databricksDialect = new DatabricksDialect();

export const databricksCapabilities: Capabilities = {
  driver: 'databricks',
  hierarchy: ['catalog', 'schema', 'table'],
  cancel: 'server-confirmed',
  insert: true,
  createTable: true,
  columnDefaults: true,
  primaryKey: true,
  indexes: false,
  streamingExport: true,
  transactions: false,
  types: DBX_TYPES,
  quote: '`',
  notes: [
    'Primary and foreign keys in Unity Catalog are informational (not enforced).',
    'Column defaults enable the Delta table feature allowColumnDefaults.',
    'Rows are returned keyed by column name: alias duplicate column names to see each of them.',
  ],
};

// ---------------------------------------------------------------------------
// Types / values
// ---------------------------------------------------------------------------

const TYPE_IDS: Record<number, string> = {
  0: 'BOOLEAN',
  1: 'TINYINT',
  2: 'SMALLINT',
  3: 'INT',
  4: 'BIGINT',
  5: 'FLOAT',
  6: 'DOUBLE',
  7: 'STRING',
  8: 'TIMESTAMP',
  9: 'BINARY',
  10: 'ARRAY',
  11: 'MAP',
  12: 'STRUCT',
  13: 'UNION',
  14: 'USER_DEFINED',
  15: 'DECIMAL',
  16: 'VOID',
  17: 'DATE',
  18: 'VARCHAR',
  19: 'CHAR',
  20: 'INTERVAL YEAR TO MONTH',
  21: 'INTERVAL DAY TO SECOND',
};

function schemaColumns(schema: any): ResultColumn[] {
  const cols: any[] = schema?.columns ?? [];
  return cols.map((c) => {
    const entry = c.typeDesc?.types?.[0]?.primitiveEntry;
    let type = TYPE_IDS[entry?.type] ?? (c.typeDesc?.types?.[0]?.arrayEntry ? 'ARRAY' : 'UNKNOWN');
    const q = entry?.typeQualifiers?.qualifiers;
    if (type === 'DECIMAL' && q) type = `DECIMAL(${q.precision?.i32Value ?? ''},${q.scale?.i32Value ?? ''})`;
    return { name: String(c.columnName), type, kind: kindFromTypeName(type) };
  });
}

function toCell(v: unknown): Cell {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' || typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : String(v);
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Date) return formatUtcDateTime(v);
  if (v instanceof Uint8Array) return binaryCell(v);
  try {
    return JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));
  } catch {
    return String(v);
  }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

function errorText(e: any): string {
  const parts = [
    e?.response?.displayMessage,
    e?.response?.errorMessage,
    e?.message,
    e?.response?.status?.errorMessage,
  ].filter((x) => typeof x === 'string' && x.length > 0);
  return [...new Set(parts)].join('\n') || String(e);
}

function httpStatus(e: any): number | undefined {
  const s = e?.statusCode ?? e?.status ?? e?.response?.statusCode ?? e?.cause?.statusCode;
  if (typeof s === 'number') return s;
  const m = /\b(?:status(?: code)?|HTTP)\s*:?\s*(\d{3})\b/i.exec(String(e?.message ?? ''));
  return m ? Number(m[1]) : undefined;
}

export function classifyDatabricks(e: any): ErrorCategory {
  const name = String(e?.name ?? e?.constructor?.name ?? '');
  const msg = errorText(e);
  if (e?.errorCode === 'CANCELED' || /CANCELED|cancelled by user|OPERATION_CANCELED/i.test(msg)) return 'cancelled';
  if (e?.errorCode === 'TIMEOUT') return 'timeout';
  // Warehouse / object permissions (authenticated, but not allowed).
  if (/PERMISSION_DENIED|INSUFFICIENT_PERMISSIONS|does not have (?:permission|CAN_USE|USE CATALOG|USE SCHEMA|SELECT|MODIFY)|not authorized to|User does not have/i.test(msg))
    return 'permission';
  const status = httpStatus(e);
  if (status === 403) return /token|credential|invalid|expired/i.test(msg) ? 'auth' : 'permission';
  if (status === 401 || name === 'AuthenticationError') return 'auth';
  if (/invalid_client|invalid_grant|unauthorized_client|invalid access token|token (?:is )?expired|Invalid token|Unauthorized|UNAUTHENTICATED|Credential was not sent|not authenticated/i.test(msg))
    return 'auth';
  if (/PARSE_SYNTAX_ERROR|SYNTAX_ERROR|ParseException/i.test(msg)) return 'syntax';
  if (/TABLE_OR_VIEW_NOT_FOUND|SCHEMA_NOT_FOUND|CATALOG_NOT_FOUND|UNRESOLVED_COLUMN|NO_SUCH_CATALOG|ROUTINE_NOT_FOUND|RESOURCE_DOES_NOT_EXIST/i.test(msg))
    return 'not_found';
  if (/DELTA_NOT_NULL_CONSTRAINT|CAST_INVALID_INPUT|NUMERIC_VALUE_OUT_OF_RANGE|CONSTRAINT|DATATYPE_MISMATCH|INVALID_DEFAULT_VALUE/i.test(msg)) return 'constraint';
  if (status === 404) return 'not_found';
  if (status && status >= 500) return 'network';
  return classifyNodeError(e) ?? 'unknown';
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

const OP_STATE = { INITIALIZED: 0, RUNNING: 1, FINISHED: 2, CANCELED: 3, CLOSED: 4, ERROR: 5, UNKNOWN: 6, PENDING: 7, TIMEDOUT: 8 };

function normalizeHost(h: string): string {
  return h.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
}

function normalizePath(p: string): string {
  const t = p.trim();
  return t.startsWith('/') ? t : `/${t}`;
}

class DatabricksConnection implements DriverConnection {
  readonly driver = 'databricks' as const;
  readonly dialect = databricksDialect;
  private client?: Promise<DBSQLClient>;
  private sessions = new Map<string, Promise<IDBSQLSession>>();

  constructor(
    private readonly profile: DatabricksProfile,
    private readonly secrets: Secrets,
  ) {}

  private secretList(): string[] {
    return [this.secrets.accessToken, this.secrets.clientSecret].filter((x): x is string => !!x);
  }

  connectOptions(): any {
    const host = normalizeHost(this.profile.host);
    const path = normalizePath(this.profile.httpPath);
    const base = {
      host,
      path,
      userAgentEntry: 'EarthQL',
      preserveBigNumericPrecision: true,
      telemetryEnabled: false,
    };
    if (!host) throw makeError('config', 'Server Hostname is required');
    if (!this.profile.httpPath.trim()) throw makeError('config', 'HTTP Path is required');
    if (this.profile.authMode === 'oauth-m2m') {
      if (!this.profile.clientId || !this.secrets.clientSecret) {
        throw makeError('config', 'OAuth M2M needs a client ID and client secret');
      }
      const azure = /azuredatabricks\.net$/i.test(host);
      return {
        ...base,
        authType: 'databricks-oauth',
        oauthClientId: this.profile.clientId,
        oauthClientSecret: this.secrets.clientSecret,
        // The driver requests a token with the client credentials grant and requests a new one when it expires.
        ...(azure ? (this.profile.azureTenantId ? { azureTenantId: this.profile.azureTenantId } : { useDatabricksOAuthInAzure: true }) : {}),
      };
    }
    if (!this.secrets.accessToken) throw makeError('config', 'Access token is required');
    // PATs and OAuth bearer tokens are both sent as "Authorization: Bearer <token>".
    return { ...base, authType: 'access-token', token: this.secrets.accessToken };
  }

  private newClient(): DBSQLClient {
    const client = new DBSQLClient({ logger: silentLogger as any });
    // Ask the server for timestamps, decimals and complex types as text so every digit and the server's formatting are kept.
    const cfg = (client as any).config;
    if (cfg) {
      cfg.useArrowNativeTypes = false;
      cfg.telemetryEnabled = false;
    }
    client.on('error', () => undefined);
    return client;
  }

  private getClient(): Promise<DBSQLClient> {
    if (!this.client) {
      this.client = (async () => {
        const c = this.newClient();
        await c.connect(this.connectOptions());
        return c;
      })().catch((e) => {
        this.client = undefined;
        throw e;
      });
    }
    return this.client;
  }

  /** One session per (catalog, schema) context; opening a session also waits for a stopped warehouse to start. */
  session(ctx: ExecContext): Promise<IDBSQLSession> {
    const catalog = ctx.catalog ?? this.profile.catalog;
    const schema = ctx.schema ?? (ctx.catalog && ctx.catalog !== this.profile.catalog ? undefined : this.profile.schema);
    const key = `${catalog ?? ''}\u0000${schema ?? ''}`;
    let s = this.sessions.get(key);
    if (!s) {
      s = (async () => {
        const client = await this.getClient();
        return client.openSession({ initialCatalog: catalog || undefined, initialSchema: schema || undefined });
      })().catch((e) => {
        this.sessions.delete(key);
        throw e;
      });
      this.sessions.set(key, s);
    }
    return s;
  }

  /** Drop a session that the server no longer recognises (e.g. expired after idling). */
  invalidate(ctx: ExecContext): void {
    const catalog = ctx.catalog ?? this.profile.catalog;
    const schema = ctx.schema ?? (ctx.catalog && ctx.catalog !== this.profile.catalog ? undefined : this.profile.schema);
    this.sessions.delete(`${catalog ?? ''}\u0000${schema ?? ''}`);
  }

  capabilities(): Capabilities {
    return databricksCapabilities;
  }

  defaultContext(): ExecContext {
    return { catalog: this.profile.catalog || undefined, schema: this.profile.schema || undefined };
  }

  classifyError(e: unknown): ErrorInfo {
    if (isEarthQLError(e)) return redactInfo(e.toInfo(), this.secretList());
    const anyE = e as any;
    const category: ErrorCategory = classifyDatabricks(anyE);
    let hint = CATEGORY_HINTS[category];
    if (category === 'auth') {
      hint =
        this.profile.authMode === 'access-token'
          ? 'The access token was rejected or has expired. Edit the token in this profile and connect again.'
          : 'The service principal credentials were rejected. Check the client ID and client secret.';
    }
    if (category === 'permission' && /warehouse|CAN_USE|endpoint/i.test(errorText(anyE))) {
      hint = 'The credentials are valid, but this identity is not allowed to use the SQL warehouse. Ask for CAN USE on the warehouse.';
    }
    const info: ErrorInfo = {
      category,
      message: errorText(anyE),
      code: anyE?.errorCode ?? (httpStatus(anyE) ? `HTTP ${httpStatus(anyE)}` : anyE?.response?.sqlState ?? anyE?.code),
      hint,
      driver: 'databricks',
    };
    return redactInfo(info, this.secretList());
  }

  private async q(sqlText: string, params: Record<string, string> = {}, ctx: ExecContext = {}): Promise<any[]> {
    const session = await this.session(ctx);
    const op = await session.executeStatement(sqlText, { namedParameters: params, runAsync: true });
    try {
      return (await op.fetchAll()) as any[];
    } finally {
      await op.close().catch(() => undefined);
    }
  }

  async test(): Promise<TestResult> {
    const steps: TestStep[] = [];
    const client = this.newClient();
    try {
      const opts = this.connectOptions();
      await timedStep(steps, `Connect to ${opts.host} (${this.profile.authMode === 'oauth-m2m' ? 'OAuth M2M' : 'access token'})`, () =>
        withTimeout(client.connect(opts), 30000, 'Connection'),
      );
      const session = await timedStep(
        steps,
        'Open session on the SQL warehouse (waits if the warehouse is starting)',
        () =>
          withTimeout(
            client.openSession({ initialCatalog: this.profile.catalog || undefined, initialSchema: this.profile.schema || undefined }),
            10 * 60 * 1000,
            'Opening a session',
          ),
      );
      try {
        await timedStep(steps, 'SELECT 1', async () => {
          const op = await session.executeStatement('SELECT 1 AS ok', { runAsync: true });
          try {
            return await op.fetchAll();
          } finally {
            await op.close().catch(() => undefined);
          }
        });
        const v = await (async () => {
          const op = await session.executeStatement('SELECT current_version().dbsql_version AS v, current_catalog() AS c, current_user() AS u', { runAsync: true });
          try {
            return ((await op.fetchAll()) as any[])[0];
          } finally {
            await op.close().catch(() => undefined);
          }
        })().catch(() => undefined);
        if (v) steps.push({ name: 'Identity', ok: true, detail: `${v.u} · catalog ${v.c}`, durationMs: 0 });
        return { ok: true, steps, serverVersion: v?.v ? `Databricks SQL ${v.v}` : 'Databricks SQL' };
      } finally {
        await session.close().catch(() => undefined);
      }
    } catch (e) {
      return { ok: false, steps, error: this.classifyError(e) };
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  async listChildren(parent: TreeNode | null): Promise<TreeNode[]> {
    if (!parent) {
      const rows = await this.q('SHOW CATALOGS');
      return rows
        .map((r) => String(r.catalog ?? Object.values(r)[0]))
        .sort((a, b) => (a === 'system' ? 1 : b === 'system' ? -1 : a.localeCompare(b)))
        .map((c) => ({
          kind: 'catalog' as const,
          name: c,
          path: {},
          hasChildren: true,
          detail: c === this.profile.catalog ? 'default' : c === 'system' ? 'system' : undefined,
        }));
    }
    if (parent.kind === 'catalog') {
      const rows = await this.q(`SHOW SCHEMAS IN ${this.dialect.quoteIdent(parent.name)}`);
      return rows
        .map((r) => String(r.databaseName ?? r.namespace ?? Object.values(r)[0]))
        .filter((s) => s !== 'information_schema')
        .map((s) => ({ kind: 'schema' as const, name: s, path: { catalog: parent.name }, hasChildren: true }));
    }
    if (parent.kind === 'schema') {
      const catalog = parent.path.catalog!;
      const schema = parent.name;
      try {
        const rows = await this.q(
          `SELECT table_name, table_type FROM ${this.dialect.quoteIdent(catalog)}.information_schema.tables WHERE table_schema = :s ORDER BY table_name`,
          { s: schema },
        );
        return rows.map((r) => ({
          kind: /VIEW/i.test(r.table_type) && !/MATERIALIZED/i.test(r.table_type) ? ('view' as const) : ('table' as const),
          name: r.table_name,
          path: { catalog, schema, name: r.table_name },
          hasChildren: false,
          detail: /MATERIALIZED/i.test(r.table_type) ? 'materialized' : /STREAMING/i.test(r.table_type) ? 'streaming' : /EXTERNAL/i.test(r.table_type) ? 'external' : undefined,
        }));
      } catch {
        // hive_metastore and other catalogs without information_schema
        const tables = await this.q(`SHOW TABLES IN ${this.dialect.quoteIdent(catalog)}.${this.dialect.quoteIdent(schema)}`);
        const views = new Set(
          (await this.q(`SHOW VIEWS IN ${this.dialect.quoteIdent(catalog)}.${this.dialect.quoteIdent(schema)}`).catch(() => [])).map((r: any) => r.viewName),
        );
        return tables
          .filter((r) => !r.isTemporary)
          .map((r) => ({
            kind: views.has(r.tableName) ? ('view' as const) : ('table' as const),
            name: r.tableName,
            path: { catalog, schema, name: r.tableName },
            hasChildren: false,
          }));
      }
    }
    return [];
  }

  async getStructure(object: ObjectPath): Promise<TableStructure> {
    const catalog = object.catalog ?? this.profile.catalog;
    const schema = object.schema ?? this.profile.schema;
    if (!catalog || !schema) throw makeError('config', 'Catalog and schema are required');
    const cat = this.dialect.quoteIdent(catalog);
    let kind: 'table' | 'view' = 'table';
    let columns: ColumnInfo[] = [];
    let columnsStatus: SectionStatus = { state: 'ok' };
    let constraints: ConstraintInfo[] = [];
    let constraintsStatus: SectionStatus = { state: 'ok' };
    let pk = new Set<string>();

    try {
      const t = await this.q(`SELECT table_type FROM ${cat}.information_schema.tables WHERE table_schema = :s AND table_name = :t`, { s: schema, t: object.name });
      if (t[0] && /VIEW/i.test(t[0].table_type) && !/MATERIALIZED/i.test(t[0].table_type)) kind = 'view';

      try {
        const rows = await this.q(
          `SELECT tc.constraint_name, tc.constraint_type, k.column_name, k.ordinal_position,
                  rc.unique_constraint_catalog, rc.unique_constraint_schema, rc.unique_constraint_name
           FROM ${cat}.information_schema.table_constraints tc
           LEFT JOIN ${cat}.information_schema.key_column_usage k
             ON k.constraint_catalog = tc.constraint_catalog AND k.constraint_schema = tc.constraint_schema AND k.constraint_name = tc.constraint_name
           LEFT JOIN ${cat}.information_schema.referential_constraints rc
             ON rc.constraint_catalog = tc.constraint_catalog AND rc.constraint_schema = tc.constraint_schema AND rc.constraint_name = tc.constraint_name
           WHERE tc.table_schema = :s AND tc.table_name = :t ORDER BY tc.constraint_type, tc.constraint_name, k.ordinal_position`,
          { s: schema, t: object.name },
        );
        const map = new Map<string, ConstraintInfo>();
        for (const r of rows) {
          let c = map.get(r.constraint_name);
          if (!c)
            map.set(
              r.constraint_name,
              (c = {
                name: r.constraint_name,
                type: `${r.constraint_type} (informational)`,
                columns: [],
                references: r.unique_constraint_name ? `${r.unique_constraint_catalog}.${r.unique_constraint_schema} · ${r.unique_constraint_name}` : undefined,
              }),
            );
          if (r.column_name) c.columns.push(r.column_name);
          if (r.constraint_type === 'PRIMARY KEY' && r.column_name) pk.add(r.column_name);
        }
        constraints = [...map.values()];
        if (constraints.length === 0) constraintsStatus = { state: 'empty' };
      } catch (e) {
        constraintsStatus = { state: 'denied', message: this.classifyError(e).message };
      }

      const cols = await this.q(
        `SELECT column_name, full_data_type, is_nullable, column_default, comment, ordinal_position
         FROM ${cat}.information_schema.columns WHERE table_schema = :s AND table_name = :t ORDER BY ordinal_position`,
        { s: schema, t: object.name },
      );
      columns = cols.map((c, i) => ({
        ordinal: i + 1,
        name: c.column_name,
        type: String(c.full_data_type).toUpperCase(),
        nullable: c.is_nullable === 'YES',
        defaultValue: c.column_default ?? null,
        isPrimaryKey: pk.has(c.column_name),
        comment: c.comment ?? null,
        kind: kindFromTypeName(String(c.full_data_type)),
      }));
      if (columns.length === 0) {
        columnsStatus = t.length === 0 ? { state: 'denied', message: 'The table is not visible to this identity (no privileges, or it does not exist).' } : { state: 'empty' };
      }
    } catch (e) {
      // No information_schema (hive_metastore): fall back to DESCRIBE.
      const info = this.classifyError(e);
      if (info.category === 'permission') {
        columnsStatus = { state: 'denied', message: info.message };
      } else {
        try {
          const rows = await this.q(`DESCRIBE TABLE ${this.dialect.qualify({ catalog, schema, name: object.name })}`);
          const out: ColumnInfo[] = [];
          for (const r of rows) {
            const name = String(r.col_name ?? '');
            if (!name || name.startsWith('#')) break;
            out.push({ ordinal: out.length + 1, name, type: String(r.data_type).toUpperCase(), nullable: null, defaultValue: null, isPrimaryKey: false, comment: r.comment ?? null, kind: kindFromTypeName(String(r.data_type)) });
          }
          columns = out;
          constraintsStatus = { state: 'unsupported', message: 'Constraints are only listed for Unity Catalog tables.' };
        } catch (e2) {
          const i2 = this.classifyError(e2);
          if (i2.category === 'permission') columnsStatus = { state: 'denied', message: i2.message };
          else throw e2;
        }
      }
    }

    return {
      object,
      kind,
      columns,
      columnsStatus,
      indexes: [],
      indexesStatus: { state: 'unsupported', message: 'Databricks tables do not have indexes.' },
      constraints,
      constraintsStatus,
    };
  }

  async getPrivileges(): Promise<ObjectPrivileges> {
    // Grants in Unity Catalog can come through groups and inherited securables; the warehouse enforces them on write.
    return { select: 'unknown', insert: 'unknown', create: 'unknown' };
  }

  async completionSchema(ctx: ExecContext): Promise<CompletionSchema> {
    const catalog = ctx.catalog ?? this.profile.catalog;
    if (!catalog) return { namespaces: {}, truncated: false };
    const rows = await this.q(
      `SELECT table_schema AS s, table_name AS t, column_name AS c FROM ${this.dialect.quoteIdent(catalog)}.information_schema.columns
       WHERE table_schema <> 'information_schema' ORDER BY table_schema, table_name, ordinal_position LIMIT ${MAX_COMPLETION_COLUMNS + 1}`,
    ).catch(() => []);
    const namespaces: CompletionSchema['namespaces'] = {};
    for (const r of rows.slice(0, MAX_COMPLETION_COLUMNS)) ((namespaces[r.s] ??= {})[r.t] ??= []).push(r.c);
    return { defaultNamespace: ctx.schema ?? this.profile.schema, namespaces, truncated: rows.length > MAX_COMPLETION_COLUMNS };
  }

  openCursor(stmt: StatementInput, ctx: ExecContext, opts?: CursorOptions): QueryCursor {
    return new DatabricksCursor(this, stmt, ctx, opts);
  }

  async close(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(sessions.map((s) => s.then((x) => x.close()).catch(() => undefined)));
    const c = this.client;
    this.client = undefined;
    if (c) await c.then((x) => x.close()).catch(() => undefined);
  }
}

const silentLogger = {
  log: () => undefined,
};

class DatabricksCursor implements QueryCursor {
  private op?: IOperation;
  private starting?: Promise<void>;
  private columns: ResultColumn[] | null = null;
  private closed = false;
  private finished = false;
  private cancelRequested = false;
  private notices: string[] = [];

  constructor(
    private readonly owner: DatabricksConnection,
    private readonly stmt: StatementInput,
    private readonly ctx: ExecContext,
    private readonly opts?: CursorOptions,
  ) {}

  private async start(): Promise<void> {
    this.opts?.onPhase?.('waiting-warehouse');
    let session: IDBSQLSession;
    session = await this.owner.session(this.ctx);
    if (this.cancelRequested) throw Object.assign(new Error('Statement was canceled'), { errorCode: 'CANCELED' });
    this.opts?.onPhase?.('queued');
    const namedParameters: Record<string, string> = {};
    (this.stmt.params ?? []).forEach((p, i) => {
      if (p.value !== null) namedParameters[`p${i}`] = p.value;
    });
    const execute = (s: IDBSQLSession) =>
      s.executeStatement(this.stmt.sql, {
        runAsync: true,
        namedParameters: Object.keys(namedParameters).length ? namedParameters : undefined,
        maxRows: 1000,
      });
    try {
      this.op = await execute(session);
    } catch (e) {
      // An idle session may have expired server-side: reopen once.
      if (/session.*(not found|expired|closed|invalid)|Invalid SessionHandle/i.test(errorText(e))) {
        this.owner.invalidate(this.ctx);
        session = await this.owner.session(this.ctx);
        this.op = await execute(session);
      } else throw e;
    }
    if (this.cancelRequested) await this.op.cancel().catch(() => undefined);
  }

  private onStatus = (s: any) => {
    const state = s?.operationState;
    if (state === OP_STATE.PENDING || state === OP_STATE.INITIALIZED) this.opts?.onPhase?.('queued');
    else if (state === OP_STATE.RUNNING) this.opts?.onPhase?.('running');
  };

  async fetch(maxRows: number): Promise<CursorChunk> {
    if (!this.starting) this.starting = this.start();
    await this.starting;
    const op = this.op!;
    const rowsRaw = (await op.fetchChunk({ maxRows: Math.max(1, maxRows), progress: true, callback: this.onStatus } as any)) as any[];
    if (!this.columns) {
      const schema = await op.getSchema();
      if (schema && (schema as any).columns?.length) {
        this.columns = schemaColumns(schema);
        const seen = new Set<string>();
        const dupes = new Set<string>();
        for (const c of this.columns) (seen.has(c.name) ? dupes : seen).add(c.name);
        if (dupes.size)
          this.notices.push(
            `Duplicate column names (${[...dupes].join(', ')}): the Databricks driver returns rows keyed by name, so only one value per name is available. Alias the columns to see each one.`,
          );
      }
    }
    this.opts?.onPhase?.('fetching');
    const more = await op.hasMoreRows();
    const cols = this.columns;
    // DDL/DML on Databricks returns a small result (e.g. num_affected_rows); expose it as rowsAffected when present.
    let rowsAffected: number | undefined;
    if (cols && cols.length > 0 && cols.some((c) => c.name === 'num_affected_rows') && rowsRaw.length === 1) {
      rowsAffected = Number(rowsRaw[0].num_affected_rows);
    }
    const rows = cols ? rowsRaw.map((r) => cols.map((c) => toCell(r[c.name]))) : [];
    const done = !more;
    const chunk: CursorChunk = {
      columns: cols && cols.length > 0 ? cols : null,
      rows,
      done,
      rowsAffected,
      notices: this.notices.length ? this.notices.splice(0) : undefined,
    };
    if (done) {
      this.finished = true;
      await this.close();
    }
    return chunk;
  }

  async cancel(): Promise<CancelRequestResult> {
    this.cancelRequested = true;
    if (!this.op) return this.starting ? 'requested' : 'not-running';
    if (this.finished) return 'not-running';
    try {
      await this.op.cancel();
      return 'requested';
    } catch {
      return 'failed';
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const op = this.op;
    if (!op) return;
    if (!this.finished) await op.cancel().catch(() => undefined);
    await op.close().catch(() => undefined);
  }
}

export const databricksDriver: DriverModule = {
  id: 'databricks',
  dialect: databricksDialect,
  capabilities: databricksCapabilities,
  connect(profile: ConnectionProfile, secrets: Secrets): DriverConnection {
    if (profile.driver !== 'databricks') throw new Error('Profile is not a Databricks profile');
    return new DatabricksConnection(profile, secrets);
  },
};

export default databricksDriver;
