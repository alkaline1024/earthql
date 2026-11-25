// IPC contract between the renderer (UI) and the main process.
// Secrets only travel renderer -> main (when the user types them); main never sends them back.
import type { SaveTableGroupFileResult } from './table-group-transfer';
import type {
  BrowseRequest,
  BrowseResult,
  BuiltStatement,
  CancelRequestResult,
  Capabilities,
  CompletionSchema,
  ConnectionProfile,
  CreateTableSpec,
  CursorChunk,
  ErrorInfo,
  ExecContext,
  Filter,
  GridRowDelete,
  GridRowUpdate,
  InsertSpec,
  ObjectPath,
  ObjectPrivileges,
  QueryPhase,
  ResultColumn,
  Cell,
  Secrets,
  SecretField,
  Sort,
  StatementResult,
  TableStructure,
  TestResult,
  TreeNode,
  WriteResult,
} from '@earthql/core';
import type { FeedbackDraft, FeedbackSettings } from './feedback';

export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: ErrorInfo };

export interface ProfileSummary {
  profile: ConnectionProfile;
  /** Which secret fields have a value stored in the Keychain. */
  storedSecrets: SecretField[];
}

export interface ConnectionImportResult {
  imported: number;
  duplicates: number;
  skipped: number;
  environmentsUpdated: number;
  passwordsSaved: number;
  passwordsFailed: number;
}

export interface ConnectionExportResult {
  exported: number;
  skipped: number;
  reviewTls: number;
}

export interface ConnectionScope {
  kind: 'database' | 'catalog';
  name: string;
}

export interface OpenConnection {
  sessionId: string;
  profileId: string;
  capabilities: Capabilities;
  defaultContext: ExecContext;
  scope?: ConnectionScope;
}

export interface RunResponse {
  runId: string;
  results: StatementResult[];
  cancel: 'none' | 'requested' | 'confirmed' | 'completed-before-cancel';
}

export interface HistoryEntry {
  id: string;
  sql: string;
  ranAt: number;
  durationMs: number;
  status: 'ok' | 'error' | 'cancelled' | 'outcome_unknown';
  context: ExecContext;
  statements: number;
}

export interface SavedQuery {
  id: string;
  name: string;
  sql: string;
  context?: ExecContext;
  createdAt: number;
  updatedAt: number;
}

export type ExportScope =
  | { kind: 'loaded'; columns: ResultColumn[]; rows: Cell[][] }
  /** Write the loaded rows then drain the still-open cursor (no re-execution). */
  | { kind: 'cursor'; cursorId: string; columns: ResultColumn[]; rows: Cell[][] }
  /** Re-run a read-only statement and stream every row. */
  | { kind: 'rerun'; profileId: string; sql: string; context: ExecContext }
  /** Every row of a table/view matching the filter and sort. */
  | { kind: 'table'; profileId: string; object: ObjectPath; filters: Filter[]; sort?: Sort };

export interface ExportOptions {
  nullText: string;
  bom: boolean;
  suggestedName: string;
}

export interface ExportProgress {
  exportId: string;
  rows: number;
  done: boolean;
}

export interface ExportResult {
  status: 'ok' | 'cancelled-by-user' | 'error' | 'dialog-cancelled';
  path?: string;
  rows?: number;
  error?: ErrorInfo;
}

export type SaveSqlFileResult = { status: 'ok'; path: string } | { status: 'dialog-cancelled' };

export type TableFileFormat = 'csv' | 'json' | 'sql' | 'xlsx';
export interface TableExportItem {
  object: ObjectPath;
  data: boolean;
  structure: boolean;
  drop: boolean;
}
export interface TableExportOptions {
  format: TableFileFormat;
  suggestedName: string;
  delimiter: string;
  quote: 'needed' | 'all';
  lineBreak: '\n' | '\r\n';
  decimal: '.' | ',';
  headers: boolean;
  nullToEmpty: boolean;
  replaceLineBreaks: boolean;
  bom: boolean;
  gzip: boolean;
}
export type TableImportFormat = 'csv' | 'json' | 'sql';
export interface TableImportPreview {
  token: string;
  fileName: string;
  columns: string[];
  sample: (string | null)[][];
  rows: number;
  statements?: number;
  sqlPreview?: string;
  targetColumns: { name: string; type: string; nullable: boolean | null; generated: boolean }[];
}
export interface TableImportResult {
  status: 'ok' | 'error' | 'outcome_unknown' | 'cancelled';
  rows: number;
  statements?: number;
  error?: ErrorInfo;
}

export interface UpdateStatus { available: boolean; busy: boolean; }

