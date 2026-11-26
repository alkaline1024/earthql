import type { BackupCategory } from '../shared/app-backup';
import { openAppBackup, restoreAppBackup, saveAppBackup } from './app-backup';
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isEarthQLError, secretFieldsFor, type BrowseRequest, type Cell, type ConnectionProfile, type ErrorInfo, type GridChanges, type GridRowDelete, type GridRowUpdate, type ObjectPath, type ResultColumn, type SecretField, type Secrets } from '@earthql/core';
import type { ExportScope, IpcResult, ProfileSummary, SavedQuery } from '../shared/api';
import { deleteAllSecrets, deleteSecret, getSecrets, setSecret } from './keychain';
import { SessionManager } from './sessions';
import { executeTableAction, saveStructure } from './table-actions';
import { exportTables, readTableImport, importTable, releaseTableImport, cancelTableFileJob, tableImportTarget } from './table-files';
import { confirmProductionOperation } from './production-guard';
import { exportConnections, importConnections } from './connection-transfer';
import { readTableGroupFile, saveTableGroupFile } from './table-group-files';
import { captureFeedbackScreenshot, feedbackSettings, saveFeedbackSettings, submitFeedback } from './feedback';
import { isNewerVersion } from './update-release';
import { readLastLaunchVersion, recordLaunchVersion, clearHistory, deleteProfileData, loadHistory, loadProfiles, loadSaved, saveProfiles, writeSaved } from './store';

function isErrorInfo(e: any): e is ErrorInfo {
  return e && typeof e === 'object' && typeof e.category === 'string' && typeof e.message === 'string' && !(e instanceof Error);
}

