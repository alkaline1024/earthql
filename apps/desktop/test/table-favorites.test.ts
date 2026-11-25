import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { TreeNode } from '@earthql/core';
import type { LiveConnection } from '../src/renderer/src/store';
import { addTreeNodesToBookmarks, createFavoriteFolder, favoriteEntryKey, moveFavoriteEntries, moveFavoriteEntry, parseTableFavorites, removeFavoriteFolder, selectFavoriteKeys, updateTableFavorites, type FavoriteFolder, type TableFavorite } from '../src/renderer/src/table-favorites';
import { FavoriteContextMenu, treeNodeFullPath } from '../src/renderer/src/components/Sidebar';

vi.mock('../src/renderer/src/api', () => ({
  api: {}, uid: () => 'fixture', errorInfo: (error: Error) => ({ message: error.message }),
  onMenuCommand: () => () => undefined,
}));
vi.mock('../src/renderer/src/components/ContextSubmenu', () => ({
  ContextSubmenu: ({ label, children }: { label: string; children: React.ReactNode }) =>
    createElement('div', { 'aria-label': label }, children),
}));

const table: TreeNode = { kind: 'table', name: 'orders', path: { catalog: 'main', schema: 'sales', name: 'orders' }, hasChildren: false };
const view: TreeNode = { ...table, kind: 'view' };
const other: TreeNode = { ...table, path: { ...table.path, schema: 'archive' } };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock('../src/renderer/src/store');
});

