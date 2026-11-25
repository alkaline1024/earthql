import type { ObjectKind, ObjectPath, TreeNode } from '@earthql/core';
import { treeNodeKey } from './tree-selection';

export interface TableFavorite {
  profileId: string;
  kind: ObjectKind;
  path: ObjectPath;
  folderId?: string;
}

export interface FavoriteFolder {
  profileId: string;
  kind: 'folder';
  id: string;
  name: string;
  collapsed: boolean;
}

export type FavoriteEntry = TableFavorite | FavoriteFolder;

export function favoriteKey(favorite: TableFavorite): string {
  return JSON.stringify([favorite.profileId, treeNodeKey(favorite)]);
}

export function favoriteEntryKey(entry: FavoriteEntry): string {
  return entry.kind === 'folder' ? JSON.stringify(['folder', entry.profileId, entry.id]) : favoriteKey(entry);
}

export function selectFavoriteKeys(selected: string[], displayed: TableFavorite[], anchor: string | null, favorite: TableFavorite, toggle: boolean, range: boolean): { selected: string[]; anchor: string } {
  const key = favoriteKey(favorite);
  const visible = displayed.map(favoriteKey);
  const current = visible.filter((item) => selected.includes(item));
  if (range) {
    const start = visible.indexOf(anchor ?? '');
    const end = visible.indexOf(key);
    const span = start < 0 || end < 0 ? [key] : visible.slice(Math.min(start, end), Math.max(start, end) + 1);
    return { selected: toggle ? [...new Set([...current, ...span])] : span, anchor: start < 0 ? key : visible[start] };
  }
  return { selected: toggle ? current.includes(key) ? current.filter((item) => item !== key) : [...current, key] : [key], anchor: key };
}

export function parseTableFavorites(raw: string | null): FavoriteEntry[] {
  if (raw === null) return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('Invalid bookmarks');
  const favorites = new Map<string, FavoriteEntry>();
  for (const item of parsed) {
    if (!item || typeof item !== 'object' || typeof item.profileId !== 'string' || !item.profileId) throw new Error('Invalid bookmark');
    if (item.kind === 'folder') {
      if (typeof item.id !== 'string' || !item.id || typeof item.name !== 'string' || !item.name.trim() || typeof item.collapsed !== 'boolean') {
        throw new Error('Invalid bookmark folder');
      }
      const folder: FavoriteFolder = { profileId: item.profileId, kind: 'folder', id: item.id, name: item.name, collapsed: item.collapsed };
      if (favorites.has(favoriteEntryKey(folder))) throw new Error('Duplicate bookmark folder');
      favorites.set(favoriteEntryKey(folder), folder);
      continue;
    }
    if ((item.kind !== 'table' && item.kind !== 'view') || !item.path || typeof item.path !== 'object'
      || typeof item.path.name !== 'string' || !item.path.name
      || (item.folderId !== undefined && (typeof item.folderId !== 'string' || !item.folderId))
      || ['catalog', 'database', 'schema'].some((key) => item.path[key] !== undefined && typeof item.path[key] !== 'string')) {
      throw new Error('Invalid bookmark');
    }
    const favorite: TableFavorite = {
      profileId: item.profileId, kind: item.kind,
      path: { catalog: item.path.catalog, database: item.path.database, schema: item.path.schema, name: item.path.name },
      ...(item.folderId ? { folderId: item.folderId } : {}),
    };
    favorites.set(favoriteKey(favorite), favorite);
  }
  const entries = [...favorites.values()];
  if (entries.some((entry) => entry.kind !== 'folder' && entry.folderId
    && !entries.some((folder) => folder.kind === 'folder' && folder.profileId === entry.profileId && folder.id === entry.folderId))) {
    throw new Error('Bookmark folder not found');
  }
  return entries;
}

export function updateTableFavorites(current: FavoriteEntry[], profileId: string, nodes: TreeNode[], add: boolean): FavoriteEntry[] {
  const favorites = new Map(current.map((entry) => [favoriteEntryKey(entry), entry]));
  for (const node of nodes) {
    if ((node.kind !== 'table' && node.kind !== 'view') || !node.path.name) continue;
    const favorite: TableFavorite = { profileId, kind: node.kind, path: { ...node.path, name: node.path.name } };
    if (add) {
      if (!favorites.has(favoriteKey(favorite))) favorites.set(favoriteKey(favorite), favorite);
    } else favorites.delete(favoriteKey(favorite));
  }
  return [...favorites.values()];
}

