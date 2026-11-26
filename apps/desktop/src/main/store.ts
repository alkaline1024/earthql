import { app } from 'electron';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { ConnectionProfile } from '@earthql/core';
import type { HistoryEntry, SavedQuery } from '../shared/api';

// Non-secret local data, stored as JSON under ~/Library/Application Support/EarthQL.

function dir(...parts: string[]): string {
  const d = path.join(app.getPath('userData'), ...parts);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function writeJson(file: string, data: unknown): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

const safeId = (id: string) => id.replace(/[^A-Za-z0-9_-]/g, '_');

const profilesFile = () => path.join(dir(), 'profiles.json');
const feedbackFile = () => path.join(dir(), 'feedback.json');

export function loadFeedbackEndpoint(): string {
  const config = readJson<{ endpoint?: string } | null>(feedbackFile(), null);
  return typeof config?.endpoint === 'string' ? config.endpoint : '';
}

export function writeFeedbackEndpoint(endpoint: string): void {
  writeJson(feedbackFile(), { endpoint });
}

export function readLaunchState(): { version: string; keychainPending: boolean } {
  const state = readJson<{ version?: string; keychainPending?: boolean } | null>(path.join(dir(), 'last-launch.json'), null);
  return { version: typeof state?.version === 'string' ? state.version : '', keychainPending: state?.keychainPending === true };
}

export function recordLaunchVersion(version: string, keychainPending: boolean): void {
  writeJson(path.join(dir(), 'last-launch.json'), { version, keychainPending });
}

export function loadProfiles(): ConnectionProfile[] {
  return readJson<{ profiles: ConnectionProfile[] }>(profilesFile(), { profiles: [] }).profiles;
}

export function saveProfiles(list: ConnectionProfile[]): void {
  writeJson(profilesFile(), { version: 1, profiles: list });
}

const MAX_HISTORY = 500;

const historyFile = (profileId: string) => path.join(dir('history'), `${safeId(profileId)}.json`);
const savedFile = (profileId: string) => path.join(dir('saved'), `${safeId(profileId)}.json`);

export function loadHistory(profileId: string): HistoryEntry[] {
  return readJson<HistoryEntry[]>(historyFile(profileId), []);
}

export function writeHistory(profileId: string, list: HistoryEntry[]): void {
  writeJson(historyFile(profileId), [...list].sort((a, b) => b.ranAt - a.ranAt).slice(0, MAX_HISTORY));
}

export function addHistory(profileId: string, e: HistoryEntry): void {
  const list = loadHistory(profileId);
  list.unshift(e);
  writeJson(historyFile(profileId), list.slice(0, MAX_HISTORY));
}

export function clearHistory(profileId: string): void {
  writeJson(historyFile(profileId), []);
}

export function loadSaved(profileId: string): SavedQuery[] {
  return readJson<SavedQuery[]>(savedFile(profileId), []);
}

export function writeSaved(profileId: string, list: SavedQuery[]): void {
  writeJson(savedFile(profileId), list);
}

export function deleteProfileData(profileId: string): void {
  for (const f of [historyFile(profileId), savedFile(profileId)]) fs.rmSync(f, { force: true });
}

export function loadActivitySharing(): boolean {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir(), 'activity-sharing.json'), 'utf8')) === true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

export function saveActivitySharing(enabled: boolean): void {
  writeJson(path.join(dir(), 'activity-sharing.json'), enabled);
}

export function loadOrCreateActivityInstallationId(): string {
  const file = path.join(dir(), 'activity-installation.json');
  const saved = readJson<unknown>(file, null);
  if (typeof saved === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(saved)) return saved;
  const id = randomUUID();
  writeJson(file, id);
  return id;
}

export function loadActivityRandomizeUsername(): boolean {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir(), 'activity-randomize-username.json'), 'utf8')) !== false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

export function saveActivityRandomizeUsername(enabled: boolean): void {
  writeJson(path.join(dir(), 'activity-randomize-username.json'), enabled);
}
