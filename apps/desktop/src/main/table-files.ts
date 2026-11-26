import { BrowserWindow, dialog } from 'electron';
import fs from 'node:fs';
import { mkdtemp, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { finished, pipeline } from 'node:stream/promises';
import { createGzip, gunzipSync } from 'node:zlib';
import archiver from 'archiver';
import ExcelJS from 'exceljs';
import { cellToText, ctxForObject, describePath, makeError, splitStatements, isBinaryCell, type Cell, type DriverConnection, type InsertSpec, type ObjectPath, type QueryCursor, type ResultColumn } from '@earthql/core';
import type { ExportResult, TableExportItem, TableExportOptions, TableImportFormat, TableImportPreview, TableImportResult } from '../shared/api';
import type { SessionManager } from './sessions';
import { csvRecord, insertStatementLine, jsonRecord, parseImport, safeFileName, structureSql } from './table-file-formats';

const MAX_IMPORT = 64 * 1024 * 1024;
const jobs = new Map<string, { cancelled: boolean; cursor?: QueryCursor; runId?: string }>();
interface ImportPlan {
  profileId: string;
  object: ObjectPath;
  format: TableImportFormat;
  columns: string[];
  rows: (string | null)[][];
  sql?: string;
  expires: number;
  cancelled?: boolean;
}
const plans = new Map<string, ImportPlan>();
function windowForDialog() { return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]; }
function outputStream(file: string) {
  const stream = fs.createWriteStream(file, { flags: 'wx' });
  // Keep an error listener until finished() observes early filesystem errors.
  stream.on('error', () => undefined);
  return stream;
}
async function write(out: fs.WriteStream, text: string) {
  await new Promise<void>((resolve, reject) => out.write(text, (error) => error ? reject(error) : resolve()));
}
async function end(out: fs.WriteStream) { out.end(); await finished(out); }

/** Best-effort COUNT(*) of every exported table so progress can show rows/total. */
async function countExportRows(conn: DriverConnection, items: TableExportItem[], job: { cancelled: boolean; cursor?: QueryCursor }): Promise<number | undefined> {
  const count = conn.driver === 'mssql' ? 'COUNT_BIG(*)' : 'COUNT(*)';
  let total = 0;
  for (const item of items) {
    if (!item.data) continue;
    if (job.cancelled) return undefined;
    const cursor = conn.openCursor({ sql: `SELECT ${count} AS total_rows FROM ${conn.dialect.qualify(item.object)}` }, ctxForObject(item.object));
    job.cursor = cursor;
    try {
      const chunk = await cursor.fetch(1);
      const value = String(chunk.rows[0]?.[0] ?? '');
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) return undefined;
      total += Number(value);
    } catch {
      // A failed count must never block the export; the progress bar just stays indeterminate.
      return undefined;
    } finally { await cursor.close().catch(() => undefined); job.cursor = undefined; }
  }
  return total;
}

export function cancelTableFileJob(id: string, sessions: SessionManager): void {
  const plan = plans.get(id);
  if (plan) plan.cancelled = true;
  const job = jobs.get(id);
  if (job) { job.cancelled = true; void job.cursor?.cancel(); if (job.runId) void sessions.cancel(job.runId); }
}
export function releaseTableImport(token: string): void { if (!jobs.has(token)) plans.delete(token); }
export function tableImportTarget(token: string): { profileId: string; object: ObjectPath } {
  const plan = plans.get(token);
  if (!plan || plan.expires < Date.now()) throw makeError('config', 'This import preview expired. Choose the file again.');
  return { profileId: plan.profileId, object: plan.object };
}

