import { BrowserWindow, dialog } from 'electron';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ConnectionProfile } from '@earthql/core';
import type { HistoryEntry, SavedQuery } from '../shared/api';
import {
  BACKUP_IDS, MAX_BACKUP_BYTES, backupObject, cleanBackupStorage,
  type AppBackup, type BackupCategory, type BackupPreview, type BackupSection, type BackupSettings, type ProfileRecords,
} from '../shared/app-backup';
import { feedbackEndpointUrl } from '../shared/feedback';
import { loadFeedbackEndpoint, loadHistory, loadProfiles, loadSaved, saveProfiles, writeFeedbackEndpoint, writeHistory, writeSaved } from './store';

const invalid = () => new Error('This EarthQL backup file is invalid.');
const validId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value);
const string = (value: unknown): value is string => typeof value === 'string';
const number = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const port = (value: unknown) => number(value) && Number.isInteger(value) && value > 0 && value <= 65535;
const optional = (value: unknown) => value === undefined || string(value);
const context = (value: unknown) => backupObject(value) && [value.catalog, value.database, value.schema].every(optional);

function cleanProfile(value: unknown): ConnectionProfile {
  if (!backupObject(value)) throw invalid();
  const { id, name, env, createdAt, updatedAt, driver, host, ssh } = value;
  if (!validId(id) || !string(name) || !backupObject(env) || !string(env.name) || !string(env.color) ||
      !number(createdAt) || !number(updatedAt) || !string(host)) throw invalid();
  const base = { id, name, env: { name: env.name, color: env.color }, createdAt, updatedAt, host };
  if (driver === 'databricks') {
    const { httpPath, authMode, clientId, catalog, schema, azureTenantId } = value;
    if (!string(httpPath) || (authMode !== 'oauth-m2m' && authMode !== 'access-token') ||
        !optional(clientId) || !optional(catalog) || !optional(schema) || !optional(azureTenantId)) throw invalid();
    return { ...base, driver, httpPath, authMode, clientId, catalog, schema, azureTenantId } as ConnectionProfile;
  }
  if (driver !== 'postgres' && driver !== 'mysql' && driver !== 'mssql') throw invalid();
  const { port: dbPort, user, database, tls } = value;
  if (!number(dbPort) || !port(dbPort) || !string(user) || !(string(database) || (driver === 'mysql' && database === undefined)) ||
      !backupObject(tls) || (tls.mode !== 'disable' && tls.mode !== 'require' && tls.mode !== 'verify') ||
      !optional(tls.caCert) || !optional(tls.serverName)) throw invalid();
  const profile: ConnectionProfile = {
    ...base, driver, port: dbPort, user, database,
    tls: { mode: tls.mode, caCert: tls.caCert, serverName: tls.serverName },
  } as ConnectionProfile;
  if (ssh !== undefined) {
    if (!backupObject(ssh) || !string(ssh.host) || !number(ssh.port) || !port(ssh.port) || !string(ssh.user) || !string(ssh.hostKeyFingerprint)) throw invalid();
    profile.ssh = { host: ssh.host, port: ssh.port, user: ssh.user, hostKeyFingerprint: ssh.hostKeyFingerprint };
  }
  return profile;
}

function isQuery(value: unknown): value is SavedQuery {
  return backupObject(value) && validId(value.id) && string(value.name) && string(value.sql) &&
    number(value.createdAt) && number(value.updatedAt) && (value.context === undefined || context(value.context));
}

function isHistory(value: unknown): value is HistoryEntry {
  return backupObject(value) && validId(value.id) && string(value.sql) && number(value.ranAt) &&
    number(value.durationMs) && number(value.statements) && context(value.context) &&
    ['ok', 'error', 'cancelled', 'outcome_unknown'].some((status) => status === value.status);
}

function records<T>(value: unknown, valid: (item: unknown) => item is T): ProfileRecords<T>[] {
  if (!Array.isArray(value)) throw invalid();
  return value.map((item) => {
    if (!backupObject(item) || !validId(item.profileId) || !Array.isArray(item.entries) || !item.entries.every(valid)) throw invalid();
    return { profileId: item.profileId, entries: item.entries };
  });
}

export function parseAppBackup(text: string): AppBackup {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw invalid(); }
  if (!backupObject(value) || value.format !== 'earthql-backup' || value.version !== 1 ||
      !string(value.createdAt) || !Number.isFinite(Date.parse(value.createdAt)) || !backupObject(value.sections)) throw invalid();
  const sections: AppBackup['sections'] = {};
  for (const id of BACKUP_IDS) {
    const raw = value.sections[id];
    if (raw === undefined) continue;
    if (!backupObject(raw)) throw invalid();
    const section: BackupSection = { storage: cleanBackupStorage(id, raw.storage) };
    if (id === 'connections') {
      if (!Array.isArray(raw.profiles)) throw invalid();
      section.profiles = raw.profiles.map(cleanProfile);
    }
    if (id === 'queries') section.queries = records(raw.queries, isQuery);
    if (id === 'history') section.history = records(raw.history, isHistory);
    if (id === 'settings') {
      if (!string(raw.feedbackEndpoint) || (raw.feedbackEndpoint && !feedbackEndpointUrl(raw.feedbackEndpoint))) throw invalid();
      section.feedbackEndpoint = raw.feedbackEndpoint;
    }
    sections[id] = section;
  }
  if (!Object.keys(sections).length) throw invalid();
  return { format: 'earthql-backup', version: 1, createdAt: value.createdAt, sections };
}

function owner() {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
}

