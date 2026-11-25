import type { Dialect } from './dialect';
import type {
  CancelRequestResult,
  Capabilities,
  Cell,
  CompletionSchema,
  ConnectionProfile,
  DriverId,
  ErrorInfo,
  ExecContext,
  ObjectPath,
  ObjectPrivileges,
  QueryPhase,
  ResultColumn,
  Secrets,
  SqlParam,
  TableStructure,
  TestResult,
  TreeNode,
} from './types';

export interface CursorChunk {
  /** Columns of a row-returning statement; null for statements without a result set. */
  columns: ResultColumn[] | null;
  rows: Cell[][];
  /** No more rows will follow. */
  done: boolean;
  rowsAffected?: number;
  command?: string;
  notices?: string[];
}

/**
 * A running statement. The first fetch() executes it. Rows are pulled in batches so the
 * app controls how much it loads. cancel() only *requests* cancellation; the cancellation
 * is confirmed when the pending fetch() rejects with an error of category 'cancelled'.
 */
export interface QueryCursor {
  fetch(maxRows: number): Promise<CursorChunk>;
  cancel(): Promise<CancelRequestResult>;
  close(): Promise<void>;
}

export interface StatementInput {
  sql: string;
  params?: SqlParam[];
}

export interface CursorOptions {
  onPhase?: (phase: QueryPhase) => void;
}

export interface DriverConnection {
  readonly driver: DriverId;
  readonly dialect: Dialect;
  capabilities(): Capabilities;
  /** Opens a session and runs SELECT 1 against the configured database / warehouse. */
  test(): Promise<TestResult>;
  /** Children of a tree node; null = root (databases or catalogs). */
  listChildren(parent: TreeNode | null): Promise<TreeNode[]>;
  getStructure(object: ObjectPath): Promise<TableStructure>;
  getPrivileges(object: ObjectPath): Promise<ObjectPrivileges>;
  openCursor(stmt: StatementInput, ctx: ExecContext, opts?: CursorOptions): QueryCursor;
  /** Apply grid statements on a single connection in an atomic transaction. */
  applyGridUpdates?(object: ObjectPath, statements: StatementInput[]): Promise<void>;
  /** Execute a compiled table-management batch on one database session. */
  executeTableStatements?(object: ObjectPath, statements: string[], options: { disableForeignKeys: boolean; cleanupSql?: string }): Promise<void>;
  /** Default execution context (profile database / catalog / schema). */
  defaultContext(): ExecContext;
  /** Available contexts for the SQL editor selector (databases or catalogs at the top level). */
  completionSchema(ctx: ExecContext): Promise<CompletionSchema>;
  /** Map any driver error into an ErrorInfo with secrets redacted. */
  classifyError(e: unknown): ErrorInfo;
  close(): Promise<void>;
}

export interface DriverModule {
  id: DriverId;
  dialect: Dialect;
  capabilities: Capabilities;
  connect(profile: ConnectionProfile, secrets: Secrets): DriverConnection;
}

/**
 * Buffers rows from a push-based driver stream (mysql2, mssql) so they can be pulled in batches.
 * Applies back-pressure through pause/resume once `highWater` rows are buffered.
 */
export class PullBuffer {
  columns: ResultColumn[] | null = null;
  private rows: Cell[][] = [];
  private finished = false;
  private failure: unknown = undefined;
  private waiters: Array<() => void> = [];
  private paused = false;
  rowsAffected?: number;
  command?: string;
  notices: string[] = [];

  constructor(
    private readonly hooks: { pause: () => void; resume: () => void },
    private highWater = 2000,
  ) {}

  setColumns(cols: ResultColumn[]): void {
    this.columns = cols;
    this.wake();
  }

  push(row: Cell[]): void {
    this.rows.push(row);
    if (!this.paused && this.rows.length >= this.highWater) {
      this.paused = true;
      this.hooks.pause();
    }
    this.wake();
  }

  end(): void {
    this.finished = true;
    this.wake();
  }

  fail(e: unknown): void {
    if (this.failure === undefined) this.failure = e ?? new Error('Unknown driver error');
    this.wake();
  }

  get isDone(): boolean {
    return this.finished && this.rows.length === 0;
  }

  get hasFailed(): boolean {
    return this.failure !== undefined;
  }

  private wake(): void {
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }

  private wait(): Promise<void> {
    return new Promise((r) => this.waiters.push(r));
  }

  async take(max: number): Promise<CursorChunk> {
    // Never pause below what the caller asked for, or every row would toggle pause/resume.
    if (max > this.highWater) this.highWater = max;
    for (;;) {
      if (this.failure !== undefined) throw this.failure;
      const haveEnough = max > 0 ? this.rows.length >= max : this.columns !== null;
      if (haveEnough || this.finished) break;
      if (this.paused) {
        this.paused = false;
        this.hooks.resume();
      }
      await this.wait();
    }
    const rows = this.rows.splice(0, max);
    if (this.paused && this.rows.length < this.highWater / 2 && !this.finished) {
      this.paused = false;
      this.hooks.resume();
    }
    return {
      columns: this.columns,
      rows,
      done: this.finished && this.rows.length === 0,
      rowsAffected: this.rowsAffected,
      command: this.command,
      notices: this.notices.length ? this.notices.splice(0) : undefined,
    };
  }
}