export async function exportTables(sessions: SessionManager, exportId: string, profileId: string, items: TableExportItem[], options: TableExportOptions): Promise<ExportResult> {
  if (jobs.has(exportId)) throw makeError('config', 'This export is already running.');
  if (!items.length || !['csv', 'json', 'sql', 'xlsx'].includes(options.format)) throw makeError('config', 'Select at least one table and a supported format.');
  if (![',', ';', '\t', '|'].includes(options.delimiter) || !['\n', '\r\n'].includes(options.lineBreak)) throw makeError('config', 'Invalid CSV settings.');
  if (options.format === 'sql' && items.some((item) => item.drop && !item.structure)) throw makeError('config', 'DROP requires Structure to be selected for that table.');
  if (items.some((item) => !item.data && !(options.format === 'sql' && item.structure))) throw makeError('config', 'Select data or structure for each exported table.');
  const { conn } = sessions.get(profileId);
  const job: { cancelled: boolean; cursor?: QueryCursor } = { cancelled: false };
  jobs.set(exportId, job);
  const zipped = items.length > 1 && (options.format === 'csv' || options.format === 'json');
  const ext = zipped ? 'zip' : options.format + (options.format === 'sql' && options.gzip ? '.gz' : '');
  const base = safeFileName(options.suggestedName.replace(/\.(csv|json|sql|xlsx|zip)(\.gz)?$/i, ''));
  let folder: string | undefined;
  let rows = 0;
  let total: number | undefined;
  const outputs: fs.WriteStream[] = [];
  const progress = (done = false) => windowForDialog()?.webContents.send('export:progress', { exportId, rows, total, done });
  try {
    const chosen = await dialog.showSaveDialog(windowForDialog(), { title: 'Export tables', defaultPath: path.join(os.homedir(), 'Downloads', `${base}.${ext}`), filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
    if (chosen.canceled || !chosen.filePath) return { status: 'dialog-cancelled' };
    if (job.cancelled) return { status: 'cancelled-by-user', rows };
    total = await countExportRows(conn, items, job);
    progress();
    folder = await mkdtemp(path.join(path.dirname(chosen.filePath), '.earthql-export-'));
    const destination = path.join(folder, 'output');
    const out = outputStream(destination); outputs.push(out);
    const archive = zipped ? archiver('zip', { zlib: { level: 6 } }) : null;
    let archiveFailure: Error | undefined;
    archive?.on('error', (error) => { archiveFailure = error; out.destroy(error); });
    archive?.on('warning', (error) => { archiveFailure = error; out.destroy(error); });
    if (archive) archive.pipe(out);
    const workbook = options.format === 'xlsx' ? new ExcelJS.stream.xlsx.WorkbookWriter({ stream: out, useStyles: false, useSharedStrings: false }) : null;
    const usedNames = new Set<string>();
    const uniqueName = (name: string, max = 140) => {
      const cleaned = safeFileName(name).replace(/[\[\]]/g, '_').replace(/^'+|'+$/g, '_').slice(0, max) || 'Table';
      let candidate = cleaned, n = 1;
      while (usedNames.has(candidate.toLowerCase())) { const suffix = `-${++n}`; candidate = cleaned.slice(0, max - suffix.length) + suffix; }
      usedNames.add(candidate.toLowerCase()); return candidate;
    };
    for (const item of items) {
      if (job.cancelled) break;
      const structure = await sessions.structure(profileId, item.object);
      if (structure.kind === 'view' && options.format === 'sql' && (item.structure || item.drop)) throw makeError('unsupported', 'View structure exports are unavailable here. Export Data only.');
      let targetOut = out;
      let targetFile: string | undefined;
      if (archive) { targetFile = path.join(folder, `${uniqueName(describePath(item.object))}.${options.format}`); targetOut = outputStream(targetFile); outputs.push(targetOut); }
      const worksheet = workbook?.addWorksheet(uniqueName(item.object.name, 31));
      if (options.format === 'sql') {
        await write(targetOut, `-- EarthQL export: ${describePath(item.object).replace(/[\r\n]/g, ' ')}\n`);
        if (item.structure) {
          let ddl: string;
          if (conn.driver === 'mysql') {
            const cursor = conn.openCursor({ sql: `SHOW CREATE TABLE ${conn.dialect.qualify(item.object)}` }, ctxForObject(item.object)); job.cursor = cursor;
            try { const chunk = await cursor.fetch(1); ddl = `${cellToText(chunk.rows[0]?.[1] ?? '')};\n`; if (!chunk.rows[0]?.[1]) throw makeError('unsupported', 'The database did not return a table definition.'); }
            finally { await cursor.close(); job.cursor = undefined; }
          } else ddl = structureSql(structure, conn.dialect);
          if (item.drop) await write(targetOut, `DROP TABLE IF EXISTS ${conn.dialect.qualify(item.object)};\n`);
          await write(targetOut, ddl);
        }
      }
      if (options.format === 'json') await write(targetOut, '[\n');
      let firstRow = true;
      let columns: ResultColumn[] | null = null;
      let tableRows = 0;
      if (item.data) {
        const query = conn.dialect.buildBrowseAll({ object: item.object, filters: [] }, structure.columnsStatus.state === 'ok' ? structure.columns : undefined);
        if (query.errors.length) throw makeError('config', query.errors.join('\n'));
        const cursor = conn.openCursor({ sql: query.sql, params: query.params }, ctxForObject(item.object)); job.cursor = cursor;
        try {
          for (;;) {
            if (job.cancelled) break;
            const chunk = await cursor.fetch(1000);
            if (!columns) {
              columns = chunk.columns ?? [];
              if (new Set(columns.map((column) => column.name)).size !== columns.length) throw makeError('unsupported', 'Duplicate result column names cannot be exported without losing data.');
              if (options.format === 'sql' && conn.driver === 'mssql' && structure.columns.some((column) => column.isIdentity)) await write(targetOut, `SET IDENTITY_INSERT ${conn.dialect.qualify(item.object)} ON;\n`);
              if (options.format === 'csv') {
                if (options.bom) await write(targetOut, '\uFEFF');
                if (options.headers) await write(targetOut, csvRecord(columns.map((column) => column.name), options));
              }
              if (worksheet && options.headers) worksheet.addRow(columns.map((column) => column.name)).commit();
            }
            const metadata = columns.map((column) => structure.columns.find((info) => info.name === column.name));
            const numeric = metadata.map((column) => column?.kind === 'number');
            for (const row of chunk.rows) {
              if (job.cancelled) break;
              if (row.some((cell) => isBinaryCell(cell) && cell.truncated)) throw makeError('unsupported', 'This driver returned truncated binary data. Use a native database dump for a lossless export.');
              if (options.format === 'csv') await write(targetOut, csvRecord(row, options, numeric));
              if (options.format === 'json') { await write(targetOut, `${firstRow ? '' : ',\n'}  ${jsonRecord(columns, row)}`); firstRow = false; }
              if (options.format === 'sql') {
                await write(targetOut, `${insertStatementLine(item.object, columns, row, metadata, conn.dialect)}\n`);
              }
              if (worksheet) {
                if (tableRows + (options.headers ? 1 : 0) >= 1048576) throw makeError('unsupported', 'Excel supports at most 1,048,576 rows per sheet. Export CSV or JSON instead.');
                worksheet.addRow(row.map((cell) => cell === null ? null : typeof cell === 'object' ? cellToText(cell) : cell)).commit();
              }
              tableRows++; rows++;
            }
            progress();
            if (chunk.done) break;
          }
        } finally { await cursor.close().catch(() => undefined); job.cursor = undefined; }
      }
      if (options.format === 'sql' && item.data && conn.driver === 'mssql' && structure.columns.some((column) => column.isIdentity)) await write(targetOut, `SET IDENTITY_INSERT ${conn.dialect.qualify(item.object)} OFF;\n`);
      if (options.format === 'json') await write(targetOut, '\n]\n');
      worksheet?.commit();
      if (archive && targetFile) { await end(targetOut); archive.file(targetFile, { name: path.basename(targetFile) }); }
    }
    if (job.cancelled) { out.destroy(); return { status: 'cancelled-by-user', rows }; }
    if (archive) { await archive.finalize(); await finished(out); if (archiveFailure) throw archiveFailure; }
    else if (workbook) { await workbook.commit(); await finished(out); }
    else await end(out);
    let readyFile = destination;
    if (options.format === 'sql' && options.gzip) {
      readyFile = path.join(folder, 'compressed');
      const compressed = outputStream(readyFile); outputs.push(compressed);
      await pipeline(fs.createReadStream(destination), createGzip(), compressed);
    }
    if (job.cancelled) return { status: 'cancelled-by-user', rows };
    await rename(readyFile, chosen.filePath);
    progress(true);
    return { status: 'ok', rows, path: chosen.filePath };
  } catch (error) {
    return job.cancelled ? { status: 'cancelled-by-user', rows } : { status: 'error', rows, error: sessions.errorFor(profileId, error) };
  } finally {
    jobs.delete(exportId);
    for (const stream of outputs) stream.destroy();
    if (folder) await rm(folder, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function readTableImport(sessions: SessionManager, profileId: string, object: ObjectPath, format: TableImportFormat, options: { delimiter: string; headers: boolean }): Promise<TableImportPreview | null> {
  for (const [token, plan] of plans) if (plan.expires < Date.now()) plans.delete(token);
  if (plans.size >= 12) throw makeError('config', 'Close another import window before opening a new file.');
  if (!['csv', 'json', 'sql'].includes(format)) throw makeError('config', 'Unsupported import format.');
  const { conn } = sessions.get(profileId);
  const structure = await sessions.structure(profileId, object, true);
  if (structure.kind !== 'table') throw makeError('unsupported', 'Import into a base table instead of a view.');
  const chosen = await dialog.showOpenDialog(windowForDialog(), { title: `Import ${format.toUpperCase()}`, properties: ['openFile'], filters: [{ name: format.toUpperCase(), extensions: format === 'sql' ? ['sql', 'gz'] : [format] }] });
  if (chosen.canceled || !chosen.filePaths[0]) return null;
  const info = await stat(chosen.filePaths[0]);
  if (!info.isFile() || info.size > MAX_IMPORT) throw makeError('config', 'Choose a file up to 64 MB.');
  const bytes = await readFile(chosen.filePaths[0]);
  const text = (format === 'sql' && bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes, { maxOutputLength: MAX_IMPORT }) : bytes).toString('utf8').replace(/^\uFEFF/, '');
  if (text.includes('\uFFFD')) throw makeError('config', 'The file is not valid UTF-8. Save it as UTF-8 before importing.');
  const parsed = format === 'sql' ? { columns: [], rows: [] } : parseImport(text, format, options);
  if (parsed.rows.length > 200000) throw makeError('config', 'Import at most 200,000 rows per file. Split this file into smaller parts.');
  let statements: number | undefined;
  if (format === 'sql') {
    if (/^\s*(DELIMITER\b|COPY\b[\s\S]*?FROM\s+stdin\s*;|\\(?:connect|copy|\.))/im.test(text)) throw makeError('unsupported', 'This dump contains native client commands (DELIMITER, COPY FROM stdin, or backslash commands). Use a plain SQL dump with INSERT statements.');
    statements = splitStatements(text, conn.driver).length;
    if (!statements) throw makeError('config', 'The file contains no SQL statements.');
  } else if (!parsed.rows.length) throw makeError('config', 'The file contains no data rows.');
  const token = randomUUID();
  plans.set(token, { profileId, object, format, ...parsed, sql: format === 'sql' ? text : undefined, expires: Date.now() + 30 * 60 * 1000 });
  return { token, fileName: path.basename(chosen.filePaths[0]), columns: parsed.columns, sample: parsed.rows.slice(0, 8), rows: parsed.rows.length, statements, sqlPreview: format === 'sql' ? text.slice(0, 20000) : undefined, targetColumns: structure.columns.map((column) => ({ name: column.name, type: column.type, nullable: column.nullable, generated: !!column.isGenerated || !!column.isIdentity })) };
}

export async function importTable(sessions: SessionManager, token: string, mapping: Record<string, string>, emptyAsNull: boolean): Promise<TableImportResult> {
  const plan = plans.get(token);
  if (!plan || plan.expires < Date.now()) throw makeError('config', 'This import preview expired. Choose the file again.');
  if (jobs.has(token)) throw makeError('config', 'This import is already running.');
  if (plan.cancelled) { plans.delete(token); return { status: 'cancelled', rows: 0 }; }
  const job: { cancelled: boolean; runId?: string } = { cancelled: false };
  jobs.set(token, job);
  let rows = 0;
  let started = false;
  try {
    if (plan.sql !== undefined) {
      job.runId = token; started = true;
      const result = await sessions.run(plan.profileId, token, plan.sql, ctxForObject(plan.object), 100);
      for (const statement of result.results) if (statement.cursorId) await sessions.closeCursor(statement.cursorId);
      rows = result.results.filter((statement) => statement.status === 'ok').reduce((sum, statement) => sum + (statement.rowsAffected ?? 0), 0);
      const failed = result.results.find((statement) => !['ok', 'skipped'].includes(statement.status));
      if (!failed && job.cancelled && result.results.some((statement) => statement.status === 'skipped')) return { status: 'cancelled', rows, statements: result.results.filter((statement) => statement.status === 'ok').length };
      return { status: failed?.status === 'outcome_unknown' ? 'outcome_unknown' : failed ? failed.status === 'cancelled' ? 'cancelled' : 'error' : 'ok', rows, statements: result.results.filter((statement) => statement.status === 'ok').length, error: failed?.error };
    }
    const { conn } = sessions.get(plan.profileId);
    if (!conn.capabilities().insert) throw makeError('unsupported', 'This connection does not support importing rows.');
    const structure = await sessions.structure(plan.profileId, plan.object, true);
    const chosen = plan.columns.map((source, index) => ({ index, name: mapping[source], info: structure.columns.find((column) => column.name === mapping[source]) })).filter((column) => column.name);
    if (!chosen.length || chosen.some((column) => !column.info || column.info.isGenerated || column.info.isIdentity) || new Set(chosen.map((column) => column.name)).size !== chosen.length) throw makeError('config', 'Map at least one source field to a unique, writable target column.');
    const batchSize = Math.max(1, Math.min(100, Math.floor(2000 / chosen.length), conn.dialect.maxInsertRows));
    const specFor = (offset: number): InsertSpec => ({
      object: plan.object,
      columns: chosen.map(({ info }) => ({ name: info!.name, type: info!.type, kind: info!.kind })),
      rows: plan.rows.slice(offset, offset + batchSize).map((row, rowIndex) => Object.fromEntries(chosen.map(({ index, name, info }) => {
        const value = row[index];
        const isNull = value === null || (emptyAsNull && value === '');
        if (isNull && info?.nullable === false) throw makeError('config', `Row ${offset + rowIndex + 1}: ${name} does not allow NULL.`);
        return [name, isNull ? { kind: 'null' } : { kind: 'value', value }];
      }))),
    });
    // Validate every batch before writing any rows.
    for (let offset = 0; offset < plan.rows.length; offset += batchSize) {
      const statement = conn.dialect.buildInsert(specFor(offset));
      if (statement.errors.length) throw makeError('config', statement.errors.join('\n'));
    }
    for (let offset = 0; offset < plan.rows.length; offset += batchSize) {
      if (job.cancelled) return { status: 'cancelled', rows };
      started = true;
      const spec = specFor(offset);
      const result = await sessions.insert(plan.profileId, spec);
      if (result.status !== 'ok') return { status: result.status, rows, error: result.error };
      rows += spec.rows.length;
      windowForDialog()?.webContents.send('export:progress', { exportId: token, rows, done: false });
    }
    return { status: 'ok', rows };
  } catch (error) { return { status: 'error', rows, error: sessions.errorFor(plan.profileId, error) }; }
  finally { jobs.delete(token); if (started) plans.delete(token); }
}
