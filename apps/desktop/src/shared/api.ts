// IPC contract between the renderer (UI) and the main process.
// Secrets only travel renderer -> main (when the user types them); main never sends them back.
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

export interface OpenConnection {
  profileId: string;
  capabilities: Capabilities;
  defaultContext: ExecContext;
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

export interface EarthQLApi {
  platform: string;
  profiles: {
    list(): Promise<ProfileSummary[]>;
    /** `secrets`: fields to store; omitted fields keep the stored value; empty string clears it. */
    save(profile: ConnectionProfile, secrets: Secrets): Promise<ProfileSummary>;
    remove(id: string): Promise<void>;
    /** Test a draft profile. Missing secret fields fall back to the values stored for `profile.id`. */
    test(profile: ConnectionProfile, secrets: Secrets): Promise<TestResult>;
  };
  connection: {
    open(profileId: string): Promise<OpenConnection>;
    close(profileId: string): Promise<void>;
  };
  meta: {
    children(profileId: string, node: TreeNode | null): Promise<TreeNode[]>;
    structure(profileId: string, object: ObjectPath, refresh?: boolean): Promise<TableStructure>;
    privileges(profileId: string, object: ObjectPath): Promise<ObjectPrivileges>;
    completion(profileId: string, ctx: ExecContext): Promise<CompletionSchema>;
  };
  data: {
    browse(profileId: string, req: BrowseRequest): Promise<BrowseResult>;
  };
  query: {
    run(profileId: string, runId: string, sql: string, ctx: ExecContext, limit: number): Promise<RunResponse>;
    cancel(runId: string): Promise<CancelRequestResult>;
    more(cursorId: string, maxRows: number): Promise<CursorChunk>;
    closeCursor(cursorId: string): Promise<void>;
    onPhase(cb: (e: { runId: string; phase: QueryPhase; statementIndex: number }) => void): () => void;
  };
  write: {
    previewInsert(profileId: string, spec: InsertSpec): Promise<BuiltStatement>;
    insert(profileId: string, spec: InsertSpec): Promise<WriteResult>;
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