describe('table favorites', () => {
  it('keeps object kinds, paths and profiles distinct, deduplicates additions, and removes only selected objects', () => {
    let favorites = updateTableFavorites([], 'one', [table, table, view, other], true);
    favorites = updateTableFavorites(favorites, 'two', [table], true);
    expect(favorites).toHaveLength(4);
    expect(new Set(favorites.map(favoriteEntryKey)).size).toBe(4);
    const restored = parseTableFavorites(JSON.stringify(favorites));
    expect(restored).toEqual(favorites);
    const removed = updateTableFavorites(restored, 'one', [table, view], false);
    expect(removed.map((item) => [item.profileId, item.kind === 'folder' ? null : item.path.schema])).toEqual([['one', 'archive'], ['two', 'sales']]);
    expect(favorites).toHaveLength(4);
  });

  it('restores legacy favorites and preserves folder placement when re-adding them', () => {
    const legacy = JSON.stringify([{ profileId: 'one', kind: 'table', path: table.path }]);
    const [favorite] = parseTableFavorites(legacy);
    const folder: FavoriteFolder = { kind: 'folder', profileId: 'one', id: 'sales', name: 'Sales', collapsed: true };
    const inside = moveFavoriteEntry([favorite, folder], favoriteEntryKey(favorite), favoriteEntryKey(folder), 'inside');
    const again = updateTableFavorites(inside, 'one', [table], true);
    expect(again).toEqual(inside);
    expect(parseTableFavorites(JSON.stringify(again))).toEqual(again);
  });

  it('reorders folders and favorites, moves between folders and back to the root, and preserves other profiles', () => {
    const a: FavoriteFolder = { kind: 'folder', profileId: 'one', id: 'a', name: 'A', collapsed: false };
    const b: FavoriteFolder = { kind: 'folder', profileId: 'one', id: 'b', name: 'B', collapsed: false };
    const initial = updateTableFavorites([a, b], 'one', [table, view, other], true);
    const foreign = updateTableFavorites(initial, 'two', [table], true);
    const [orders, summary, archive, differentProfile] = foreign.slice(2);
    let entries = moveFavoriteEntry(foreign, favoriteEntryKey(b), favoriteEntryKey(a), 'before');
    expect(entries.slice(0, 2)).toEqual([b, a]);
    entries = moveFavoriteEntry(entries, favoriteEntryKey(orders), favoriteEntryKey(a), 'inside');
    entries = moveFavoriteEntry(entries, favoriteEntryKey(summary), favoriteEntryKey(a), 'inside');
    entries = moveFavoriteEntry(entries, favoriteEntryKey(summary), favoriteEntryKey(orders), 'before');
    expect(entries.filter((entry) => entry.kind !== 'folder' && entry.folderId === 'a').map(favoriteEntryKey))
      .toEqual([favoriteEntryKey(summary), favoriteEntryKey(orders)]);
    entries = moveFavoriteEntry(entries, favoriteEntryKey(orders), favoriteEntryKey(b), 'inside');
    expect(entries.find((entry) => favoriteEntryKey(entry) === favoriteEntryKey(orders))).toMatchObject({ folderId: 'b' });
    entries = moveFavoriteEntry(entries, favoriteEntryKey(orders), null, 'root');
    expect(entries.find((entry) => favoriteEntryKey(entry) === favoriteEntryKey(orders))).toMatchObject({ folderId: undefined });
    expect(entries.find((entry) => favoriteEntryKey(entry) === favoriteEntryKey(differentProfile))).toEqual(differentProfile);
    expect(() => moveFavoriteEntry(entries, favoriteEntryKey(archive), favoriteEntryKey(differentProfile), 'before')).toThrow('destination');
    expect(() => moveFavoriteEntry(entries, favoriteEntryKey(a), favoriteEntryKey(summary), 'before')).toThrow('nested');
    expect(parseTableFavorites(JSON.stringify(entries))).toEqual(entries);
    const removed = removeFavoriteFolder(entries, 'one', 'a');
    expect(removed.find((entry) => favoriteEntryKey(entry) === favoriteEntryKey(summary))).not.toHaveProperty('folderId');
    expect(removed).toHaveLength(entries.length - 1);
    expect(parseTableFavorites(JSON.stringify(removed))).toEqual(removed);
  });

  it('creates a folder and moves a favorite atomically, rejecting stale and foreign sources', () => {
    const folder: FavoriteFolder = { kind: 'folder', profileId: 'one', id: 'a', name: 'Sales', collapsed: false };
    const entries = updateTableFavorites([], 'one', [table], true);
    const created = createFavoriteFolder(entries, folder, [favoriteEntryKey(entries[0])]);
    expect(created).toHaveLength(2);
    expect(created.find((entry) => entry.kind === 'table')).toMatchObject({ folderId: 'a' });
    expect(entries).toHaveLength(1);
    expect(() => createFavoriteFolder(entries, folder, ['missing'])).toThrow('no longer available');
    expect(() => createFavoriteFolder(entries, { ...folder, profileId: 'other' }, [favoriteEntryKey(entries[0])])).toThrow('destination');
    expect(() => createFavoriteFolder(created, folder)).toThrow('already exists');
  });

  it('offers the requested context actions for the section, folders and items', () => {
    const folder: FavoriteFolder = { kind: 'folder', profileId: 'one', id: 'sales', name: 'Sales', collapsed: false };
    const [favorite] = updateTableFavorites([], 'one', [table], true);
    if (favorite.kind === 'folder') throw new Error('Expected favorite');
    const props = { folders: [folder], selected: [favorite], onCreate: vi.fn(), onRename: vi.fn(), onDelete: vi.fn(), onMove: vi.fn(), onMoveNew: vi.fn() };
    const section = renderToStaticMarkup(createElement(FavoriteContextMenu, { ...props, entry: null }));
    expect(section).toContain('Create Folder');
    expect(section).not.toContain('Rename Folder');
    const group = renderToStaticMarkup(createElement(FavoriteContextMenu, { ...props, entry: folder }));
    expect(group).toContain('Rename Folder');
    expect(group).toContain('Delete Folder');
    expect(group).not.toContain('Move to');
    const selected = [{ ...favorite, folderId: folder.id }];
    const item = renderToStaticMarkup(createElement(FavoriteContextMenu, { ...props, selected, entry: selected[0] }));
    expect(item).toContain('Move to');
    expect(item).toContain('Sales');
    expect(item).toContain('New Folder...');
    expect(item).toContain('Remove from Folder');
    expect(item).toContain('disabled=""');
  });

  it('moves multiple favorites in displayed order without partial changes on invalid destinations', () => {
    const folder: FavoriteFolder = { kind: 'folder', profileId: 'one', id: 'a', name: 'Sales', collapsed: false };
    const entries = updateTableFavorites([folder], 'one', [table, view, other], true);
    const keys = entries.slice(1, 3).map(favoriteEntryKey);
    const moved = moveFavoriteEntries(entries, keys, favoriteEntryKey(folder), 'inside');
    expect(moved.filter((entry) => entry.kind !== 'folder' && entry.folderId === 'a').map(favoriteEntryKey)).toEqual(keys);
    const reordered = moveFavoriteEntries(entries, keys, favoriteEntryKey(entries[3]), 'after');
    expect(reordered.slice(1).map(favoriteEntryKey)).toEqual([favoriteEntryKey(entries[3]), ...keys]);
    expect(() => moveFavoriteEntries(entries, [...keys, 'missing'], favoriteEntryKey(folder), 'inside')).toThrow('no longer available');
    expect(entries.slice(1, 3).map(favoriteEntryKey)).toEqual(keys);
    const created = createFavoriteFolder(entries, { ...folder, id: 'b' }, keys);
    expect(created.filter((entry) => entry.kind !== 'folder' && entry.folderId === 'b').map(favoriteEntryKey)).toEqual(keys);
  });

  it('adds selected tree tables and views directly to a folder or root without duplicates', () => {
    const folder: FavoriteFolder = { kind: 'folder', profileId: 'one', id: 'a', name: 'Sales', collapsed: true };
    const initial = updateTableFavorites([folder], 'one', [table], true);
    const dropped = addTreeNodesToBookmarks(initial, 'one', [table, view, table], favoriteEntryKey(folder), 'inside');
    expect(dropped.filter((entry) => entry.kind !== 'folder').map((entry) => [entry.kind, entry.folderId]))
      .toEqual([['table', 'a'], ['view', 'a']]);
    expect(parseTableFavorites(JSON.stringify(dropped))).toEqual(dropped);
    const root = addTreeNodesToBookmarks(dropped, 'one', [table, other], null, 'root');
    expect(root.filter((entry) => entry.kind !== 'folder' && !entry.folderId).map((entry) => entry.path.schema))
      .toEqual(['sales', 'archive']);
    expect(initial).toHaveLength(2);
  });

  it('places tree selections relative to existing bookmarks and rejects invalid destinations', () => {
    const folder: FavoriteFolder = { kind: 'folder', profileId: 'one', id: 'a', name: 'Sales', collapsed: false };
    const initial = addTreeNodesToBookmarks([folder], 'one', [table], favoriteEntryKey(folder), 'inside');
    const target = initial.find((entry) => entry.kind === 'table')!;
    const placed = addTreeNodesToBookmarks(initial, 'one', [table, view, other], favoriteEntryKey(target), 'after');
    expect(placed.filter((entry) => entry.kind !== 'folder').map((entry) => [entry.kind, entry.path.schema, entry.folderId]))
      .toEqual([['table', 'sales', 'a'], ['view', 'sales', 'a'], ['table', 'archive', 'a']]);
    expect(() => addTreeNodesToBookmarks(initial, 'one', [table], 'missing', 'inside')).toThrow('destination');
    expect(() => addTreeNodesToBookmarks(initial, 'two', [table], favoriteEntryKey(folder), 'inside')).toThrow('destination');
    expect(() => addTreeNodesToBookmarks(initial, 'one', [{ ...table, kind: 'schema' }], null, 'root')).toThrow('tables or views');
    expect(initial).toHaveLength(2);
  });

  it('selects, toggles and extends ranges using only currently visible bookmarks', () => {
    const entries = updateTableFavorites([], 'one', [table, view, other], true).filter((entry): entry is TableFavorite => entry.kind !== 'folder');
    const keys = entries.map(favoriteEntryKey);
    const first = selectFavoriteKeys([], entries, null, entries[0], false, false);
    const range = selectFavoriteKeys(first.selected, entries, first.anchor, entries[2], false, true);
    expect(range.selected).toEqual(keys);
    expect(selectFavoriteKeys(range.selected, entries, range.anchor, entries[1], true, false).selected).toEqual([keys[0], keys[2]]);
    expect(selectFavoriteKeys(range.selected, [entries[0], entries[2]], first.anchor, entries[2], false, true).selected).toEqual([keys[0], keys[2]]);
  });

  it('rejects invalid stored paths and copies complete paths for containers and leaves', () => {
    expect(() => parseTableFavorites('[{"profileId":"one","kind":"table","path":{"name":"x","schema":42}}]')).toThrow('Invalid bookmark');
    expect(treeNodeFullPath(table)).toBe('main.sales.orders');
    expect(treeNodeFullPath({ kind: 'schema', name: 'sales', path: { catalog: 'main' }, hasChildren: true })).toBe('main.sales');
    expect(treeNodeFullPath({ kind: 'database', name: 'demo', path: {}, hasChildren: true })).toBe('demo');
  });

  it('persists favorites across reloads and does not change state when saving fails', async () => {
    const saved = new Map<string, string>();
    const setItem = vi.fn((key: string, value: string) => saved.set(key, value));
    vi.stubGlobal('localStorage', { getItem: (key: string) => saved.get(key) ?? null, setItem });
    vi.resetModules();
    const { useApp } = await import('../src/renderer/src/store');
    useApp.getState().setTableFavorites('one', [table, view], true);
    useApp.getState().setFavoritesHeight(320);
    expect(parseTableFavorites(saved.get('earthql.tableFavorites')!)).toHaveLength(2);
    vi.resetModules();
    const restored = await import('../src/renderer/src/store');
    expect(restored.useApp.getState().tableFavorites).toHaveLength(2);
    expect(restored.useApp.getState().favoritesHeight).toBe(320);
    setItem.mockImplementationOnce(() => { throw new Error('Storage unavailable'); });
    restored.useApp.getState().setTableFavorites('one', [table], false);
    expect(restored.useApp.getState().tableFavorites).toHaveLength(2);
    expect(restored.useApp.getState().toasts.at(-1)?.text).toBe('Table bookmarks could not be saved.');
  });

  it('remembers the section visibility per connection profile across reloads and session switches', async () => {
    const saved = new Map<string, string>();
    const setItem = vi.fn((key: string, value: string) => saved.set(key, value));
    vi.stubGlobal('localStorage', { getItem: (key: string) => saved.get(key) ?? null, setItem });
    vi.resetModules();
    const store = await import('../src/renderer/src/store');
    store.useApp.getState().setBookmarksExpanded('one', false);
    store.useApp.getState().setBookmarksExpanded('two', true);
    vi.resetModules();
    const restored = await import('../src/renderer/src/store');
    restored.useApp.setState({
      connections: {
        session: { profileId: 'one', sessionId: 'session', status: 'connected', defaultContext: {}, capabilities: {} as LiveConnection['capabilities'] },
      },
    });
    vi.doMock('../src/renderer/src/store', () => ({
      ...restored,
      useApp: Object.assign((selector?: (state: ReturnType<typeof restored.useApp.getState>) => unknown) =>
        selector ? selector(restored.useApp.getState()) : restored.useApp.getState(), restored.useApp),
    }));
    const { TableFavorites } = await import('../src/renderer/src/components/Sidebar');
    const render = (profileId: string) => renderToStaticMarkup(createElement(TableFavorites, { profileId, filter: '' }));
    expect(render('session')).toContain('aria-expanded="false"');
    expect(render('two')).toContain('aria-expanded="true"');
    expect(render('new')).toContain('aria-expanded="true"');
    expect(render('session')).toContain('aria-expanded="false"');
    setItem.mockImplementationOnce(() => { throw new Error('Storage unavailable'); });
    restored.useApp.getState().setBookmarksExpanded('one', true);
    expect(restored.useApp.getState().bookmarksExpanded.one).toBe(false);
    expect(restored.useApp.getState().toasts.at(-1)?.text).toBe('Bookmarks visibility could not be saved.');
  });

  it('shows only matching favorites for the active profile and scoped connection', async () => {
    vi.resetModules();
    const store = await import('../src/renderer/src/store');
    const anotherCatalog: TreeNode = { ...table, path: { ...table.path, catalog: 'other' } };
    store.useApp.setState({
      connections: { session: { profileId: 'one', sessionId: 'session', status: 'connected', defaultContext: {},
        capabilities: {} as LiveConnection['capabilities'], scope: { kind: 'catalog', name: 'main' } } },
      tableFavorites: updateTableFavorites(updateTableFavorites([], 'one', [table, other, anotherCatalog], true), 'two', [view], true),
    });
    vi.doMock('../src/renderer/src/store', () => ({
      ...store,
      useApp: Object.assign((selector?: (state: ReturnType<typeof store.useApp.getState>) => unknown) =>
        selector ? selector(store.useApp.getState()) : store.useApp.getState(), store.useApp),
    }));
    const { TableFavorites } = await import('../src/renderer/src/components/Sidebar');
    const html = renderToStaticMarkup(createElement(TableFavorites, { profileId: 'session', filter: 'sales' }));
    expect(html).toContain('main.sales.orders');
    expect(html).not.toContain('main.archive.orders');
    expect(html).not.toContain('other.sales.orders');
    expect(html.match(/Remove main.sales.orders from bookmarks/g)).toHaveLength(1);
  });

  it('renders folders with their favorites and controls for organizing them', async () => {
    vi.resetModules();
    const store = await import('../src/renderer/src/store');
    const folder: FavoriteFolder = { kind: 'folder', profileId: 'one', id: 'sales', name: 'Sales', collapsed: false };
    const entries = updateTableFavorites([folder], 'one', [table], true);
    const moved = moveFavoriteEntry(entries, favoriteEntryKey(entries[1]), favoriteEntryKey(folder), 'inside');
    store.useApp.setState({ tableFavorites: moved });
    vi.doMock('../src/renderer/src/store', () => ({
      ...store,
      useApp: Object.assign((selector?: (state: ReturnType<typeof store.useApp.getState>) => unknown) =>
        selector ? selector(store.useApp.getState()) : store.useApp.getState(), store.useApp),
    }));
    const { TableFavorites } = await import('../src/renderer/src/components/Sidebar');
    const html = renderToStaticMarkup(createElement(TableFavorites, { profileId: 'one', filter: '' }));
    expect(html).toContain('New bookmarks folder');
    expect(html).toContain('data-tooltip="+ New Folder..."');
    expect(html).toContain('Resize bookmarks');
    expect(html).toContain('Rename folder Sales');
    expect(html).toContain('Remove folder Sales');
    expect(html).toContain('main.sales.orders');
    expect(html.match(/draggable="true"/g)).toHaveLength(2);
  });
});