export interface EarthQLApi {
  updates: {
    status(): Promise<UpdateStatus>;
    install(): Promise<void>;
    onStatus(cb: (status: UpdateStatus) => void): () => void;
  };
  keybindings: {
    /**
     * Rebuilds the native menu with these shortcut overrides. `suspended` strips every accelerator
     * so a keystroke can be recorded in Settings without also triggering its current menu action.
     */
    apply(overrides: Record<string, string | null>, suspended?: boolean): Promise<void>;
  };
  platform: string;
  profiles: {
    setDefaultDatabase(profileId: string, database: string): Promise<ProfileSummary>;
    list(): Promise<ProfileSummary[]>;
    importTablePlus(password: string): Promise<ConnectionImportResult | null>;
    exportTablePlus(profileId: string | string[] | null, password: string): Promise<ConnectionExportResult | null>;
    /** `secrets`: fields to store; omitted fields keep the stored value; empty string clears it. */
    save(profile: ConnectionProfile, secrets: Secrets): Promise<ProfileSummary>;
    remove(id: string): Promise<void>;
    /** Test a draft profile. Missing secret fields fall back to the values stored for `profile.id`. */
    test(profile: ConnectionProfile, secrets: Secrets): Promise<TestResult>;
    databases(profile: ConnectionProfile, secrets: Secrets): Promise<TreeNode[]>;
  };
  connection: {
    open(profileId: string): Promise<OpenConnection>;
    openSeparate(sessionId: string, name: string): Promise<OpenConnection>;
    reconnect(sessionId: string): Promise<OpenConnection>;
    close(sessionId: string): Promise<void>;
    closeProfile(profileId: string): Promise<void>;
  };
  meta: {
    children(profileId: string, node: TreeNode | null): Promise<TreeNode[]>;
    structure(profileId: string, object: ObjectPath, refresh?: boolean): Promise<TableStructure>;
    privileges(profileId: string, object: ObjectPath): Promise<ObjectPrivileges>;
    completion(profileId: string, ctx: ExecContext): Promise<CompletionSchema>;
  };
  data: {
    browse(profileId: string, req: BrowseRequest): Promise<BrowseResult>;
    previewBrowse(profileId: string, req: BrowseRequest): Promise<BuiltStatement>;
  };
  query: {
    run(profileId: string, runId: string, sql: string, ctx: ExecContext, limit: number): Promise<RunResponse>;
    cancel(runId: string): Promise<CancelRequestResult>;
    more(cursorId: string, maxRows: number): Promise<CursorChunk>;
    closeCursor(cursorId: string): Promise<void>;
    onPhase(cb: (e: { runId: string; phase: QueryPhase; statementIndex: number }) => void): () => void;
    /** Writes `sql` to a `.sql` file the user picks via a native save dialog. */
    saveFile(sql: string, suggestedName: string): Promise<SaveSqlFileResult>;
    /** Formats already-loaded rows as INSERT statement text, dialect-quoted, for "Copy as INSERT Statement". */
    rowsAsInsert(profileId: string, object: ObjectPath, columns: ResultColumn[], rows: Cell[][]): Promise<string>;
  };
  groupFiles: {
    read(): Promise<string | null>;
    save(text: string): Promise<SaveTableGroupFileResult>;
  };
  write: {
    previewInsert(profileId: string, spec: InsertSpec): Promise<BuiltStatement>;
    insert(profileId: string, spec: InsertSpec): Promise<WriteResult>;
    updateCells(profileId: string, object: ObjectPath, rows: GridRowUpdate[]): Promise<WriteResult>;
    saveGrid(profileId: string, object: ObjectPath, changes: import('@earthql/core').GridChanges): Promise<WriteResult>;
    deleteRows(profileId: string, object: ObjectPath, rows: GridRowDelete[]): Promise<WriteResult>;
    previewCreate(profileId: string, spec: CreateTableSpec): Promise<BuiltStatement>;
    create(profileId: string, spec: CreateTableSpec): Promise<WriteResult>;
  };
  history: {
    list(profileId: string): Promise<HistoryEntry[]>;
    clear(profileId: string): Promise<void>;
  };
  saved: {
    list(profileId: string): Promise<SavedQuery[]>;
    save(profileId: string, q: Omit<SavedQuery, 'createdAt' | 'updatedAt'> & { createdAt?: number }): Promise<SavedQuery>;
    remove(profileId: string, id: string): Promise<void>;
  };
  tableActions: {
    saveStructure(profileId: string, object: ObjectPath, edits: import('./table-actions').StructureEdit[]): Promise<void>;
    run(profileId: string, request: import('./table-actions').TableActionRequest): Promise<WriteResult>;
  };
  tableFiles: {
    export(exportId: string, profileId: string, items: TableExportItem[], options: TableExportOptions): Promise<ExportResult>;
    read(profileId: string, object: ObjectPath, format: TableImportFormat, options: { delimiter: string; headers: boolean }): Promise<TableImportPreview | null>;
    import(token: string, mapping: Record<string, string>, emptyAsNull: boolean): Promise<TableImportResult>;
    release(token: string): Promise<void>;
    cancel(id: string): Promise<void>;
  };
  exports: {
    run(exportId: string, scope: ExportScope, opts: ExportOptions): Promise<ExportResult>;
    cancel(exportId: string): Promise<void>;
    onProgress(cb: (p: ExportProgress) => void): () => void;
  };
  feedback: {
    settings(): Promise<FeedbackSettings>;
    saveSettings(url: string, key: string): Promise<FeedbackSettings>;
    capture(): Promise<string>;
    submit(draft: FeedbackDraft): Promise<{ id: string }>;
  };
}
