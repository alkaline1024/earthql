import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ConnectionProfile } from '@earthql/core';
import { openAppBackup, parseAppBackup, restoreAppBackup, saveAppBackup } from '../src/main/app-backup';
import { loadHistory, loadProfiles, loadSaved, saveProfiles, writeHistory, writeSaved } from '../src/main/store';

const electron = vi.hoisted(() => ({ getPath: vi.fn(), save: vi.fn(), open: vi.fn() }));
vi.mock('electron', () => ({
  app: { getPath: electron.getPath },
  BrowserWindow: { getFocusedWindow: () => ({}), getAllWindows: () => [] },
  dialog: { showSaveDialog: electron.save, showOpenDialog: electron.open },
}));

const base = { name: 'Original', env: { name: 'Local', color: '#7755aa' }, createdAt: 1, updatedAt: 2, host: 'localhost' };
const db = { port: 1234, user: 'user', database: 'example', tls: { mode: 'verify' as const } };
const profiles: ConnectionProfile[] = [
  { ...base, ...db, id: 'pg', driver: 'postgres' },
  { ...base, ...db, id: 'my', driver: 'mysql', database: undefined },
  { ...base, ...db, id: 'ss', driver: 'mssql' },
  { ...base, id: 'db', driver: 'databricks', httpPath: '/warehouse', authMode: 'access-token' },
];
const query = { id: 'query-id', name: 'Read', sql: 'SELECT 1', createdAt: 1, updatedAt: 2 };
const history = { id: 'run-id', sql: 'SELECT 1', ranAt: 1, durationMs: 1, status: 'ok' as const, context: {}, statements: 1 };
let directory: string;
let file: string;

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'earthql-backup-test-'));
  file = path.join(directory, 'backup.json');
  electron.getPath.mockReturnValue(directory);
  electron.save.mockResolvedValue({ canceled: false, filePath: file });
  electron.open.mockResolvedValue({ canceled: false, filePaths: [file] });
});
afterEach(async () => {
  vi.resetAllMocks();
  await fs.rm(directory, { recursive: true, force: true });
});

describe('EarthQL backup files', () => {
  it('round trips selected categories and keeps existing profiles and queries by ID', async () => {
    saveProfiles(profiles);
    writeSaved('pg', [query]);
    writeHistory('pg', [history]);
    expect(await saveAppBackup({
      connections: { 'earthql.connectionOrder': '["pg"]' },
      bookmarks: { 'earthql.pinnedTables': '["pg|test"]' },
      queries: {},
      history: {},
    })).toBe('backup.json');
    const result = await openAppBackup();
    expect(result?.preview.settings).toEqual({
      connections: { 'earthql.connectionOrder': '["pg"]' },
      bookmarks: { 'earthql.pinnedTables': '["pg|test"]' },
      queries: {},
      history: {},
    });
    const existing = { ...profiles[0], name: 'Keep local name' };
    const existingQuery = { ...query, name: 'Keep local query' };
    saveProfiles([existing]);
    writeSaved('pg', [existingQuery]);
    writeHistory('pg', []);
    expect(restoreAppBackup(result!.backup, ['connections', 'queries'])).toBe(0);
    expect(loadProfiles()).toEqual([existing, ...profiles.slice(1)]);
    expect(loadSaved('pg')).toEqual([existingQuery]);
    expect(loadHistory('pg')).toEqual([]);
    expect(restoreAppBackup(result!.backup, ['history'])).toBe(0);
    expect(loadHistory('pg')).toEqual([history]);
  });

  it('reports queries whose owner is missing, and restores them once the original connection is present', async () => {
    saveProfiles([profiles[0]]);
    writeSaved('pg', [query]);
    await saveAppBackup({ connections: {}, queries: {} });
    const result = (await openAppBackup())!;
    saveProfiles([]);
    writeSaved('pg', []);
    expect(restoreAppBackup(result.backup, ['queries'])).toBe(1);
    expect(loadSaved('pg')).toEqual([]);
    expect(restoreAppBackup(result.backup, ['connections', 'queries'])).toBe(0);
    expect(loadSaved('pg')).toEqual([query]);
  });

  it('rejects unsupported formats, invalid profile IDs and out-of-category settings', async () => {
    expect(() => parseAppBackup('{}')).toThrow('invalid');
    const make = (sections: unknown) => JSON.stringify({
      format: 'earthql-backup', version: 1, createdAt: new Date().toISOString(), sections,
    });
    expect(() => parseAppBackup(make({ connections: { storage: {}, profiles: [{ ...profiles[0], id: '../pg' }] } }))).toThrow('invalid');
    expect(() => parseAppBackup(make({ bookmarks: { storage: { 'earthql.keybindings': '{}' } } }))).toThrow('Invalid backup preferences');
    await fs.writeFile(file, make({ connections: { storage: {}, profiles: [profiles[0]] } }));
    const result = await openAppBackup();
    expect(() => restoreAppBackup(result!.backup, ['history'])).toThrow('invalid');
    expect(loadProfiles()).toEqual([]);
  });

  it('keeps credentials out of the backup and handles cancelled dialogs', async () => {
    const profile = { ...profiles[0], password: 'not-for-export' };
    saveProfiles([profile]);
    await saveAppBackup({ connections: {} });
    expect(await fs.readFile(file, 'utf8')).not.toContain('not-for-export');
    electron.save.mockResolvedValue({ canceled: true });
    electron.open.mockResolvedValue({ canceled: true, filePaths: [] });
    expect(await saveAppBackup({ connections: {} })).toBeNull();
    expect(await openAppBackup()).toBeNull();
  });
});