export async function saveAppBackup(selected: BackupSettings): Promise<string | null> {
  if (!backupObject(selected)) throw invalid();
  const chooser = await dialog.showSaveDialog(owner(), {
    title: 'Save EarthQL Backup',
    defaultPath: `earthql-backup-${new Date().toISOString().slice(0, 10)}.json`,
    filters: [{ name: 'EarthQL Backup', extensions: ['json'] }],
  });
  if (chooser.canceled || !chooser.filePath) return null;
  const profiles = loadProfiles();
  const sections: AppBackup['sections'] = {};
  for (const id of BACKUP_IDS) {
    if (!Object.hasOwn(selected, id)) continue;
    const section: BackupSection = { storage: cleanBackupStorage(id, selected[id]) };
    if (id === 'connections') section.profiles = profiles.map(cleanProfile);
    if (id === 'queries') section.queries = profiles.map(({ id }) => ({ profileId: id, entries: loadSaved(id) }));
    if (id === 'history') section.history = profiles.map(({ id }) => ({ profileId: id, entries: loadHistory(id) }));
    if (id === 'settings') section.feedbackEndpoint = loadFeedbackEndpoint();
    sections[id] = section;
  }
  if (!Object.keys(sections).length) throw new Error('Select at least one category to back up.');
  const payload: AppBackup = { format: 'earthql-backup', version: 1, createdAt: new Date().toISOString(), sections };
  const data = JSON.stringify(payload);
  if (Buffer.byteLength(data) > MAX_BACKUP_BYTES) throw new Error('This backup exceeds 64 MiB. Select fewer categories.');
  const temp = path.join(path.dirname(chooser.filePath), `.earthql-${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temp, data, { mode: 0o600, flag: 'wx' });
    await fs.rename(temp, chooser.filePath);
  } finally {
    await fs.rm(temp, { force: true }).catch(() => undefined);
  }
  return path.basename(chooser.filePath);
}

export async function openAppBackup(): Promise<{ backup: AppBackup; preview: BackupPreview } | null> {
  const chooser = await dialog.showOpenDialog(owner(), {
    title: 'Open EarthQL Backup', properties: ['openFile'], filters: [{ name: 'EarthQL Backup', extensions: ['json'] }],
  });
  if (chooser.canceled || !chooser.filePaths.length) return null;
  const filePath = chooser.filePaths[0];
  const file = await fs.open(filePath, 'r');
  let backup: AppBackup;
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw invalid();
    const { size } = stat;
    if (size > MAX_BACKUP_BYTES) throw new Error('Backup files must not exceed 64 MiB.');
    const buffer = Buffer.alloc(size);
    const { bytesRead } = await file.read({ buffer });
    if (bytesRead !== size || (await file.stat()).size !== size) throw new Error('The backup file changed while it was being read.');
    backup = parseAppBackup(new TextDecoder('utf-8', { fatal: true }).decode(buffer));
  } finally {
    await file.close();
  }
  const settings: BackupSettings = {};
  for (const id of BACKUP_IDS) {
    const section = backup.sections[id];
    if (section) settings[id] = section.storage;
  }
  return { backup, preview: { token: randomUUID(), fileName: path.basename(filePath), createdAt: backup.createdAt, settings } };
}

function merge<T extends { id: string }>(existing: T[], incoming: T[]): T[] {
  const entries = new Map(incoming.map((item) => [item.id, item]));
  for (const item of existing) entries.set(item.id, item);
  return [...entries.values()];
}

export function restoreAppBackup(backup: AppBackup, ids: BackupCategory[]): number {
  if (!Array.isArray(ids) || !ids.length || ids.some((id) => !BACKUP_IDS.includes(id) || !backup.sections[id])) throw invalid();
  const selected = new Set(ids);
  const profiles = loadProfiles();
  const incomingProfiles = selected.has('connections') ? backup.sections.connections?.profiles : undefined;
  const knownProfiles = new Set(merge(profiles, incomingProfiles ?? []).map(({ id }) => id));
  const missing = new Set<string>();
  const steps: { apply: () => void; undo: () => void }[] = [];
  if (incomingProfiles?.length) {
    steps.push({ apply: () => saveProfiles(merge(profiles, incomingProfiles)), undo: () => saveProfiles(profiles) });
  }
  function prepare<T extends { id: string }>(
    rows: ProfileRecords<T>[], read: (id: string) => T[], write: (id: string, list: T[]) => void,
  ) {
    const grouped = new Map<string, T[]>();
    for (const { profileId, entries } of rows) {
      if (!entries.length) continue;
      if (!knownProfiles.has(profileId)) {
        missing.add(profileId);
        continue;
      }
      grouped.set(profileId, merge(grouped.get(profileId) ?? [], entries));
    }
    for (const [profileId, entries] of grouped) {
      const previous = read(profileId);
      const next = merge(previous, entries);
      steps.push({ apply: () => write(profileId, next), undo: () => write(profileId, previous) });
    }
  }
  if (selected.has('queries')) prepare(backup.sections.queries?.queries ?? [], loadSaved, writeSaved);
  if (selected.has('history')) prepare(backup.sections.history?.history ?? [], loadHistory, writeHistory);
  const endpoint = selected.has('settings') ? backup.sections.settings?.feedbackEndpoint : undefined;
  if (endpoint !== undefined) {
    const previous = loadFeedbackEndpoint();
    steps.push({ apply: () => writeFeedbackEndpoint(endpoint), undo: () => writeFeedbackEndpoint(previous) });
  }
  const completed: typeof steps = [];
  try {
    for (const step of steps) {
      step.apply();
      completed.push(step);
    }
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    for (const step of completed.reverse()) {
      try { step.undo(); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
    }
    if (rollbackErrors.length) throw new Error('Restore failed and some changes could not be rolled back.', { cause: error });
    throw error;
  }
  return missing.size;
}
