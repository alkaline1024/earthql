import type { ConnectionProfile } from '@earthql/core';
import type { HistoryEntry, SavedQuery } from './api';

export const BACKUP_CATEGORIES = {
  connections: { label: 'Connections', detail: 'Connection profiles and list order', keys: ['connectionOrder', 'sidebarConnectionOrder'] },
  bookmarks: { label: 'Bookmarks', detail: 'Saved table and view bookmarks and pinned items', keys: ['tableFavorites', 'pinnedTables', 'bookmarksExpanded'] },
  groups: { label: 'Groups', detail: 'Connection groups and table groups', keys: ['connectionGroups', 'tableGroups'] },
  queries: { label: 'Saved SQL queries', detail: 'Saved queries and snippets', keys: [] },
  history: { label: 'Query history', detail: 'SQL statements and their execution history', keys: [] },
  filters: { label: 'Saved filters', detail: 'Named filters for tables and views', keys: [] },
  settings: { label: 'Settings', detail: 'Appearance, shortcuts, SQL preferences and sidebar sizes', keys: [
    'theme', 'autoThemes', 'uiStyle', 'keybindings', 'defaultRowLimit', 'beautifyUppercase', 'sqlRunDefault', 'sidebarWidth', 'favoritesHeight', 'quickStartSeen',
  ] },
} as const;

export type BackupCategory = keyof typeof BACKUP_CATEGORIES;
export const BACKUP_IDS = Object.keys(BACKUP_CATEGORIES) as BackupCategory[];
export const FILTER_PREFIX = 'earthql.savedFilters.';
export const MAX_BACKUP_BYTES = 64 * 1024 * 1024;
export type BackupStorage = Record<string, string | null>;
export type BackupSettings = Partial<Record<BackupCategory, BackupStorage>>;
export interface ProfileRecords<T> { profileId: string; entries: T[] }

export interface BackupSection {
  storage: BackupStorage;
  profiles?: ConnectionProfile[];
  queries?: ProfileRecords<SavedQuery>[];
  history?: ProfileRecords<HistoryEntry>[];
  feedbackEndpoint?: string;
}

export interface AppBackup {
  format: 'earthql-backup';
  version: 1;
  createdAt: string;
  sections: Partial<Record<BackupCategory, BackupSection>>;
}

export interface BackupPreview {
  token: string;
  fileName: string;
  createdAt: string;
  settings: BackupSettings;
}

export function backupObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function cleanBackupStorage(category: BackupCategory, value: unknown): BackupStorage {
  if (!backupObject(value)) throw new Error('Invalid backup preferences.');
  const keys = BACKUP_CATEGORIES[category].keys as readonly string[];
  const result: BackupStorage = {};
  for (const [key, stored] of Object.entries(value)) {
    const allowed = keys.some((name) => key === 'earthql.' + name) ||
      (category === 'filters' && key.startsWith(FILTER_PREFIX));
    if (!allowed || (stored !== null && typeof stored !== 'string')) throw new Error('Invalid backup preferences.');
    result[key] = stored;
  }
  return result;
}
