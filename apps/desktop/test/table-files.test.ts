import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import ExcelJS from 'exceljs';
import { mysqlDialect } from '@earthql/driver-mysql';
import { postgresDialect } from '@earthql/driver-postgres';
import { mssqlDialect } from '@earthql/driver-mssql';
import { databricksDialect } from '@earthql/driver-databricks';
import type { SessionManager } from '../src/main/sessions';
import type { TableExportOptions } from '../src/shared/api';
const mocks = vi.hoisted(() => ({ save: vi.fn(), open: vi.fn(), send: vi.fn() }));
vi.mock('electron', () => ({ BrowserWindow: { getFocusedWindow: () => ({ webContents: { send: mocks.send } }) }, dialog: { showSaveDialog: mocks.save, showOpenDialog: mocks.open } }));
import { cancelTableFileJob, exportTables, importTable, readTableImport, releaseTableImport } from '../src/main/table-files';

const options: TableExportOptions = { format: 'csv', suggestedName: 'test', delimiter: ',', quote: 'needed', lineBreak: '\n', decimal: '.', headers: true, nullToEmpty: true, replaceLineBreaks: false, bom: false, gzip: false };
const object = { database: 'demo', name: 't' };
const item = { object, data: true, structure: false, drop: false };
const structure = { object, kind: 'table', columnsStatus: { state: 'ok' }, columns: [{ name: 'id', type: 'BIGINT', kind: 'number', nullable: false, isPrimaryKey: true, defaultValue: null }, { name: 'name', type: 'text', kind: 'text', nullable: true, defaultValue: null }], indexes: [], constraints: [], constraintsStatus: { state: 'empty' }, indexesStatus: { state: 'empty' } };
let folder: string;
const insert = vi.fn();
const runSql = vi.fn();
const closeCursor = vi.fn();
let failFetch = false;
let failCount = false;
let cancelId: string | undefined;
const sessions = {
  get: () => ({ conn: { driver: 'mysql', dialect: mysqlDialect, capabilities: () => ({ insert: true }), openCursor: (statement: {sql: string}) => ({
    fetch: async () => {
      if (cancelId) cancelTableFileJob(cancelId, sessions as unknown as SessionManager);
      if (statement.sql.startsWith('SELECT COUNT')) {
        if (failCount) throw Error('count failed');
        return { columns: [{ name: 'total_rows', type: 'BIGINT', kind: 'number' }], rows: [['2']], done: true };
      }
      if (failFetch) throw Error('fetch failed');
      if (statement.sql.startsWith('SHOW CREATE')) return { rows: [['t', 'CREATE TABLE `demo`.`t` (`id` bigint, `name` text)']], done: true };
      return { columns: [{ name: 'id', type: 'BIGINT', kind: 'number' }, { name: 'name', type: 'text', kind: 'text' }], rows: [['9223372036854775807', 'ไทย'], ['2', '=SUM(A1:A2)']], done: true };
    }, close: vi.fn(async () => undefined), cancel: vi.fn(async () => 'requested'),
  }) } }),
  structure: async () => structure,
  errorFor: (_: unknown, error: Error) => ({ category: 'unknown', message: error.message }),
  insert,
  run: runSql,
  closeCursor,
  cancel: vi.fn(),
} as unknown as SessionManager;

beforeEach(async () => {
  folder = await mkdtemp(path.join(os.tmpdir(), 'earthql-table-test-'));
  mocks.save.mockImplementation(async () => ({ canceled: false, filePath: path.join(folder, 'output') }));
  insert.mockReset(); insert.mockResolvedValue({ status: 'ok' }); runSql.mockReset(); closeCursor.mockReset(); failFetch = false; failCount = false; cancelId = undefined; mocks.send.mockClear();
});
afterEach(async () => { await rm(folder, { recursive: true, force: true }); });

