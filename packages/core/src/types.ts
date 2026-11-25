// Shared contracts between the UI, the Electron main process and the driver adapters.
// Everything here must be structured-clone friendly (it crosses the IPC boundary).

export type DriverId = 'postgres' | 'mysql' | 'databricks' | 'mssql';

export const DRIVER_LABELS: Record<DriverId, string> = {
  postgres: 'PostgreSQL',
  mysql: 'MySQL',
  databricks: 'Databricks',
  mssql: 'Microsoft SQL Server',
};

// ---------------------------------------------------------------------------
// Connection profiles
// ---------------------------------------------------------------------------

/** disable: plain TCP. require: encrypt, do not verify the certificate. verify: encrypt and verify against the system/CA bundle. */
export type TlsMode = 'disable' | 'require' | 'verify';

export interface TlsOptions {
  mode: TlsMode;
  /** PEM encoded CA certificate(s) used when mode === 'verify'. Optional. */
  caCert?: string;
  /** Override the server name used for certificate verification. */
  serverName?: string;
}

export interface EnvironmentTag {
  /** Free text shown on tabs and write confirmations, e.g. "Production". */
  name: string;
  /** CSS colour, e.g. "#e5484d". */
  color: string;
}

interface ProfileBase {
  id: string;
  name: string;
  env: EnvironmentTag;
  createdAt: number;
  updatedAt: number;
}

export interface PostgresProfile extends ProfileBase {
  driver: 'postgres';
  host: string;
  port: number;
  database: string;
  user: string;
  tls: TlsOptions;
}

export interface MysqlProfile extends ProfileBase {
  driver: 'mysql';
  host: string;
  port: number;
  /** Optional default database. */
  database?: string;
  user: string;
  tls: TlsOptions;
}

export interface MssqlProfile extends ProfileBase {
  driver: 'mssql';
  host: string;
  port: number;
  database: string;
  user: string;
  tls: TlsOptions;
}

export type DatabricksAuthMode = 'oauth-m2m' | 'access-token';

export interface DatabricksProfile extends ProfileBase {
  driver: 'databricks';
  /** Server Hostname of the SQL warehouse, e.g. dbc-1234.cloud.databricks.com */
  host: string;
  /** HTTP Path of the SQL warehouse, e.g. /sql/1.0/warehouses/abc123 */
  httpPath: string;
  authMode: DatabricksAuthMode;
  /** Service principal client id (oauth-m2m only). Not secret. */
  clientId?: string;
  /** Optional initial catalog / schema. */
  catalog?: string;
  schema?: string;
  /** Optional Azure tenant id for Azure Databricks M2M with Entra service principals. */
  azureTenantId?: string;
}

export type ConnectionProfile = PostgresProfile | MysqlProfile | MssqlProfile | DatabricksProfile;

/** Names of secret fields per driver. Secret values never live in the profile file; they are kept in the macOS Keychain. */
export type SecretField = 'password' | 'clientSecret' | 'accessToken';

export type Secrets = Partial<Record<SecretField, string>>;

