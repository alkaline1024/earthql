import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import {
  ScriptRun,
  csvHeader,
  csvRows,
  ctxForObject,
  isReadOnlyStatement,
  makeError,
  redactInfo,
  runBrowse,
  runGridUpdates,
  runWrite,
  secretFieldsFor,
  splitStatements,
  toErrorInfo,
  type BrowseRequest,
  type CancelRequestResult,
  type ConnectionProfile,
  type CreateTableSpec,
  type CursorChunk,
  type DriverConnection,
  type DriverId,
  type DriverModule,
  type ExecContext,
  type GridRowUpdate,
  type InsertSpec,
  type ObjectPath,
  type QueryCursor,
  type QueryPhase,
  type ResultColumn,
  type Secrets,
  type TableStructure,
} from '@earthql/core';
import { postgresDriver } from '@earthql/driver-postgres';
import { mysqlDriver } from '@earthql/driver-mysql';
import { databricksDriver } from '@earthql/driver-databricks';
import { mssqlDriver } from '@earthql/driver-mssql';
import type { ExportOptions, ExportResult, ExportScope, HistoryEntry, OpenConnection, RunResponse } from '../shared/api';
import { getSecrets } from './keychain';
import { addHistory, loadProfiles } from './store';

export const DRIVERS: Record<DriverId, DriverModule> = {
  postgres: postgresDriver,
  mysql: mysqlDriver,
  databricks: databricksDriver,
  mssql: mssqlDriver,
};

interface Live {
  profile: ConnectionProfile;
  secrets: Secrets;
  conn: DriverConnection;
  structures: Map<string, TableStructure>;
}

interface OpenCursor {
  profileId: string;
  cursor: QueryCursor;
  columns: ResultColumn[];
  lastUsed: number;
}

const keyOf = (o: ObjectPath) => JSON.stringify([o.catalog ?? '', o.database ?? '', o.schema ?? '', o.name]);

export class SessionManager {
  private live = new Map<string, Live>();
  private runs = new Map<string, ScriptRun>();
  private cursors = new Map<string, OpenCursor>();
  private exports = new Map<string, { cancel: () => void }>();

  constructor(private readonly emit: (channel: string, payload: unknown) => void) {
    // Close cursors that have been idle for a long time; they hold a server connection.
    setInterval(() => {
      const cutoff = Date.now() - 30 * 60 * 1000;
      for (const [id, c] of this.cursors) if (c.lastUsed < cutoff) void this.closeCursor(id);
    }, 60 * 1000).unref();
  }

  // ---------------------------------------------------------------------------
  // Connections
  // ---------------------------------------------------------------------------

  private profile(id: string): ConnectionProfile {
    const p = loadProfiles().find((x) => x.id === id);
    if (!p) throw makeError('config', 'The connection profile no longer exists.');
    return p;
  }

  createConnection(profile: ConnectionProfile, secrets: Secrets): DriverConnection {
    return DRIVERS[profile.driver].connect(profile, secrets);
  }

  async open(profileId: string): Promise<OpenConnection> {
    await this.close(profileId);
    const profile = this.profile(profileId);
    const secrets = getSecrets(profileId);
    const missing = secretFieldsFor(profile as any).filter((f) => !secrets[f]);
    if (missing.length && profile.driver === 'databricks') {
      throw makeError('config', `No ${missing.join(', ')} is saved for this profile. Edit the profile to enter it.`);
    }
    const conn = this.createConnection(profile, secrets);
    // Prove the connection works (and surface auth/network/permission errors) before showing the workspace.
    try {
      await conn.listChildren(null);
    } catch (e) {
      await conn.close().catch(() => undefined);
      throw conn.classifyError(e);
    }
    this.live.set(profileId, { profile, secrets, conn, structures: new Map() });
    return { profileId, capabilities: conn.capabilities(), defaultContext: conn.defaultContext() };
  }