describe('table file exports', () => {
  it('writes CSV, JSON and compressed SQL containing the real rows', async () => {
    expect((await exportTables(sessions, 'csv', 'p', [item], options)).status).toBe('ok');
    expect(await readFile(path.join(folder, 'output'), 'utf8')).toContain('9223372036854775807,ไทย');
    expect((await exportTables(sessions, 'json', 'p', [item], { ...options, format: 'json' })).status).toBe('ok');
    expect(JSON.parse(await readFile(path.join(folder, 'output'), 'utf8'))[0]).toEqual({ id: '9223372036854775807', name: 'ไทย' });
    expect((await exportTables(sessions, 'sql', 'p', [{ ...item, structure: true, drop: true }], { ...options, format: 'sql', gzip: true })).status).toBe('ok');
    const sql = gunzipSync(await readFile(path.join(folder, 'output'))).toString('utf8');
    expect(sql).toContain('DROP TABLE IF EXISTS'); expect(sql).toContain('CREATE TABLE'); expect(sql).toContain("VALUES (9223372036854775807, 'ไทย')");
  });
  it('writes real XLSX sheets and keeps formula-looking text and long IDs as text', async () => {
    expect((await exportTables(sessions, 'xlsx', 'p', [item, { ...item, object: { ...object, name: 'other' } }], { ...options, format: 'xlsx' })).status).toBe('ok');
    const book = new ExcelJS.Workbook(); await book.xlsx.readFile(path.join(folder, 'output'));
    expect(book.worksheets).toHaveLength(2);
    expect(book.worksheets[0].getCell('A2').value).toBe('9223372036854775807');
    expect(book.worksheets[0].getCell('B3').value).toBe('=SUM(A1:A2)');
  });
  it('bundles multiple CSV files into ZIP', async () => {
    const result = await exportTables(sessions, 'zip', 'p', [item, { ...item, object: { ...object, name: 'other' } }], options);
    expect(result.status).toBe('ok');
    const unzipper = await import('unzipper');
    const archive = await unzipper.Open.file(path.join(folder, 'output'));
    expect(archive.files.map((file) => file.path).sort()).toEqual(['demo.other.csv', 'demo.t.csv']);
    expect((await archive.files[0].buffer()).toString('utf8')).toContain('ไทย');
  });
  it('keeps an existing destination intact on failure or cancellation and cleans temporary files', async () => {
    await writeFile(path.join(folder, 'output'), 'existing data');
    failFetch = true;
    expect((await exportTables(sessions, 'fail', 'p', [item], options)).status).toBe('error');
    expect(await readFile(path.join(folder, 'output'), 'utf8')).toBe('existing data');
    failFetch = false; cancelId = 'cancel';
    expect((await exportTables(sessions, 'cancel', 'p', [item], options)).status).toBe('cancelled-by-user');
    expect(await readFile(path.join(folder, 'output'), 'utf8')).toBe('existing data');
    expect(await readdir(folder)).toEqual(['output']);
  });
  it('counts total rows up front and reports rows/total in progress events', async () => {
    expect((await exportTables(sessions, 'total', 'p', [item, { ...item, object: { ...object, name: 'other' } }], options)).status).toBe('ok');
    const events = mocks.send.mock.calls.filter(([channel]) => channel === 'export:progress').map(([, payload]) => payload as { exportId: string; rows: number; total?: number; done: boolean });
    expect(events[0]).toMatchObject({ exportId: 'total', rows: 0, total: 4, done: false });
    expect(events.at(-1)).toMatchObject({ rows: 4, total: 4, done: true });
  });
  it('still exports when counting fails, with an unknown total', async () => {
    failCount = true;
    expect((await exportTables(sessions, 'nocount', 'p', [item], options)).status).toBe('ok');
    expect(await readFile(path.join(folder, 'output'), 'utf8')).toContain('ไทย');
    const events = mocks.send.mock.calls.filter(([channel]) => channel === 'export:progress').map(([, payload]) => payload as { total?: number });
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) expect(event.total).toBeUndefined();
  });
});

describe('export row counting per driver', () => {
  const object = { database: 'demo', name: 't' };
  const item = { object, data: true, structure: false, drop: false };
  const drivers = [
    { driver: 'postgres', dialect: postgresDialect, count: 'COUNT(*)' },
    { driver: 'mysql', dialect: mysqlDialect, count: 'COUNT(*)' },
    { driver: 'mssql', dialect: mssqlDialect, count: 'COUNT_BIG(*)' },
    { driver: 'databricks', dialect: databricksDialect, count: 'COUNT(*)' },
  ] as const;
  for (const { driver, dialect, count } of drivers) {
    it(`uses ${count} with the ${driver} dialect's qualified name`, async () => {
      const countSqls: string[] = [];
      const driverSessions = {
        get: () => ({ conn: { driver, dialect, capabilities: () => ({ insert: true }), openCursor: (statement: { sql: string }) => ({
          fetch: async () => {
            if (statement.sql.startsWith('SELECT COUNT')) { countSqls.push(statement.sql); return { columns: [{ name: 'total_rows', type: 'BIGINT', kind: 'number' }], rows: [['1']], done: true }; }
            return { columns: [{ name: 'id', type: 'BIGINT', kind: 'number' }], rows: [['1']], done: true };
          }, close: vi.fn(async () => undefined), cancel: vi.fn(async () => 'requested'),
        }) } }),
        structure: async () => ({ ...structure, columns: [structure.columns[0]] }),
        errorFor: (_: unknown, error: Error) => ({ category: 'unknown', message: error.message }),
      } as unknown as SessionManager;
      expect((await exportTables(driverSessions, `count-${driver}`, 'p', [item], options)).status).toBe('ok');
      expect(countSqls).toEqual([`SELECT ${count} AS total_rows FROM ${dialect.qualify(object)}`]);
      const events = mocks.send.mock.calls.filter(([channel]) => channel === 'export:progress').map(([, payload]) => payload as { total?: number });
      expect(events[0]?.total).toBe(1);
    });
  }
});