export function addTreeNodesToBookmarks(entries: FavoriteEntry[], profileId: string, nodes: TreeNode[], targetKey: string | null, position: 'before' | 'after' | 'inside' | 'root'): FavoriteEntry[] {
  if (!nodes.length || nodes.some((node) => (node.kind !== 'table' && node.kind !== 'view') || !node.path.name)) {
    throw new Error('Select tables or views to bookmark.');
  }
  const target = targetKey ? entries.find((entry) => favoriteEntryKey(entry) === targetKey) : undefined;
  if ((position !== 'root' && !target) || (target && target.profileId !== profileId)) throw new Error('Bookmark destination is no longer available.');
  const next = updateTableFavorites(entries, profileId, nodes, true);
  const keys = [...new Set(nodes.map((node) => {
    if ((node.kind !== 'table' && node.kind !== 'view') || !node.path.name) throw new Error('Select tables or views to bookmark.');
    return favoriteKey({ profileId, kind: node.kind, path: { ...node.path, name: node.path.name } });
  }))].filter((key) => key !== targetKey);
  return keys.length ? moveFavoriteEntries(next, keys, targetKey, position) : next;
}

export function removeFavoriteFolder(entries: FavoriteEntry[], profileId: string, id: string): FavoriteEntry[] {
  if (!entries.some((entry) => entry.kind === 'folder' && entry.profileId === profileId && entry.id === id)) throw new Error('Bookmark folder no longer exists.');
  return entries.flatMap((entry) => {
    if (entry.profileId !== profileId) return [entry];
    if (entry.kind === 'folder') return entry.id === id ? [] : [entry];
    if (entry.folderId !== id) return [entry];
    const { folderId: _folderId, ...favorite } = entry;
    return [favorite];
  });
}

export function createFavoriteFolder(entries: FavoriteEntry[], folder: FavoriteFolder, sourceKeys: string[] = []): FavoriteEntry[] {
  if (!folder.name.trim()) throw new Error('Enter a folder name.');
  if (entries.some((entry) => entry.kind === 'folder' && entry.profileId === folder.profileId && entry.id === folder.id)) {
    throw new Error('Bookmark folder already exists.');
  }
  const next = [...entries, folder];
  return sourceKeys.length ? moveFavoriteEntries(next, sourceKeys, favoriteEntryKey(folder), 'inside') : next;
}

export function moveFavoriteEntries(entries: FavoriteEntry[], sourceKeys: string[], targetKey: string | null, position: 'before' | 'after' | 'inside' | 'root'): FavoriteEntry[] {
  const keys = [...new Set(sourceKeys)];
  if (!keys.length) throw new Error('Select at least one bookmark.');
  if (targetKey && keys.includes(targetKey)) return entries;
  const sources = keys.map((key) => entries.find((entry) => favoriteEntryKey(entry) === key));
  if (sources.some((entry) => !entry || entry.kind === 'folder')) throw new Error('A selected bookmark is no longer available.');
  const ordered = position === 'after' ? [...keys].reverse() : keys;
  return ordered.reduce((current, key) => moveFavoriteEntry(current, key, targetKey, position), entries);
}

export function moveFavoriteEntry(entries: FavoriteEntry[], sourceKey: string, targetKey: string | null, position: 'before' | 'after' | 'inside' | 'root'): FavoriteEntry[] {
  const source = entries.find((entry) => favoriteEntryKey(entry) === sourceKey);
  const target = targetKey ? entries.find((entry) => favoriteEntryKey(entry) === targetKey) : undefined;
  if (!source || (position !== 'root' && !target) || (target && source.profileId !== target.profileId)) throw new Error('Bookmark destination is no longer available.');
  if (sourceKey === targetKey) return entries;
  if (position === 'inside' && (source.kind === 'folder' || target?.kind !== 'folder')) throw new Error('Only tables and views can be moved into a folder.');
  if (source.kind === 'folder' && target && target.kind !== 'folder' && target.folderId) throw new Error('Folders cannot be nested.');
  const folderId = position === 'inside' && target?.kind === 'folder' ? target.id
    : position === 'root' || target?.kind === 'folder' ? undefined : target?.folderId;
  const moved = source.kind === 'folder' ? source : { ...source, folderId };
  const result = entries.filter((entry) => favoriteEntryKey(entry) !== sourceKey);
  if (position === 'root' || position === 'inside') {
    result.push(moved);
  } else {
    const index = result.findIndex((entry) => favoriteEntryKey(entry) === targetKey);
    result.splice(index + (position === 'after' ? 1 : 0), 0, moved);
  }
  return result;
}