export function registerIpc(sessions: SessionManager): void {
  const handle = <A extends unknown[], T>(channel: string, profileArg: number | null, fn: (...args: A) => Promise<T> | T) => {
    ipcMain.handle(channel, async (_ev, ...args: unknown[]): Promise<IpcResult<T>> => {
      try {
        return { ok: true, value: await fn(...(args as A)) };
      } catch (e) {
        const profileId = profileArg !== null ? (args[profileArg] as string | undefined) : undefined;
        const error = isErrorInfo(e) ? e : isEarthQLError(e) ? e.toInfo() : sessions.errorFor(profileId, e);
        return { ok: false, error };
      }
    });
  };

  let pendingBackup: Awaited<ReturnType<typeof openAppBackup>> = null;
  handle('backup:save', null, saveAppBackup);
  handle('backup:open', null, async () => {
    const opened = await openAppBackup();
    if (opened) pendingBackup = opened;
    return opened?.preview ?? null;
  });
  handle('backup:restore', null, (token: string, categories: BackupCategory[]) => {
    if (!pendingBackup || token !== pendingBackup.preview.token) throw new Error('Open the backup file again.');
    const missingProfiles = restoreAppBackup(pendingBackup.backup, categories);
    pendingBackup = null;
    return missingProfiles;
  });

  handle('files:reveal', null, async (file: string) => {
    if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('Invalid file path.');
    await fs.access(file);
    shell.showItemInFolder(file);
  });

  // --- profiles -------------------------------------------------------------
  const summary = (p: ConnectionProfile): ProfileSummary => ({ profile: p, storedSecrets: null });
  const draftSecrets = (profile: ConnectionProfile, secrets: Secrets): Secrets => {
    const fields = secretFieldsFor(profile);
    const missing = fields.filter((field) => secrets[field] === undefined);
    return { ...(missing.length ? getSecrets(profile.id, missing) : {}), ...secrets };
  };

  handle('profiles:postUpdateKeychain', null, () => {
    if (!app.isPackaged || process.platform !== 'darwin') return [];
    const current = app.getVersion();
    const previous = readLastLaunchVersion();
    if (previous === current) return [];
    recordLaunchVersion(current);
    if (!previous || !isNewerVersion(current, previous)) return [];
    const profiles = loadProfiles();
    return profiles.length > 3 ? profiles.map(({ id }) => id) : [];
  });
  handle('profiles:authorizeKeychain', null, (id: string) => {
    if (!app.isPackaged || process.platform !== 'darwin') return;
    const profile = loadProfiles().find((candidate) => candidate.id === id);
    if (!profile) return;
    // Reading triggers macOS authorization when required. No credentials cross IPC.
    getSecrets(profile.id, secretFieldsFor(profile));
  });

  handle('profiles:list', null, () => loadProfiles().map(summary));
  handle('profiles:importTablePlus', null, importConnections);
  handle('profiles:exportTablePlus', null, exportConnections);
  handle('groupFiles:read', null, readTableGroupFile);
  handle('groupFiles:save', null, saveTableGroupFile);

  handle('profiles:setDefaultDatabase', null, (id: string, database: string) => {
    const profiles = loadProfiles();
    const index = profiles.findIndex((profile) => profile.id === id);
    const profile = profiles[index];
    if (!profile || profile.driver === 'databricks' || typeof database !== 'string' || !database.trim() || database.includes(String.fromCharCode(0))) {
      throw new Error('Choose a valid default database for this connection.');
    }
    const saved = { ...profile, database, updatedAt: Date.now() };
    profiles[index] = saved;
    saveProfiles(profiles);
    return summary(saved);
  });

  handle('profiles:save', null, (profile: ConnectionProfile, secrets: Secrets) => {
    const list = loadProfiles();
    const now = Date.now();
    const idx = list.findIndex((p) => p.id === profile.id);
    const previous = idx >= 0 ? secretFieldsFor(list[idx]) : [];
    const saved: ConnectionProfile = { ...profile, createdAt: idx >= 0 ? list[idx].createdAt : now, updatedAt: now };
    if (idx >= 0) list[idx] = saved;
    else list.push(saved);
    // Secrets go to the Keychain, never into profiles.json.
    const wanted = secretFieldsFor(saved);
    for (const [field, value] of Object.entries(secrets ?? {}) as [SecretField, string][]) {
      if (value !== undefined && wanted.includes(field)) setSecret(saved.id, field, value);
    }
    // Remove secrets that no longer apply (e.g. switching Databricks from token to M2M).
    for (const f of previous) if (!wanted.includes(f)) deleteSecret(saved.id, f);
    saveProfiles(list);
    return summary(saved);
  });

  handle('profiles:remove', null, async (id: string) => {
    await sessions.closeProfile(id);
    saveProfiles(loadProfiles().filter((p) => p.id !== id));
    deleteAllSecrets(id);
    deleteProfileData(id);
  });

  handle('profiles:test', null, async (profile: ConnectionProfile, secrets: Secrets) => {
    const merged = draftSecrets(profile, secrets ?? {});
    const managed = await sessions.createManagedConnection(profile, merged);
    const { conn } = managed;
    try {
      return await conn.test();
    } catch (e) {
      return { ok: false, steps: [], error: conn.classifyError(e) };
    } finally {
      await managed.close().catch((error) => console.error('Connection cleanup failed.', error));
    }
  });

  handle('profiles:databases', null, async (profile: ConnectionProfile, secrets: Secrets) => {
    if (profile.driver !== 'mssql') throw new Error('Database selection is only available for SQL Server.');
    const merged = draftSecrets(profile, secrets ?? {});
    const managed = await sessions.createManagedConnection(profile, merged);
    const { conn } = managed;
    try {
      return await conn.listChildren(null);
    } catch (e) {
      throw conn.classifyError(e);
    } finally {
      await managed.close();
    }
  });

  // --- connections / metadata ----------------------------------------------
  handle('connection:open', 0, (profileId: string) => sessions.open(profileId));
  handle('connection:openSeparate', 0, (sessionId: string, name: string) => sessions.openSeparate(sessionId, name));
  handle('connection:reconnect', 0, (sessionId: string) => sessions.reconnect(sessionId));
  handle('connection:test', 0, (sessionId: string) => sessions.get(sessionId).conn.test());
  handle('connection:close', 0, (sessionId: string) => sessions.close(sessionId));
  handle('connection:closeProfile', 0, (profileId: string) => sessions.closeProfile(profileId));
  handle('meta:children', 0, (profileId: string, node) => sessions.get(profileId).conn.listChildren(node as any));
  handle('meta:structure', 0, (profileId: string, object, refresh?: boolean) => sessions.structure(profileId, object as any, !!refresh));
  handle('meta:privileges', 0, (profileId: string, object) => sessions.get(profileId).conn.getPrivileges(object as any));
  handle('meta:completion', 0, (profileId: string, ctx) => sessions.get(profileId).conn.completionSchema(ctx as any));
  handle('data:browse', 0, (profileId: string, req) => sessions.browse(profileId, req as any));
  handle('data:previewBrowse', 0, (profileId: string, req: BrowseRequest) => sessions.previewBrowse(profileId, req));
  handle('write:saveGrid', 0, async (profileId: string, object: ObjectPath, changes: GridChanges) => {
    await confirmProductionOperation(sessions, profileId, 'Save table changes');
    return sessions.saveGrid(profileId, object, changes);
  });

  // --- queries ----------------------------------------------------------------
  handle('query:run', 0, async (profileId: string, runId: string, sql: string, ctx, limit: number) => {
    await confirmProductionOperation(sessions, profileId, 'Run SQL');
    return sessions.run(profileId, runId, sql, ctx as any, limit);
  });
  handle('query:explain', 0, async (profileId: string, runId: string, sql: string, ctx, limit: number) => {
    await confirmProductionOperation(sessions, profileId, 'Explain SQL');
    return sessions.run(profileId, runId, sql, ctx as any, limit, true);
  });
  handle('query:cancel', null, (runId: string) => sessions.cancel(runId));
  handle('query:more', null, (cursorId: string, maxRows: number) => sessions.more(cursorId, maxRows));
  handle('query:closeCursor', null, (cursorId: string) => sessions.closeCursor(cursorId));
  handle('query:saveFile', null, async (sql: string, suggestedName: string) => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const res = await dialog.showSaveDialog(win, {
      title: 'Save SQL',
      defaultPath: path.join(os.homedir(), 'Downloads', suggestedName.replace(/[/\\:]/g, '_')),
      filters: [{ name: 'SQL', extensions: ['sql'] }],
    });
    if (res.canceled || !res.filePath) return { status: 'dialog-cancelled' as const };
    await fs.writeFile(res.filePath, sql, 'utf8');
    return { status: 'ok' as const, path: res.filePath };
  });
  handle('query:rowsAsInsert', 0, (profileId: string, object: ObjectPath, columns: ResultColumn[], rows: Cell[][]) => sessions.rowsAsInsert(profileId, object, columns, rows));

  // --- writes -----------------------------------------------------------------
  handle('write:previewInsert', 0, (profileId: string, spec) => sessions.previewInsert(profileId, spec as any));
  handle('write:insert', 0, async (profileId: string, spec) => {
    await confirmProductionOperation(sessions, profileId, 'Insert rows');
    return sessions.insert(profileId, spec as any);
  });
  handle('write:updateCells', 0, async (profileId: string, object: ObjectPath, rows: GridRowUpdate[]) => {
    await confirmProductionOperation(sessions, profileId, 'Update rows');
    return sessions.updateCells(profileId, object, rows);
  });
  handle('write:deleteRows', 0, async (profileId: string, object: ObjectPath, rows: GridRowDelete[]) => {
    await confirmProductionOperation(sessions, profileId, 'Delete rows');
    return sessions.deleteRows(profileId, object, rows);
  });
  handle('write:previewCreate', 0, (profileId: string, spec) => sessions.previewCreate(profileId, spec as any));
  handle('write:create', 0, async (profileId: string, spec) => {
    await confirmProductionOperation(sessions, profileId, 'Create a table');
    return sessions.create(profileId, spec as any);
  });

  // --- history / saved --------------------------------------------------------
  handle('history:list', 0, (sessionId: string) => loadHistory(sessions.savedProfileId(sessionId)));
  handle('history:clear', 0, (sessionId: string) => clearHistory(sessions.savedProfileId(sessionId)));
  handle('saved:list', 0, (sessionId: string) => loadSaved(sessions.savedProfileId(sessionId)));
  handle('saved:save', 0, (sessionId: string, q: SavedQuery) => {
    const profileId = sessions.savedProfileId(sessionId);
    const list = loadSaved(profileId);
    const now = Date.now();
    const id = q.id || randomUUID();
    const idx = list.findIndex((x) => x.id === id);
    const item: SavedQuery = { ...q, id, createdAt: idx >= 0 ? list[idx].createdAt : now, updatedAt: now };
    if (idx >= 0) list[idx] = item;
    else list.unshift(item);
    writeSaved(profileId, list);
    return item;
  });
  handle('saved:remove', 0, (sessionId: string, id: string) => {
    const profileId = sessions.savedProfileId(sessionId);
    writeSaved(profileId, loadSaved(profileId).filter((x) => x.id !== id));
  });

  handle('tableActions:saveStructure', 0, async (profileId: string, object: ObjectPath, edits: import('../shared/table-actions').StructureEdit[]) => {
    await confirmProductionOperation(sessions, profileId, 'Change table structure');
    return saveStructure(sessions, profileId, object, edits);
  });
  handle('tableActions:run', 0, async (profileId: string, request) => {
    await confirmProductionOperation(sessions, profileId, 'Run a table action');
    return executeTableAction(sessions, profileId, request as any);
  });
  handle('tableFiles:export', 1, (id: string, profileId: string, items, options) => exportTables(sessions, id, profileId, items as any, options as any));
  handle('tableFiles:read', 0, (profileId: string, object, format, options) => readTableImport(sessions, profileId, object as any, format as any, options as any));
  handle('tableFiles:import', null, async (token: string, mapping, emptyAsNull: boolean) => {
    const target = tableImportTarget(token);
    await confirmProductionOperation(sessions, target.profileId, 'Import data or SQL');
    return importTable(sessions, token, mapping as any, emptyAsNull);
  });
  handle('tableFiles:release', null, (token: string) => releaseTableImport(token));
  handle('tableFiles:cancel', null, (id: string) => cancelTableFileJob(id, sessions));

  // --- export -----------------------------------------------------------------
  handle('export:run', null, async (exportId: string, scope, opts) => {
    const exportScope = scope as ExportScope;
    if (exportScope.kind === 'rerun') await confirmProductionOperation(sessions, exportScope.profileId, 'Re-run SQL for export');
    const o = opts as { suggestedName: string; nullText: string; bom: boolean };
    // Automated end-to-end tests only: write to a fixed directory instead of showing the save panel.
    const testDir = process.env.EARTHQL_E2E_EXPORT_DIR;
    if (testDir) return sessions.exportCsv(exportId, scope as any, o, path.join(testDir, o.suggestedName));
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const res = await dialog.showSaveDialog(win, {
      title: 'Export CSV',
      defaultPath: path.join(os.homedir(), 'Downloads', o.suggestedName.replace(/[/\\:]/g, '_')),
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    });
    if (res.canceled || !res.filePath) return { status: 'dialog-cancelled' as const };
    return sessions.exportCsv(exportId, scope as any, o, res.filePath);
  });
  handle('export:cancel', null, (exportId: string) => sessions.cancelExport(exportId));

  handle('feedback:settings', null, feedbackSettings);
  handle('feedback:saveSettings', null, saveFeedbackSettings);
  handle('feedback:submit', null, submitFeedback);
  handle('feedback:capture', null, () => {
    const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    if (!window) throw new Error('Open an EarthQL window before capturing a screenshot.');
    return captureFeedbackScreenshot(window.webContents);
  });
}