describe('table file imports', () => {
  async function csv(contents: string) {
    const file = path.join(folder, 'input.csv'); await writeFile(file, contents);
    mocks.open.mockResolvedValue({ canceled: false, filePaths: [file] });
    return (await readTableImport(sessions, 'p', object, 'csv', { delimiter: ',', headers: true }))!;
  }
  it('previews rows without writing, then imports only mapped columns', async () => {
    const preview = await csv('id,name\n1,ไทย\n2,"comma,quote"');
    expect(preview.rows).toBe(2); expect(preview.sample[1]).toEqual(['2', 'comma,quote']); expect(insert).not.toHaveBeenCalled();
    const result = await importTable(sessions, preview.token, { id: 'id', name: 'name' }, false);
    expect(result).toMatchObject({ status: 'ok', rows: 2 });
    expect(insert.mock.calls[0][1].rows[0]).toEqual({ id: { kind: 'value', value: '1' }, name: { kind: 'value', value: 'ไทย' } });
    await expect(importTable(sessions, preview.token, { id: 'id' }, false)).rejects.toThrow();
  });
  it('validates all rows and duplicate mappings before writing any data', async () => {
    const preview = await csv('id,name\n1,ok\n,last');
    expect((await importTable(sessions, preview.token, { id: 'id', name: 'name' }, true)).status).toBe('error');
    expect(insert).not.toHaveBeenCalled();
    expect((await importTable(sessions, preview.token, { id: 'name', name: 'name' }, false)).status).toBe('error');
    expect(insert).not.toHaveBeenCalled(); releaseTableImport(preview.token);
  });
  it('reports confirmed rows when a later batch fails', async () => {
    const preview = await csv('id,name\n' + Array.from({ length: 120 }, (_, i) => `${i},row`).join('\n'));
    insert.mockResolvedValueOnce({ status: 'ok' }).mockResolvedValueOnce({ status: 'error', error: { category: 'permission', message: 'Denied' } });
    expect(await importTable(sessions, preview.token, { id: 'id', name: 'name' }, false)).toMatchObject({ status: 'error', rows: 100 });
  });
  it('imports JSON without rounding numeric values', async () => {
    const file = path.join(folder, 'input.json');
    await writeFile(file, '[{"id":9223372036854775807,"name":"ไทย"}]');
    mocks.open.mockResolvedValue({ canceled: false, filePaths: [file] });
    const preview = (await readTableImport(sessions, 'p', object, 'json', { delimiter: ',', headers: true }))!;
    expect(preview.sample[0][0]).toBe('9223372036854775807');
    expect((await importTable(sessions, preview.token, { id: 'id', name: 'name' }, false)).status).toBe('ok');
    expect(insert.mock.calls[0][1].rows[0].id.value).toBe('9223372036854775807');
  });
  it('reviews SQL dumps before execution and reports a partially completed script', async () => {
    const file = path.join(folder, 'input.sql');
    await writeFile(file, 'INSERT INTO t VALUES (1); INSERT INTO t VALUES (2);');
    mocks.open.mockResolvedValue({ canceled: false, filePaths: [file] });
    const preview = (await readTableImport(sessions, 'p', object, 'sql', { delimiter: ',', headers: true }))!;
    expect(preview.statements).toBe(2); expect(runSql).not.toHaveBeenCalled();
    runSql.mockResolvedValue({ results: [{ status: 'ok', rowsAffected: 1, cursorId: 'open' }, { status: 'error', error: { category: 'permission', message: 'Denied' } }] });
    expect(await importTable(sessions, preview.token, {}, false)).toMatchObject({ status: 'error', rows: 1, statements: 1 });
    expect(runSql).toHaveBeenCalledWith('p', preview.token, expect.stringContaining('INSERT INTO'), { database: 'demo' }, 100);
    expect(closeCursor).toHaveBeenCalledWith('open');
  });
  it('rejects native client dump commands before running anything', async () => {
    const file = path.join(folder, 'native.sql');
    await writeFile(file, 'COPY t FROM stdin;\n1\n\\.');
    mocks.open.mockResolvedValue({ canceled: false, filePaths: [file] });
    await expect(readTableImport(sessions, 'p', object, 'sql', { delimiter: ',', headers: true })).rejects.toThrow();
    expect(runSql).not.toHaveBeenCalled();
  });

});
