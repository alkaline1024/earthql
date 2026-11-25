import { BrowserWindow, dialog, ipcMain } from 'electron';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isEarthQLError, secretFieldsFor, type Cell, type ConnectionProfile, type ErrorInfo, type GridRowDelete, type GridRowUpdate, type ObjectPath, type ResultColumn, type SecretField, type Secrets } from '@earthql/core';
import type { IpcResult, ProfileSummary, SavedQuery } from '../shared/api';
import { deleteAllSecrets, deleteSecret, getSecrets, setSecret, storedFields } from './keychain';
import { SessionManager } from './sessions';
import { executeTableAction, saveStructure } from './table-actions';
import { exportTables, readTableImport, importTable, releaseTableImport, cancelTableFileJob } from './table-files';
import { exportConnections, importConnections } from './connection-transfer';
import { captureFeedbackScreenshot, feedbackSettings, saveFeedbackSettings, submitFeedback } from './feedback';
import { clearHistory, deleteProfileData, loadHistory, loadProfiles, loadSaved, saveProfiles, writeSaved } from './store';

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

  // --- profiles -------------------------------------------------------------
  const summary = (p: ConnectionProfile): ProfileSummary => ({ profile: p, storedSecrets: storedFields(p.id) });

  handle('profiles:list', null, () => loadProfiles().map(summary));
  handle('profiles:importTablePlus', null, importConnections);
  handle('profiles:exportTablePlus', null, exportConnections);

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
    const saved: ConnectionProfile = { ...profile, createdAt: idx >= 0 ? list[idx].createdAt : now, updatedAt: now };
    if (idx >= 0) list[idx] = saved;
    else list.push(saved);
    // Secrets go to the Keychain, never into profiles.json.
    const wanted = secretFieldsFor(saved as any);
    for (const [field, value] of Object.entries(secrets ?? {}) as [SecretField, string][]) {
      if (value !== undefined && wanted.includes(field)) setSecret(saved.id, field, value);
    }
    // Remove secrets that no longer apply (e.g. switching Databricks from token to M2M).
    for (const f of ['password', 'clientSecret', 'accessToken'] as SecretField[]) if (!wanted.includes(f)) deleteSecret(saved.id, f);
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
    const stored = getSecrets(profile.id);
    const merged: Secrets = { ...stored };
    for (const [k, v] of Object.entries(secrets ?? {}) as [SecretField, string][]) if (v) merged[k] = v;
    const conn = sessions.createConnection(profile, merged);
    try {
      return await conn.test();
    } catch (e) {
      return { ok: false, steps: [], error: conn.classifyError(e) };
    } finally {
      await conn.close().catch(() => undefined);
    }
  });

  // --- connections / metadata ----------------------------------------------
  handle('connection:open', 0, (profileId: string) => sessions.open(profileId));
  handle('connection:openSeparate', 0, (sessionId: string, name: string) => sessions.openSeparate(sessionId, name));
  handle('connection:reconnect', 0, (sessionId: string) => sessions.reconnect(sessionId));
  handle('connection:close', 0, (sessionId: string) => sessions.close(sessionId));
  handle('connection:closeProfile', 0, (profileId: string) => sessions.closeProfile(profileId));
  handle('meta:children', 0, (profileId: string, node) => sessions.get(profileId).conn.listChildren(node as any));
  handle('meta:structure', 0, (profileId: string, object, refresh?: boolean) => sessions.structure(profileId, object as any, !!refresh));
  handle('meta:privileges', 0, (profileId: string, object) => sessions.get(profileId).conn.getPrivileges(object as any));
  handle('meta:completion', 0, (profileId: string, ctx) => sessions.get(profileId).conn.completionSchema(ctx as any));
  handle('data:browse', 0, (profileId: string, req) => sessions.browse(profileId, req as any));

  // --- queries ----------------------------------------------------------------
  handle('query:run', 0, (profileId: string, runId: string, sql: string, ctx, limit: number) => sessions.run(profileId, runId, sql, ctx as any, limit));
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
  handle('write:insert', 0, (profileId: string, spec) => sessions.insert(profileId, spec as any));
  handle('write:updateCells', 0, (profileId: string, object: ObjectPath, rows: GridRowUpdate[]) => sessions.updateCells(profileId, object, rows));
  handle('write:deleteRows', 0, (profileId: string, object: ObjectPath, rows: GridRowDelete[]) => sessions.deleteRows(profileId, object, rows));
  handle('write:previewCreate', 0, (profileId: string, spec) => sessions.previewCreate(profileId, spec as any));
  handle('write:create', 0, (profileId: string, spec) => sessions.create(profileId, spec as any));

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

  handle('tableActions:saveStructure', 0, (profileId: string, object: ObjectPath, edits: import('../shared/table-actions').StructureEdit[]) => saveStructure(sessions, profileId, object, edits));
  handle('tableActions:run', 0, (profileId: string, request) => executeTableAction(sessions, profileId, request as any));
  handle('tableFiles:export', 1, (id: string, profileId: string, items, options) => exportTables(sessions, id, profileId, items as any, options as any));
  handle('tableFiles:read', 0, (profileId: string, object, format, options) => readTableImport(sessions, profileId, object as any, format as any, options as any));
  handle('tableFiles:import', null, (token: string, mapping, emptyAsNull: boolean) => importTable(sessions, token, mapping as any, emptyAsNull));
  handle('tableFiles:release', null, (token: string) => releaseTableImport(token));
  handle('tableFiles:cancel', null, (id: string) => cancelTableFileJob(id, sessions));

  // --- export -----------------------------------------------------------------
  handle('export:run', null, async (exportId: string, scope, opts) => {
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
