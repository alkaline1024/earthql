import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import {
  ScriptRun,
  csvHeader,
  csvRows,
  ctxForObject,
  isReadOnlyStatement,
  makeError,
  runBrowse,
  runGridDeletes,
  runGridUpdates,
  runGridSave,
  runWrite,
  secretFieldsFor,
  splitStatements,
  toErrorInfo,
  type BrowseRequest,
  type CancelRequestResult,
  type Cell,
  type ConnectionProfile,
  type CreateTableSpec,
  type CursorChunk,
  type DriverConnection,
  type DriverId,
  type DriverModule,
  type ExecContext,
  type GridRowDelete,
  type GridChanges,
  type GridRowUpdate,
  type InsertSpec,
  type ObjectPath,
  type QueryCursor,
  type QueryPhase,
  type ResultColumn,
  type Secrets,
  type TableStructure,
} from '@earthql/core';
import { insertStatementText } from './table-file-formats';
import { postgresDriver } from '@earthql/driver-postgres';
import { mysqlDriver } from '@earthql/driver-mysql';
import { databricksDriver } from '@earthql/driver-databricks';
import { mssqlDriver } from '@earthql/driver-mssql';
import type { ConnectionScope, ExportOptions, ExportResult, ExportScope, HistoryEntry, OpenConnection, RunResponse } from '../shared/api';
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
  scope?: ConnectionScope;
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
  private opening = new Map<string, { profileId: string }>();
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

  open(profileId: string): Promise<OpenConnection> {
    return this.openSession(profileId, profileId);
  }

  openSeparate(sessionId: string, name: string): Promise<OpenConnection> {
    const source = this.get(sessionId);
    const kind = source.conn.capabilities().hierarchy[0];
    if ((kind !== 'database' && kind !== 'catalog') || typeof name !== 'string' || !name.trim()) {
      throw makeError('config', 'Select a database or catalog to open.');
    }
    return this.openSession(randomUUID(), source.profile.id, { kind, name });
  }

  reconnect(sessionId: string): Promise<OpenConnection> {
    const source = this.live.get(sessionId);
    return this.openSession(sessionId, source?.profile.id ?? sessionId, source?.scope);
  }

  savedProfileId(sessionId: string): string {
    return this.live.get(sessionId)?.profile.id ?? sessionId;
  }

  private async openSession(sessionId: string, profileId: string, scope?: ConnectionScope): Promise<OpenConnection> {
    if (this.opening.has(sessionId)) throw makeError('config', 'This connection is already opening.');
    let profile = this.profile(profileId);
    if (scope) {
      if (scope.kind === 'catalog' && profile.driver === 'databricks') {
        profile = { ...profile, catalog: scope.name, schema: profile.catalog === scope.name ? profile.schema : undefined };
      } else if (scope.kind === 'database' && profile.driver !== 'databricks') {
        profile = { ...profile, database: scope.name };
      } else throw makeError('config', 'The selected database or catalog does not match this driver.');
    }
    const secrets = getSecrets(profileId, secretFieldsFor(profile));
    const missing = secretFieldsFor(profile).filter((f) => !secrets[f]);
    if (missing.length && profile.driver === 'databricks') {
      throw makeError('config', `No ${missing.join(', ')} is saved for this profile. Edit the profile to enter it.`);
    }
    const conn = this.createConnection(profile, secrets);
    const ticket = { profileId };
    this.opening.set(sessionId, ticket);
    try {
      const roots = await conn.listChildren(null);
      if (scope) {
        const selected = roots.find((node) => node.kind === scope.kind && node.name === scope.name);
        if (!selected) throw makeError('not_found', 'The selected database or catalog is no longer available.');
        if (scope.kind === 'catalog') await conn.listChildren(selected);
      }
      if (this.opening.get(sessionId) !== ticket) throw makeError('cancelled', 'Opening the connection was cancelled.');
      await this.closeLive(sessionId);
      if (this.opening.get(sessionId) !== ticket) throw makeError('cancelled', 'Opening the connection was cancelled.');
      this.live.set(sessionId, { profile, scope, secrets, conn, structures: new Map() });
      return { sessionId, profileId, scope, capabilities: conn.capabilities(), defaultContext: conn.defaultContext() };
    } catch (e) {
      await conn.close().catch(() => undefined);
      throw conn.classifyError(e);
    } finally {
      if (this.opening.get(sessionId) === ticket) this.opening.delete(sessionId);
    }
  }

  close(sessionId: string): Promise<void> {
    this.opening.delete(sessionId);
    return this.closeLive(sessionId);
  }

  private async closeLive(sessionId: string): Promise<void> {
    const l = this.live.get(sessionId);
    this.live.delete(sessionId);
    for (const [id, c] of this.cursors) if (c.profileId === sessionId) await this.closeCursor(id);
    if (l) await l.conn.close().catch(() => undefined);
  }

  async closeProfile(profileId: string): Promise<void> {
    const ids = new Set([...this.live.keys(), ...this.opening.keys()]);
    await Promise.all([...ids].filter((id) => this.live.get(id)?.profile.id === profileId ||
      this.opening.get(id)?.profileId === profileId).map((id) => this.close(id)));
  }

  async closeAll(): Promise<void> {
    await Promise.all([...new Set([...this.live.keys(), ...this.opening.keys()])].map((id) => this.close(id)));
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
    return info;
  }

  // ---------------------------------------------------------------------------
  // Metadata / data
  // ---------------------------------------------------------------------------

  async structure(profileId: string, object: ObjectPath, refresh = false): Promise<TableStructure> {
    const l = this.get(profileId);
    const k = keyOf(object);
    if (!refresh) {
      const cached = l.structures.get(k);
      if (cached) return { ...cached, gridSaveVersion: 2 };
    }
    const s = await l.conn.getStructure(object);
    l.structures.set(k, s);
    return { ...s, gridSaveVersion: 2 };
  }

  private async browseColumns(profileId: string, object: ObjectPath) {
    try {
      const s = await this.structure(profileId, object);
      if (s.columnsStatus.state === 'ok') return s.columns;
    } catch {
      // Browse with SELECT * when structure cannot be read.
    }
    return undefined;
  }

  async previewBrowse(profileId: string, req: BrowseRequest) {
    const l = this.get(profileId);
    return l.conn.dialect.buildBrowse(req, await this.browseColumns(profileId, req.object));
  }

  async browse(profileId: string, req: BrowseRequest) {
    const l = this.get(profileId);
    const columns = await this.browseColumns(profileId, req.object);
    const result = await runBrowse(l.conn, req, columns);
    if (!result.hasMore && (req.offset === 0 || result.rows.length > 0)) {
      return { ...result, totalRows: String(req.offset + result.rows.length) };
    }

    const source = l.conn.dialect.buildBrowseAll({ object: req.object, filters: req.filters }, columns);
    if (source.errors.length) return result;
    const count = l.conn.driver === 'mssql' ? 'COUNT_BIG(*)' : 'COUNT(*)';
    const cursor = l.conn.openCursor({
      sql: `SELECT ${count} AS total_rows FROM (${source.sql}) AS earthql_count`,
      params: source.params,
    }, ctxForObject(req.object));
    try {
      const chunk = await cursor.fetch(1);
      const value = String(chunk.rows[0]?.[0] ?? '');
      return /^\d+$/.test(value) ? { ...result, totalRows: value } : result;
    } catch {
      // A failed count should not prevent browsing the page.
      return result;
    } finally {
      await cursor.close().catch(() => undefined);
    }
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
      if (out.open && this.live.get(profileId) === l) {
        const cursorId = randomUUID();
        this.cursors.set(cursorId, { profileId, cursor: out.open.cursor, columns: out.open.columns, lastUsed: Date.now() });
        out.results[out.open.statementIndex].cursorId = cursorId;
      } else if (out.open) {
        await out.open.cursor.close().catch(() => undefined);
      }
      const statusOf = (): HistoryEntry['status'] => {
        if (out.results.some((r) => r.status === 'outcome_unknown')) return 'outcome_unknown';
        if (out.results.some((r) => r.status === 'cancelled')) return 'cancelled';
        if (out.results.some((r) => r.status === 'error')) return 'error';
        return 'ok';
      };
      if (out.results.length > 0) {
        addHistory(l.profile.id, {
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

  async saveGrid(profileId: string, object: ObjectPath, changes: GridChanges) {
    const { conn } = this.get(profileId);
    return runGridSave(conn, await this.structure(profileId, object, true), changes);
  }

  async deleteRows(profileId: string, object: ObjectPath, rows: GridRowDelete[]) {
    const { conn } = this.get(profileId);
    const structure = await this.structure(profileId, object, true);
    return runGridDeletes(conn, structure, rows);
  }

  /** Text form of INSERT statements for the given already-loaded rows, for "Copy as INSERT Statement". */
  async rowsAsInsert(profileId: string, object: ObjectPath, columns: ResultColumn[], rows: Cell[][]): Promise<string> {
    const { conn } = this.get(profileId);
    let metadata: (TableStructure['columns'][number] | undefined)[] = columns.map(() => undefined);
    try {
      const structure = await this.structure(profileId, object);
      if (structure.columnsStatus.state === 'ok') metadata = columns.map((column) => structure.columns.find((info) => info.name === column.name));
    } catch {
      // Fall back to no column metadata (plain literal quoting by result type) when structure is unavailable.
    }
    return insertStatementText(object, columns, rows, metadata, conn.dialect);
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