export function secretFieldsFor(profile: Pick<ConnectionProfile, 'driver'> & { authMode?: DatabricksAuthMode }): SecretField[] {
  if (profile.driver === 'databricks') {
    return profile.authMode === 'oauth-m2m' ? ['clientSecret'] : ['accessToken'];
  }
  return ['password'];
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type ErrorCategory =
  | 'network' // host unreachable, DNS, refused, dropped
  | 'tls' // handshake / certificate problems
  | 'auth' // credentials rejected or expired
  | 'permission' // authenticated but not allowed
  | 'not_found' // database / object does not exist
  | 'syntax' // invalid SQL
  | 'constraint' // constraint / data validation violation
  | 'cancelled' // the database confirmed cancellation
  | 'timeout'
  | 'outcome_unknown' // connection lost during a write; result could not be confirmed
  | 'config' // invalid profile / missing field
  | 'unsupported'
  | 'unknown';

export interface ErrorInfo {
  category: ErrorCategory;
  message: string;
  /** Driver / server specific code, e.g. SQLSTATE 28P01, errno 1045, ELOGIN. */
  code?: string;
  /** Short hint shown under the message. */
  hint?: string;
  driver?: DriverId;
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

export type TreeLevel = 'catalog' | 'database' | 'schema' | 'table';

export interface TypeOption {
  /** Type name as written in DDL, e.g. "VARCHAR". */
  name: string;
  /** If the type takes parameters, e.g. length or precision/scale. */
  params?: 'length' | 'precision_scale' | 'precision';
  defaultParams?: string;
  group: 'number' | 'text' | 'date' | 'bool' | 'binary' | 'json' | 'other';
}

export interface Capabilities {
  driver: DriverId;
  /** Object hierarchy as exposed in the tree, outermost first, ending with 'table'. */
  hierarchy: TreeLevel[];
  cancel: 'server-confirmed' | 'best-effort';
  insert: boolean;
  createTable: boolean;
  /** DEFAULT keyword supported in INSERT and column defaults in CREATE TABLE. */
  columnDefaults: boolean;
  primaryKey: boolean;
  indexes: boolean;
  /** True when the driver can stream a complete result to disk. */
  streamingExport: boolean;
  /** Transactions around multi-statement writes. */
  transactions: boolean;
  types: TypeOption[];
  /** Name of the identifier quoting character(s) for display, e.g. `"`. */
  quote: string;
  notes: string[];
}

// ---------------------------------------------------------------------------
// Object tree and paths
// ---------------------------------------------------------------------------

export interface ObjectPath {
  catalog?: string;
  database?: string;
  schema?: string;
  name: string;
}

export type ObjectKind = 'table' | 'view';

export interface TreeNode {
  kind: 'catalog' | 'database' | 'schema' | 'table' | 'view';
  name: string;
  /** Path of this node; for containers `name` is the container name and `path` contains its parents. */
  path: Partial<ObjectPath>;
  /** Containers have children; tables and views do not. */
  hasChildren: boolean;
  /** Optional extra info, e.g. "default" for the profile's default database. */
  detail?: string;
}

export function describePath(p: Partial<ObjectPath>): string {
  return [p.catalog, p.database, p.schema, p.name].filter(Boolean).join('.');
}

// ---------------------------------------------------------------------------
// Values and results
// ---------------------------------------------------------------------------

export interface BinaryCell {
  $binary: string; // hex, possibly truncated
  bytes: number;
  truncated: boolean;
}

/**
 * A single cell. `null` is SQL NULL and is distinct from the empty string ''.
 * BIGINT / DECIMAL values that cannot be represented exactly as a JS number are strings.
 * Date/time values are strings formatted by the adapter (see formatting rules in values.ts).
 */
export type Cell = null | string | number | boolean | BinaryCell;

export type ValueKind = 'number' | 'text' | 'bool' | 'date' | 'binary' | 'json' | 'other';

export interface ResultColumn {
  name: string;
  /** Database type name as reported by the server, e.g. "int8", "DECIMAL(38,10)". */
  type: string;
  kind: ValueKind;
}

export interface ResultSet {
  columns: ResultColumn[];
  rows: Cell[][];
}

export type QueryPhase =
  | 'connecting'
  | 'waiting-warehouse' // Databricks: session open / warehouse start-up
  | 'queued' // Databricks: statement pending in the warehouse queue
  | 'running'
  | 'fetching';

export type CancelRequestResult = 'requested' | 'not-running' | 'failed';

/** One statement's outcome inside a run. */
export interface StatementResult {
  index: number;
  sql: string;
  status: 'ok' | 'error' | 'cancelled' | 'skipped' | 'outcome_unknown';
  /** Row-returning statement */
  columns?: ResultColumn[];
  rows?: Cell[][];
  /** True when more rows are available on the open cursor (result was limited). */
  hasMore?: boolean;
  /** Row limit applied when hasMore is true. */
  limit?: number;
  rowsAffected?: number;
  command?: string;
  error?: ErrorInfo;
  durationMs: number;
  notices?: string[];
  /** Id of the cursor kept open for "load more" / export of the full result. */
  cursorId?: string;
}

export interface ExecContext {
  catalog?: string;
  database?: string;
  schema?: string;
}

// ---------------------------------------------------------------------------
// Browse (table/view data)
// ---------------------------------------------------------------------------

export type FilterOp =
  | '=' | '!=' | '<' | '<=' | '>' | '>='
  | 'contains' | 'not_contains' | 'starts_with' | 'ends_with'
  | 'contains_cs' | 'not_contains_cs' | 'starts_with_cs' | 'ends_with_cs'
  | 'in' | 'not_in'
  | 'between' | 'not_between'
  | 'like'
  | 'is_null' | 'is_not_null'
  /** A hand-written condition in `value` (no column); see checkRawCondition. */
  | 'raw';

export interface Filter {
  column: string;
  op: FilterOp;
  /** For 'in'/'not_in', a comma-separated list of values. */
  value?: string;
  /** Upper bound for 'between' / 'not_between' (`value` is the lower bound). */
  value2?: string;
  /** How this filter combines with the one before it (default 'and'; ignored on the first). AND binds tighter than OR. */
  join?: 'and' | 'or';
}

export interface Sort {
  column: string;
  dir: 'asc' | 'desc';
}

export interface BrowseRequest {
  object: ObjectPath;
  filters: Filter[];
  sort?: Sort;
  offset: number;
  pageSize: number;
}

export interface BrowseResult {
  totalRows?: string;
  columns: ResultColumn[];
  rows: Cell[][];
  offset: number;
  /** True when at least one more row exists beyond this page. */
  hasMore: boolean;
  sql: string;
  params: SqlParam[];
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

export type SectionStatus =
  | { state: 'ok' }
  | { state: 'empty' } // readable, nothing there
  | { state: 'denied'; message: string } // the account cannot read it
  | { state: 'unsupported'; message: string }; // driver/database has no such concept

export interface ColumnInfo {
  ordinal: number;
  name: string;
  type: string;
  nullable: boolean | null;
  /** Default expression as reported by the database (SQL text) or null when none. */
  defaultValue: string | null;
  isPrimaryKey: boolean;
  isIdentity?: boolean;
  isGenerated?: boolean;
  comment?: string | null;
  kind: ValueKind;
}

export interface IndexInfo {
  name: string;
  columns: string[];
  unique: boolean;
  primary: boolean;
  definition?: string;
}

export interface ConstraintInfo {
  name: string;
  type: 'PRIMARY KEY' | 'FOREIGN KEY' | 'UNIQUE' | 'CHECK' | string;
  columns: string[];
  definition?: string;
  references?: string;
  foreignTarget?: { object: ObjectPath; columns: string[] };
}

export interface TableStructure {
  object: ObjectPath;
  kind: ObjectKind;
  columns: ColumnInfo[];
  columnsStatus: SectionStatus;
  indexes: IndexInfo[];
  indexesStatus: SectionStatus;
  constraints: ConstraintInfo[];
  constraintsStatus: SectionStatus;
  /** Target supports an atomic grid write (independent of privileges and row identity). */
  gridUpdate?: boolean;
  /** Desktop save protocol; prevents an older main process from silently ignoring staged deletions. */
  gridSaveVersion?: number;
}

/** 'yes' / 'no' when the database answered, 'unknown' when the account cannot be checked up front (the database still enforces it). */
export type Tri = 'yes' | 'no' | 'unknown';

export interface ObjectPrivileges {
  select: Tri;
  insert: Tri;
  update?: Tri;
  /** Create table in the given container. */
  create?: Tri;
  /** Why insert/create is not allowed, when known. */
  reason?: string;
}

// ---------------------------------------------------------------------------
// Insert / Create
// ---------------------------------------------------------------------------

/** Explicit NOW() choices are evaluated by the database when the staged rows are saved. */
export type InsertCell = { kind: 'value'; value: string } | { kind: 'null' } | { kind: 'default' } | { kind: 'now' };

export interface InsertSpec {
  object: ObjectPath;
  /** Column metadata (from getStructure) for every column that may appear. */
  columns: Pick<ColumnInfo, 'name' | 'type' | 'kind'>[];
  rows: Record<string, InsertCell>[];
}

export interface GridCellChange {
  column: string;
  original: string | null;
  value: string | null;
  /** A database-side datetime expression; overrides value without changing original-value matching. */
  expression?: 'default' | 'now';
}

export type GridRowKey = { column: string; value: string }[];

export interface GridRowUpdate {
  key: GridRowKey;
  changes: GridCellChange[];
}

export interface GridRowDelete {
  key: GridRowKey;
}

export interface GridChanges {
  updates: GridRowUpdate[];
  inserts: Record<string, InsertCell>[];
  deletes?: GridRowDelete[];
}

export type ColumnDefault = { kind: 'none' } | { kind: 'literal'; value: string } | { kind: 'expression'; value: string };

export interface ColumnSpec {
  name: string;
  /** Full type incl. params, e.g. "VARCHAR(255)", "DECIMAL(38,10)". */
  type: string;
  nullable: boolean;
  default: ColumnDefault;
  primaryKey: boolean;
}

export interface CreateTableSpec {
  object: ObjectPath;
  columns: ColumnSpec[];
  ifNotExists: boolean;
  comment?: string;
}

export interface SqlParam {
  value: string | null;
}

/** A statement ready to run, plus the bound parameters it references. */
export interface BuiltStatement {
  sql: string;
  params: SqlParam[];
  /** Human readable target, e.g. "public.orders". */
  target: string;
  /** Validation errors; if non-empty the statement must not be run. */
  errors: string[];
  warnings: string[];
}

export interface WriteResult {
  status: 'ok' | 'error' | 'outcome_unknown';
  rowsAffected?: number;
  error?: ErrorInfo;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Test connection / autocomplete
// ---------------------------------------------------------------------------

export interface TestStep {
  name: string;
  ok: boolean;
  detail?: string;
  durationMs: number;
}

export interface TestResult {
  ok: boolean;
  steps: TestStep[];
  serverVersion?: string;
  error?: ErrorInfo;
}

/** schema/namespace -> table -> column names. For two-level drivers the outer key is the database. */
export interface CompletionSchema {
  defaultNamespace?: string;
  namespaces: Record<string, Record<string, string[]>>;
  /** True when the schema was truncated because the database has too many objects. */
  truncated: boolean;
}
