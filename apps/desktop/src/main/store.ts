import { app } from 'electron';
import fs from 'node:fs';
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
