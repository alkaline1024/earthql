import { BrowserWindow, dialog } from 'electron';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { open, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { makeError } from '@earthql/core';
import type { ConnectionExportResult, ConnectionImportResult } from '../shared/api';
import { saveImportedPassword } from './keychain';
import { loadProfiles, saveProfiles } from './store';
import { exportTablePlusProfiles, importTablePlusProfiles } from './tableplus-connections';
import { decryptTablePlus, encryptTablePlus, isTablePlusEncrypted } from './tableplus-crypto';

const MAX_FILE_SIZE = 12 * 1024 * 1024;
const run = promisify(execFile);

function windowForDialog() {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
}

async function readConnections(filePath: string, password: string): Promise<{ data: unknown; encrypted: boolean }> {
  const file = await open(filePath, 'r');
  let data: Buffer;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_FILE_SIZE) {
      throw makeError('config', 'Choose a TablePlus connection file up to 12 MB.');
    }
    const { buffer, bytesRead } = await file.read(Buffer.alloc(stat.size));
    data = buffer.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
  const encrypted = isTablePlusEncrypted(data);
  if (encrypted) {
    if (!password) throw makeError('config', 'Enter the password used to export this TablePlus file.');
    data = await decryptTablePlus(data, password);
  }

  const contents = data.toString('utf8').replace(/^\uFEFF/, '').trimStart();
  try {
    if (contents.startsWith('[') || contents.startsWith('{')) return { data: JSON.parse(contents), encrypted };
    if (contents.startsWith('bplist00') || contents.startsWith('<?xml') || contents.startsWith('<plist')) {
      const conversion = run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', '-'], { maxBuffer: MAX_FILE_SIZE, timeout: 5_000 });
      conversion.child.stdin?.on('error', () => undefined);
      conversion.child.stdin?.end(data);
      const { stdout } = await conversion;
      return { data: JSON.parse(stdout), encrypted };
    }
  } catch {
    throw makeError('config', 'The file contains an invalid TablePlus connection list.');
  }
  throw makeError('unsupported', 'This TablePlus file format is unsupported. Choose an export from TablePlus for macOS or a Connections.plist file.');
}

export async function importConnections(password: string): Promise<ConnectionImportResult | null> {
  if (typeof password !== 'string') throw makeError('config', 'Enter a valid file password.');
  const chosen = await dialog.showOpenDialog(windowForDialog(), {
    title: 'Import TablePlus Connections',
    properties: ['openFile'],
    filters: [{ name: 'TablePlus Connections', extensions: ['tableplusconnection', 'plist'] }],
  });
  if (chosen.canceled || !chosen.filePaths[0]) return null;
  const { data, encrypted } = await readConnections(chosen.filePaths[0], password);
  // Reload after reading so concurrent changes to the profiles file are included.
  const existing = loadProfiles();
  const now = Date.now();
  const { profiles, environmentUpdates, passwords, duplicates, skipped } = importTablePlusProfiles(data, existing, { encrypted, now });
  if (profiles.length || environmentUpdates.size) {
    const updated = existing.map((profile) => {
      const env = environmentUpdates.get(profile.id);
      return env ? { ...profile, env, updatedAt: Math.max(now, profile.updatedAt + 1) } : profile;
    });
    saveProfiles([...updated, ...profiles]);
  }
  let passwordsSaved = 0;
  let passwordsFailed = 0;
  for (const [profileId, databasePassword] of passwords) {
    try {
      if (saveImportedPassword(profileId, databasePassword)) passwordsSaved++;
    } catch {
      // Keep imported profiles available so a retry can fill in credentials when Keychain is available.
      passwordsFailed++;
    }
  }
  return { imported: profiles.length, duplicates, skipped, environmentsUpdated: environmentUpdates.size, passwordsSaved, passwordsFailed };
}

export async function exportConnections(profileId: string | string[] | null, password: string): Promise<ConnectionExportResult | null> {
  if (typeof password !== 'string' || !password) throw makeError('config', 'Enter a password to protect the TablePlus export.');
  if (profileId !== null && typeof profileId !== 'string' && (!Array.isArray(profileId) || !profileId.every((id) => typeof id === 'string'))) {
    throw makeError('config', 'Invalid connection selection.');
  }
  const selectedIds = profileId === null ? null : new Set(Array.isArray(profileId) ? profileId : [profileId]);
  const profiles = loadProfiles().filter((profile) => selectedIds === null || selectedIds.has(profile.id));
  const { rows, skipped, reviewTls } = exportTablePlusProfiles(profiles);
  if (!rows.length) throw makeError('unsupported', 'Select a PostgreSQL, MySQL, or SQL Server connection to export to TablePlus.');
  const chosen = await dialog.showSaveDialog(windowForDialog(), {
    title: 'Export TablePlus Connections',
    defaultPath: 'EarthQL.tableplusconnection',
    filters: [{ name: 'TablePlus Connections', extensions: ['tableplusconnection'] }],
  });
  if (chosen.canceled || !chosen.filePath) return null;
  const destination = chosen.filePath;
  const temp = path.join(path.dirname(destination), `.earthql-${randomUUID()}.tmp`);
  const data = await encryptTablePlus(Buffer.from(JSON.stringify(rows)), password);
  try {
    await writeFile(temp, data, { mode: 0o600, flag: 'wx' });
    await rename(temp, destination);
  } finally {
    await rm(temp, { force: true }).catch(() => undefined);
  }
  return { exported: rows.length, skipped, reviewTls };
}