  async close(profileId: string): Promise<void> {
    for (const [id, c] of this.cursors) if (c.profileId === profileId) await this.closeCursor(id);
    const l = this.live.get(profileId);
    this.live.delete(profileId);
    if (l) await l.conn.close().catch(() => undefined);
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.live.keys()].map((id) => this.close(id)));
  }

  get(profileId: string): Live {
    const l = this.live.get(profileId);
    if (!l) throw makeError('network', 'Not connected. Open the connection again.', { code: 'NOT_CONNECTED' });
    return l;
  }

  /** Wrap any error into ErrorInfo with this profile's secrets redacted. */
  errorFor(profileId: string | undefined, e: unknown) {
    const l = profileId ? this.live.get(profileId) : undefined;
    if (l) return l.conn.classifyError(e);
    const info = toErrorInfo(e);
    return profileId ? redactInfo(info, Object.values(getSecrets(profileId))) : info;
  }

  // ---------------------------------------------------------------------------
  // Metadata / data
  // ---------------------------------------------------------------------------

  async structure(profileId: string, object: ObjectPath, refresh = false): Promise<TableStructure> {
    const l = this.get(profileId);
    const k = keyOf(object);
    if (!refresh) {
      const cached = l.structures.get(k);
      if (cached) return cached;
    }
    const s = await l.conn.getStructure(object);
    l.structures.set(k, s);
    return s;
  }

  async browse(profileId: string, req: BrowseRequest) {
    const l = this.get(profileId);
    let columns: TableStructure['columns'] | undefined;
    try {
      const s = await this.structure(profileId, req.object);
      if (s.columnsStatus.state === 'ok') columns = s.columns;
    } catch {
      columns = undefined; // browse with SELECT * when structure cannot be read
    }
    return runBrowse(l.conn, req, columns);
  }

  // ---------------------------------------------------------------------------
  // SQL editor
  // ---------------------------------------------------------------------------

  async run(profileId: string, runId: string, sql: string, ctx: ExecContext, limit: number): Promise<RunResponse> {
    const l = this.get(profileId);
    const run = new ScriptRun(l.conn, sql, ctx, {
      limit,
      onPhase: (phase: QueryPhase, statementIndex: number) => this.emit('query:phase', { runId, phase, statementIndex }),
    });
    this.runs.set(runId, run);
    const started = Date.now();
    try {
      const out = await run.run();
      if (out.open) {
        const cursorId = randomUUID();
        this.cursors.set(cursorId, { profileId, cursor: out.open.cursor, columns: out.open.columns, lastUsed: Date.now() });
        out.results[out.open.statementIndex].cursorId = cursorId;
      }
      const statusOf = (): HistoryEntry['status'] => {
        if (out.results.some((r) => r.status === 'outcome_unknown')) return 'outcome_unknown';
        if (out.results.some((r) => r.status === 'cancelled')) return 'cancelled';
        if (out.results.some((r) => r.status === 'error')) return 'error';
        return 'ok';
      };
      if (out.results.length > 0) {
        addHistory(profileId, {
          id: runId,
          sql,
          ranAt: started,
          durationMs: Date.now() - started,
          status: statusOf(),
          context: ctx,
          statements: out.results.length,
        });
      }
      return { runId, results: out.results, cancel: out.cancel };
    } finally {
      this.runs.delete(runId);
    }
  }

  async cancel(runId: string): Promise<CancelRequestResult> {
    const r = this.runs.get(runId);
    if (!r) return 'not-running';
    return r.cancel();
  }

  async more(cursorId: string, maxRows: number): Promise<CursorChunk> {
    const c = this.cursors.get(cursorId);
    if (!c) throw makeError('config', 'This result is no longer open. Run the query again to load more rows.');
    c.lastUsed = Date.now();
    try {
      const chunk = await c.cursor.fetch(maxRows);
      if (chunk.done) await this.closeCursor(cursorId);
      return chunk;
    } catch (e) {
      await this.closeCursor(cursorId);
      throw this.errorFor(c.profileId, e);
    }
  }

  async closeCursor(cursorId: string): Promise<void> {
    const c = this.cursors.get(cursorId);
    this.cursors.delete(cursorId);
    if (c) await c.cursor.close().catch(() => undefined);
  }

  // ---------------------------------------------------------------------------
  // Writes (statements are always rebuilt here from the spec; the UI never sends raw write SQL)
  // ---------------------------------------------------------------------------

  previewInsert(profileId: string, spec: InsertSpec) {
    return this.get(profileId).conn.dialect.buildInsert(spec);
  }

  async insert(profileId: string, spec: InsertSpec) {
    const l = this.get(profileId);
    return runWrite(l.conn, l.conn.dialect.buildInsert(spec), ctxForObject(spec.object));
  }

  async updateCells(profileId: string, object: ObjectPath, rows: GridRowUpdate[]) {
    const { conn } = this.get(profileId);
    const structure = await this.structure(profileId, object, true);
    return runGridUpdates(conn, structure, rows);
  }

  previewCreate(profileId: string, spec: CreateTableSpec) {
    return this.get(profileId).conn.dialect.buildCreateTable(spec);
  }

  async create(profileId: string, spec: CreateTableSpec) {
    const l = this.get(profileId);
    const res = await runWrite(l.conn, l.conn.dialect.buildCreateTable(spec), ctxForObject(spec.object));
    l.structures.delete(keyOf(spec.object));
    return res;
  }

  // ---------------------------------------------------------------------------
  // CSV export (streamed to disk in batches)
  // ---------------------------------------------------------------------------

  async exportCsv(exportId: string, scope: ExportScope, opts: ExportOptions, file: string): Promise<ExportResult> {
    const out = fs.createWriteStream(file, { encoding: 'utf8' });
    let cancelled = false;
    let active: QueryCursor | undefined;
    this.exports.set(exportId, {
      cancel: () => {
        cancelled = true;
        void active?.cancel();
      },
    });
    const write = (s: string) =>
      new Promise<void>((resolve, reject) => {
        if (!out.write(s)) out.once('drain', resolve);
        else resolve();
        out.once('error', reject);
      });
    const csvOpts = { nullText: opts.nullText, bom: opts.bom };
    let rows = 0;
    const progress = (done: boolean) => this.emit('export:progress', { exportId, rows, done });
    let profileId: string | undefined;
    let ownedCursor = false;

    try {
      let columns: ResultColumn[] | null = null;
      let cursor: QueryCursor | undefined;

      if (scope.kind === 'loaded' || scope.kind === 'cursor') {
        columns = scope.columns;
        await write(csvHeader(columns, csvOpts));
        await write(csvRows(scope.rows, csvOpts));
        rows += scope.rows.length;
        if (scope.kind === 'cursor') {
          const c = this.cursors.get(scope.cursorId);
          if (!c) throw makeError('config', 'The result is no longer open; only the loaded rows could be exported.');
          profileId = c.profileId;
          cursor = c.cursor;
          c.lastUsed = Date.now();
        }
      } else if (scope.kind === 'rerun') {
        profileId = scope.profileId;
        const l = this.get(scope.profileId);
        const stmts = splitStatements(scope.sql, l.conn.driver);
        if (stmts.length !== 1 || !isReadOnlyStatement(stmts[0].sql, l.conn.driver)) {
          throw makeError('unsupported', 'Only a single read-only statement can be re-run for export.');
        }
        cursor = l.conn.openCursor({ sql: stmts[0].sql }, scope.context);
        ownedCursor = true;
      } else {
        profileId = scope.profileId;
        const l = this.get(scope.profileId);
        let cols: TableStructure['columns'] | undefined;
        try {
          const s = await this.structure(scope.profileId, scope.object);
          if (s.columnsStatus.state === 'ok') cols = s.columns;
        } catch {
          cols = undefined;
        }
        const stmt = l.conn.dialect.buildBrowseAll({ object: scope.object, filters: scope.filters, sort: scope.sort }, cols);
        if (stmt.errors.length) throw makeError('config', stmt.errors.join('\n'));
        cursor = l.conn.openCursor({ sql: stmt.sql, params: stmt.params }, ctxForObject(scope.object));
        ownedCursor = true;
      }

      if (cursor) {
        active = cursor;
        for (;;) {
          if (cancelled) break;
          const chunk = await cursor.fetch(5000);
          if (!columns) {
            columns = chunk.columns ?? [];
            await write(csvHeader(columns, csvOpts));
          }
          await write(csvRows(chunk.rows, csvOpts));
          rows += chunk.rows.length;
          progress(false);
          if (chunk.done) break;
        }
        if (scope.kind === 'cursor') {
          // The cursor was consumed by the export.
          await this.closeCursor(scope.cursorId);
        } else if (ownedCursor) {
          await cursor.close().catch(() => undefined);
        }
      }
      await new Promise<void>((resolve) => out.end(resolve));
      progress(true);
      if (cancelled) {
        fs.rmSync(file, { force: true });
        return { status: 'cancelled-by-user', rows };
      }
      return { status: 'ok', path: file, rows };
    } catch (e) {
      out.destroy();
      // Never leave a partial file that looks complete.
      fs.rmSync(file, { force: true });
      if (cancelled) return { status: 'cancelled-by-user', rows };
      return { status: 'error', rows, error: this.errorFor(profileId, e) };
    } finally {
      this.exports.delete(exportId);
      if (ownedCursor) await active?.close().catch(() => undefined);
    }
  }

  cancelExport(exportId: string): void {
    this.exports.get(exportId)?.cancel();
  }
}
