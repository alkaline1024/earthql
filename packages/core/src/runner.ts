import type { DriverConnection, QueryCursor } from './driver';
import { CATEGORY_HINTS, makeError } from './errors';
import { isReadOnlyStatement, leadingKeyword, splitStatements } from './sql-split';
import { kindFromTypeName } from './values';
import type {
  BrowseRequest,
  BrowseResult,
  BuiltStatement,
  CancelRequestResult,
  ColumnInfo,
  ErrorInfo,
  ExecContext,
  QueryPhase,
  ResultColumn,
  StatementResult,
  WriteResult,
} from './types';

export interface RunOptions {
  /** Max rows loaded per row-returning statement. */
  limit: number;
  onPhase?: (phase: QueryPhase, statementIndex: number) => void;
}

export interface OpenResult {
  cursor: QueryCursor;
  columns: ResultColumn[];
  statementIndex: number;
}

export interface RunOutcome {
  results: StatementResult[];
  /** Cursor of the last statement when it still has rows (kept open for "load more" / full export). */
  open?: OpenResult;
  cancel: 'none' | 'requested' | 'confirmed' | 'completed-before-cancel';
}

/** If a write loses its connection we cannot know whether it was applied. */
export function writeOutcome(err: ErrorInfo, sql: string, conn: DriverConnection): ErrorInfo {
  if (err.category === 'network' && !isReadOnlyStatement(sql, conn.driver)) {
    return {
      ...err,
      category: 'outcome_unknown',
      hint: CATEGORY_HINTS.outcome_unknown,
    };
  }
  return err;
}

/**
 * Runs SQL text statement by statement on one connection. Stops at the first error.
 * Cancellation targets the statement that is currently executing; remaining statements are skipped.
 */
export class ScriptRun {
  private current: QueryCursor | null = null;
  private cancelRequested = false;
  private cancelState: RunOutcome['cancel'] = 'none';

  constructor(
    private readonly conn: DriverConnection,
    private readonly text: string,
    private readonly ctx: ExecContext,
    private readonly opts: RunOptions,
  ) {}

  async cancel(): Promise<CancelRequestResult> {
    this.cancelRequested = true;
    if (!this.current) return 'not-running';
    this.cancelState = 'requested';
    try {
      return await this.current.cancel();
    } catch {
      return 'failed';
    }
  }

  async run(): Promise<RunOutcome> {
    const statements = splitStatements(this.text, this.conn.driver);
    const results: StatementResult[] = [];
    let open: OpenResult | undefined;
    let stop = false;

    for (let i = 0; i < statements.length; i++) {
      const sql = statements[i].sql;
      if (stop || this.cancelRequested) {
        results.push({ index: i, sql, status: 'skipped', durationMs: 0 });
        continue;
      }
      const started = Date.now();
      const cursor = this.conn.openCursor({ sql }, this.ctx, { onPhase: (p) => this.opts.onPhase?.(p, i) });
      this.current = cursor;
      let keepOpen = false;
      try {
        const chunk = await cursor.fetch(this.opts.limit);
        const result: StatementResult = {
          index: i,
          sql,
          status: 'ok',
          durationMs: Date.now() - started,
          command: chunk.command ?? leadingKeyword(sql, this.conn.driver),
          notices: chunk.notices,
        };
        if (chunk.columns) {
          result.columns = chunk.columns;
          result.rows = chunk.rows;
          result.hasMore = !chunk.done;
          if (!chunk.done) {
            result.limit = this.opts.limit;
            if (i === statements.length - 1) {
              keepOpen = true;
              open = { cursor, columns: chunk.columns, statementIndex: i };
            }
          }
        } else {
          result.rowsAffected = chunk.rowsAffected;
        }
        if (this.cancelState === 'requested') this.cancelState = 'completed-before-cancel';
        results.push(result);
      } catch (e) {
        let info = this.conn.classifyError(e);
        if (info.category === 'cancelled') {
          this.cancelState = 'confirmed';
          results.push({ index: i, sql, status: 'cancelled', error: info, durationMs: Date.now() - started });
        } else {
          info = writeOutcome(info, sql, this.conn);
          results.push({
            index: i,
            sql,
            status: info.category === 'outcome_unknown' ? 'outcome_unknown' : 'error',
            error: info,
            durationMs: Date.now() - started,
          });
        }
        stop = true;
      } finally {
        this.current = null;
        if (!keepOpen) await cursor.close().catch(() => undefined);
      }
    }
    return { results, open, cancel: this.cancelState };
  }
}

export async function runBrowse(
  conn: DriverConnection,
  req: BrowseRequest,
  columns: Pick<ColumnInfo, 'name' | 'type'>[] | undefined,
  onPhase?: (p: QueryPhase) => void,
): Promise<BrowseResult> {
  const stmt = conn.dialect.buildBrowse(req, columns);
  if (stmt.errors.length) throw makeError('config', stmt.errors.join('\n'));
  const started = Date.now();
  const cursor = conn.openCursor({ sql: stmt.sql, params: stmt.params }, ctxForObject(req.object), { onPhase });
  try {
    const chunk = await cursor.fetch(req.pageSize + 1);
    const rows = chunk.rows.slice(0, req.pageSize);
    let cols = chunk.columns ?? [];
    // Dialects may convert values server-side (e.g. DECIMAL -> VARCHAR on SQL Server): report the table's own types.
    if (columns && columns.length === cols.length) {
      cols = cols.map((c, i) => ({ ...c, type: columns[i].type, kind: kindFromTypeName(columns[i].type) }));
    }
    return {
      columns: cols,
      rows,
      offset: req.offset,
      hasMore: chunk.rows.length > req.pageSize,
      sql: stmt.sql,
      params: stmt.params,
      durationMs: Date.now() - started,
    };
  } finally {
    await cursor.close().catch(() => undefined);
  }
}

export function ctxForObject(o: { catalog?: string; database?: string; schema?: string }): ExecContext {
  return { catalog: o.catalog, database: o.database, schema: o.schema };
}

/** Run a single generated write (INSERT / CREATE TABLE). */
export async function runWrite(conn: DriverConnection, stmt: BuiltStatement, ctx: ExecContext): Promise<WriteResult> {
  if (stmt.errors.length) {
    return { status: 'error', error: { category: 'config', message: stmt.errors.join('\n') }, durationMs: 0 };
  }
  const started = Date.now();
  const cursor = conn.openCursor({ sql: stmt.sql, params: stmt.params }, ctx);
  try {
    const chunk = await cursor.fetch(0);
    return { status: 'ok', rowsAffected: chunk.rowsAffected, durationMs: Date.now() - started };
  } catch (e) {
    const info = writeOutcome(conn.classifyError(e), stmt.sql, conn);
    return { status: info.category === 'outcome_unknown' ? 'outcome_unknown' : 'error', error: info, durationMs: Date.now() - started };
  } finally {
    await cursor.close().catch(() => undefined);
  }
}
