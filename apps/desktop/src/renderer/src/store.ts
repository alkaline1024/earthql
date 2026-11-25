import { create } from 'zustand';
import type { ErrorInfo, ExecContext, Filter, GridRowDelete, GridRowUpdate, InsertCell, ObjectKind, ObjectPath, TreeNode } from '@earthql/core';
import type { OpenConnection, ProfileSummary } from '../../shared/api';
import { sanitizeOverrides, type KeybindingOverrides } from '../../shared/keybindings';
import { api, errorInfo, uid } from './api';
import { assignTabGroup, type TabGroup } from './tab-groups';
import { treeNodeKey } from './tree-selection';
import { parseTableGroups, type TableGroup } from './table-groups';
import { parseTableFavorites, updateTableFavorites, type FavoriteEntry } from './table-favorites';

export interface LiveConnection extends OpenConnection {
  /** 'lost' after a network error; the user can reconnect. */
  status: 'connected' | 'lost';
}

export type Tab = { customTitle?: string; refreshVersion?: number } & (
  | { id: string; kind: 'table'; profileId: string; object: ObjectPath; objectKind: ObjectKind; initialView?: 'data' | 'structure'; initialFilters?: Filter[] }
  | { id: string; kind: 'sql'; profileId: string; title: string; initialSql: string; context: ExecContext }
  | { id: string; kind: 'create'; profileId: string; container: Partial<ObjectPath> }
);

type DistributiveOmit<T, K extends keyof any> = T extends unknown ? Omit<T, K> : never;
export type NewTab = DistributiveOmit<Tab, 'id'> & { id?: string };

/** A practical "no cap" sentinel: the SQL itself is never rewritten, this just stops the client
 *  from capping how many rows it pulls from the (already streaming) cursor. */
export const NO_LIMIT = Number.MAX_SAFE_INTEGER;
export const LIMITS = [100, 500, 1000, 5000, 10000, 50000, 100000, 500000];

export const MAX_CLOSED_TABS = 25;

export type Theme = 'system' | 'light' | 'dark' | 'white' | 'slate' | 'sepia';
export type UiStyle = 'classic' | 'modern';

export type PaneId = 'main' | 'split';

export interface SplitPane {
  tabId: string;
  tabIds: string[];
  mainTabId: string | null;
  side: 'left' | 'right' | 'up' | 'down';
}

export type NotificationCategory = 'Update' | 'Import' | 'Export';
export interface AppNotification {
  id: string;
  category: NotificationCategory;
  text: string;
  timestamp: number;
  read: boolean;
}

export interface Toast {
  id: string;
  kind: 'ok' | 'error' | 'info';
  text: string;
}

export interface GridDraft {
  rows: Record<string, GridRowUpdate>;
  inserts?: { id: string; values: Record<string, InsertCell> }[];
  /** Existing-row deletions awaiting Save; staging a deletion supersedes that row's edits. */
  deletes?: Record<string, GridRowDelete>;
  saving?: boolean;
  error?: ErrorInfo;
}

interface AppState {
  draggedTabId: string | null;
  draggedTabWidth: number;
  setDraggedTabId(id: string | null, width?: number): void;
  sidebarWidth: number;
  setSidebarWidth(width: number): void;
  favoritesHeight: number;
  setFavoritesHeight(height: number): void;
  bookmarksExpanded: Record<string, boolean>;
  setBookmarksExpanded(profileId: string, expanded: boolean): void;
  sidebarSection: 'items' | 'queries' | 'history';
  setSidebarSection(section: 'items' | 'queries' | 'history'): void;
  profiles: ProfileSummary[];
  connections: Record<string, LiveConnection>;
  sidebarConnectionOrder: string[];
  moveConnection(sourceId: string, targetId: string, after: boolean): void;
  tableGroups: TableGroup[];
  saveTableGroups(groups: TableGroup[]): boolean;
  connecting: Record<string, boolean>;
  connectErrors: Record<string, ErrorInfo | undefined>;
  activeProfileId: string | null;
  screen: 'connections' | 'workspace';
  tabs: Tab[];
  activeTabId: string | null;
  /** Most-recently-closed last; capped at MAX_CLOSED_TABS. */
  closedTabs: Tab[];
  reopenClosedTab(): void;
  /** Two independent tab panels share one resizable divider. */
  focusedPane: PaneId;
  focusPane(pane: PaneId): void;
  moveTabToPane(tabId: string, pane: PaneId): void;
  splitPane: SplitPane | null;
  openSplit(tabId: string, side: SplitPane['side']): void;
  closeSplit(): void;
  tabGroups: TabGroup[];
  gridDrafts: Record<string, GridDraft>;
  unsavedStructureTabs: Record<string, true | 'saving'>;
  /** Bumped to make the sidebar reload a container node: key = profileId + path */
  treeRefresh: Record<string, number>;
  /** Tables/views pinned to the top of their sidebar list (persisted). Keys from pinnedTableKey(). */
  pinnedTables: string[];
  setTablePinned(profileId: string, nodes: TreeNode[], pinned: boolean): void;
  tableFavorites: FavoriteEntry[];
  setTableFavorites(profileId: string, nodes: TreeNode[], favorite: boolean): void;
  saveTableFavorites(entries: FavoriteEntry[]): boolean;
  toasts: Toast[];
  notifications: AppNotification[];
  addNotification(category: NotificationCategory, text: string): void;
  markNotificationsRead(): void;
  sqlCounter: number;
  /** Which action the SQL toolbar's Run button performs by default (persisted, app-wide). */
  sqlRunDefault: 'current' | 'all';
  setSqlRunDefault(mode: 'current' | 'all'): void;
  /** Row limit a newly opened SQL tab starts with (persisted). */
  defaultRowLimit: number;
  setDefaultRowLimit(limit: number): void;
  /** Whether Beautify upper-cases SQL keywords (persisted). */
  beautifyUppercase: boolean;
  setBeautifyUppercase(uppercase: boolean): void;
  /** Color theme (persisted; 'system' follows the OS). */
  theme: Theme;
  setTheme(theme: Theme): void;
  /** Visual style, independent of the color theme (persisted). */
  uiStyle: UiStyle;
  setUiStyle(style: UiStyle): void;
  /** Shortcuts the user changed from the defaults in shared/keybindings (persisted). null = unbound. */
  keybindings: KeybindingOverrides;
  /** Pass null to unbind; pass undefined-equivalent via resetKeybinding to restore the default. */
  setKeybinding(id: string, accelerator: string | null): void;
  /** Rebinds several shortcuts in one step (used to swap or steal a conflicting shortcut). */
  setKeybindings(changes: KeybindingOverrides): void;
  resetKeybinding(id: string): void;
  resetAllKeybindings(): void;
  discardPrompt: { resolve: (discard: boolean) => void } | null;
  confirmDiscard(): Promise<boolean>;
  resolveDiscard(discard: boolean): void;

  loadProfiles(): Promise<void>;
  moveProfile(sourceId: string | string[], targetId: string, after: boolean): void;
  connect(profileId: string): Promise<boolean>;
  openSeparate(sessionId: string, name: string): Promise<void>;
  disconnect(sessionId: string): Promise<void>;
  disconnectProfile(profileId: string): Promise<boolean>;
  markLost(profileId: string): void;
  editProfileId?: string;
  setScreen(s: AppState['screen']): void;
  setActiveProfile(id: string): void;
  openTab(tab: NewTab): string;
  setTableView(id: string, view: 'data' | 'structure'): void;
  closeTab(id: string): void;
  closeTabs(ids: string[], keepId?: string): void;
  renameTab(id: string, title: string): void;
  refreshTab(id: string, preserveDrafts?: boolean): Promise<void>;
  activateTab(id: string): void;
  moveTab(sourceId: string | string[], targetId: string, after: boolean): void;
  moveTabsToGroup(ids: string[], groupId: string | null): void;
  createTabGroup(name: string, tabIds: string[], color: string): string;
  renameTabGroup(id: string, name: string): void;
  setTabGroupColor(id: string, color: string): void;
  toggleTabGroupCollapsed(id: string): void;
  removeTabGroup(id: string): void;
  setGridDraft(id: string, draft: GridDraft | undefined): void;
  newSqlTab(profileId: string, sql?: string, context?: ExecContext, title?: string): string;
  refreshTree(profileId: string, container: Partial<ObjectPath>): void;
  dismissToast(id: string): void;
  toast(kind: Toast['kind'], text: string, category?: NotificationCategory): void;
}

export const containerKey = (profileId: string, p: Partial<ObjectPath>) =>
  `${profileId}|${p.catalog ?? ''}|${p.database ?? ''}|${p.schema ?? ''}`;

export const pinnedTableKey = (profileId: string, node: Pick<TreeNode, 'kind' | 'path'>) =>
  `${profileId}|${treeNodeKey(node)}`;

function loadPinnedTables(): string[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem('earthql.pinnedTables') ?? '[]');
    return Array.isArray(raw) && raw.every((item) => typeof item === 'string') ? raw : [];
  } catch {
    return [];
  }
}

function loadSqlRunDefault(): 'current' | 'all' {
  try {
    return localStorage.getItem('earthql.sqlRunDefault') === 'all' ? 'all' : 'current';
  } catch {
    return 'current';
  }
}

function loadDefaultRowLimit(): number {
  try {
    const raw = localStorage.getItem('earthql.defaultRowLimit');
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) && n > 0 ? n : 1000;
  } catch {
    return 1000;
  }
}

function loadBeautifyUppercase(): boolean {
  try {
    return localStorage.getItem('earthql.beautifyUppercase') !== 'false';
  } catch {
    return true;
  }
}

function loadKeybindings(): KeybindingOverrides {
  try {
    return sanitizeOverrides(JSON.parse(localStorage.getItem('earthql.keybindings') ?? '{}'));
  } catch {
    return {};
  }
}

function loadSidebarConnectionOrder(): string[] {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem('earthql.sidebarConnectionOrder') ?? '[]');
    return Array.isArray(saved) ? [...new Set(saved.filter((id): id is string => typeof id === 'string'))] : [];
  } catch (error) {
    console.warn('Sidebar connection order could not be restored.', error);
    return [];
  }
}

function loadTableGroups(): TableGroup[] {
  try {
    return parseTableGroups(localStorage.getItem('earthql.tableGroups'));
  } catch (error) {
    console.warn('Sidebar table groups could not be restored.', error);
    return [];
  }
}

function loadTableFavorites(): FavoriteEntry[] {
  try {
    return parseTableFavorites(localStorage.getItem('earthql.tableFavorites'));
  } catch (error) {
    console.warn('Table bookmarks could not be restored.', error);
    return [];
  }
}

function loadBookmarksExpanded(): Record<string, boolean> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem('earthql.bookmarksExpanded') ?? '{}');
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return {};
    return Object.fromEntries(Object.entries(saved).filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean'));
  } catch (error) {
    console.warn('Bookmarks visibility could not be restored.', error);
    return {};
  }
}

/** Keep saved session order, ignore closed sessions, and append newly opened connections. */
export function orderedConnectionIds(connections: Record<string, LiveConnection>, order: string[]): string[] {
  return [...new Set([...order, ...Object.keys(connections)])].filter((id) => Object.hasOwn(connections, id));
}

function commitKeybindings(next: KeybindingOverrides) {
  const { toast } = useApp.getState();
  try {
    if (Object.keys(next).length) localStorage.setItem('earthql.keybindings', JSON.stringify(next));
    else localStorage.removeItem('earthql.keybindings');
  } catch {
    toast('error', 'Shortcuts could not be saved.');
  }
  useApp.setState({ keybindings: next });
  api.keybindings.apply(next).catch(() => toast('error', 'Shortcuts could not be applied to the menu.'));
}

const THEMES: Theme[] = ['system', 'light', 'dark', 'white', 'slate', 'sepia'];

function loadTheme(): Theme {
  try {
    const raw = localStorage.getItem('earthql.theme');
    return (THEMES as string[]).includes(raw ?? '') ? (raw as Theme) : 'system';
  } catch {
    return 'system';
  }
}

/** Reflects the chosen theme onto <html data-theme="..."> so CSS can key off it; 'system' removes the attribute. */
function applyTheme(theme: Theme) {
  try {
    if (theme === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.dataset.theme = theme;
  } catch {
    // No DOM available (e.g. under test) — the preference is still stored.
  }
}

function loadUiStyle(): UiStyle {
  try {
    return localStorage.getItem('earthql.uiStyle') === 'modern' ? 'modern' : 'classic';
  } catch {
    return 'classic';
  }
}

function applyUiStyle(style: UiStyle) {
  if (typeof document !== 'undefined') document.documentElement.dataset.uiStyle = style;
}

function opened(state: AppState, sessionId: string, connection: OpenConnection): Partial<AppState> {
  const root = containerKey(sessionId, {});
  return {
    connections: { ...state.connections, [sessionId]: { ...connection, status: 'connected' } },
    activeProfileId: sessionId,
    screen: 'workspace',
    treeRefresh: { ...state.treeRefresh, [root]: (state.treeRefresh[root] ?? 0) + 1 },
  };
}

async function canDisconnect(state: AppState, sessionIds: string[]) {
  const drafts = state.tabs.filter((t) => sessionIds.includes(t.profileId)).map((t) => state.gridDrafts[t.id]).filter(Boolean);
  if (drafts.some((draft) => draft.saving)) {
    state.toast('info', 'Wait for the cell changes to finish saving.');
    return false;
  }
  return !drafts.length || await state.confirmDiscard();
}

/** Clears `collapsed` on the group containing `tabId`, if any, so activating a tab never leaves it hidden. */
function expandGroupOf(groups: TabGroup[], tabId: string): TabGroup[] {
  return groups.map((group) => group.collapsed && group.tabIds.includes(tabId) ? { ...group, collapsed: false } : group);
}

/** Removes the given tab ids from every group and drops any group left with none. */
function withoutTabs(groups: TabGroup[], removedIds: string[]): TabGroup[] {
  return assignTabGroup(groups, removedIds, null).filter((group) => group.tabIds.length > 0);
}

/** Keep pane selections valid when tabs close or a connection disconnects. */
function remainingPanes(state: AppState, tabs: Tab[], activeId: string | null): Partial<AppState> {
  const split = state.splitPane;
  if (!split) return { focusedPane: 'main' };
  const tabIds = split.tabIds.filter((id) => tabs.some((tab) => tab.id === id));
  if (!tabIds.length) return { splitPane: null, focusedPane: 'main' };
  const main = tabs.filter((tab) => !tabIds.includes(tab.id));
  const mainTabId = main.find((tab) => tab.id === split.mainTabId)?.id ?? main.at(-1)?.id ?? null;
  const tabId = tabIds.includes(split.tabId) ? split.tabId : tabIds.at(-1)!;
  // Prefer the next tab in the panel that had focus.
  const selected = tabs.some((tab) => tab.id === state.activeTabId)
    ? activeId : state.focusedPane === 'split' ? tabId : mainTabId ?? tabId;
  return { splitPane: { ...split, tabIds, tabId, mainTabId }, activeTabId: selected,
    focusedPane: selected && tabIds.includes(selected) ? 'split' : 'main',
    ...(selected ? { activeProfileId: tabs.find((tab) => tab.id === selected)?.profileId } : {}),
  };
}

function disconnected(state: AppState, sessionIds: string[]): Partial<AppState> {
  const closing = new Set(sessionIds);
  const connections = Object.fromEntries(Object.entries(state.connections).filter(([id]) => !closing.has(id)));
  const remaining = Object.keys(connections);
  const removedTabIds = state.tabs.filter((tab) => closing.has(tab.profileId)).map((tab) => tab.id);
  const tabs = state.tabs.filter((tab) => !closing.has(tab.profileId));
  const active = tabs.find((tab) => tab.id === state.activeTabId) ?? tabs.at(-1);
  const tabGroups = withoutTabs(state.tabGroups, removedTabIds);
  return {
    connections,
    tabs,
    gridDrafts: Object.fromEntries(tabs.flatMap(({ id }) => state.gridDrafts[id] ? [[id, state.gridDrafts[id]]] : [])),
    treeRefresh: Object.fromEntries(Object.entries(state.treeRefresh).filter(([key]) => !closing.has(key.split('|', 1)[0]))),
    activeTabId: active?.id ?? null,
    activeProfileId: state.activeProfileId && !closing.has(state.activeProfileId) ? state.activeProfileId : (active?.profileId ?? remaining[0] ?? null),
    screen: remaining.length ? state.screen : 'connections',
    tabGroups: active ? expandGroupOf(tabGroups, active.id) : tabGroups,
    ...remainingPanes(state, tabs, active?.id ?? null),
  };
}

const initialTheme = loadTheme();
applyTheme(initialTheme);
const initialUiStyle = loadUiStyle();
applyUiStyle(initialUiStyle);

export const useApp = create<AppState>((set, get) => ({
  draggedTabId: null,
  draggedTabWidth: 180,
  setDraggedTabId: (draggedTabId, width) => set({ draggedTabId, ...(width ? { draggedTabWidth: width } : {}) }),
  sidebarWidth: (() => {
    try {
      const width = Number(localStorage.getItem('earthql.sidebarWidth'));
      return Number.isFinite(width) && width >= 200 ? Math.min(480, width) : 272;
    } catch { return 272; }
  })(),
  setSidebarWidth(width) {
    if (!Number.isFinite(width)) return;
    const sidebarWidth = Math.max(200, Math.min(480, width));
    try { localStorage.setItem('earthql.sidebarWidth', String(sidebarWidth)); } catch { /* Storage may be unavailable. */ }
    set({ sidebarWidth });
  },
  favoritesHeight: (() => {
    try {
      const height = Number(localStorage.getItem('earthql.favoritesHeight'));
      return Number.isFinite(height) && height >= 64 ? height : 210;
    } catch { return 210; }
  })(),
  setFavoritesHeight(height) {
    if (!Number.isFinite(height) || height < 64) return;
    try {
      localStorage.setItem('earthql.favoritesHeight', String(height));
    } catch {
      get().toast('error', 'Bookmarks height could not be saved.');
      return;
    }
    set({ favoritesHeight: height });
  },
  bookmarksExpanded: loadBookmarksExpanded(),
  setBookmarksExpanded(profileId, expanded) {
    const next = { ...get().bookmarksExpanded, [profileId]: expanded };
    try {
      localStorage.setItem('earthql.bookmarksExpanded', JSON.stringify(next));
    } catch {
      get().toast('error', 'Bookmarks visibility could not be saved.');
      return;
    }
    set({ bookmarksExpanded: next });
  },
  sidebarSection: 'items',
  setSidebarSection: (sidebarSection) => set({ sidebarSection }),
  profiles: [],
  connections: {},
  sidebarConnectionOrder: loadSidebarConnectionOrder(),
  tableGroups: loadTableGroups(),
  saveTableGroups(groups) {
    try {
      localStorage.setItem('earthql.tableGroups', JSON.stringify(groups));
    } catch {
      get().toast('error', 'Sidebar table groups could not be saved.');
      return false;
    }
    set({ tableGroups: groups });
    return true;
  },
  moveConnection(sourceId, targetId, after) {
    const current = get();
    if (sourceId === targetId || !Object.hasOwn(current.connections, sourceId) || !Object.hasOwn(current.connections, targetId)) return;
    const savedProfiles = new Set(current.profiles.map(({ profile }) => profile.id));
    // Retain closed saved profiles, but forget closed temporary sessions.
    const order = [...new Set([
      ...current.sidebarConnectionOrder.filter((id) => Object.hasOwn(current.connections, id) || savedProfiles.has(id)),
      ...Object.keys(current.connections),
    ])];
    order.splice(order.indexOf(sourceId), 1);
    order.splice(order.indexOf(targetId) + (after ? 1 : 0), 0, sourceId);
    try {
      localStorage.setItem('earthql.sidebarConnectionOrder', JSON.stringify(order));
    } catch {
      get().toast('error', 'Sidebar connection order could not be saved.');
    }
    set({ sidebarConnectionOrder: order });
  },
  connecting: {},
  connectErrors: {},
  activeProfileId: null,
  screen: 'connections',
  tabs: [],
  activeTabId: null,
  closedTabs: [],
  reopenClosedTab() {
    const s = get();
    const last = s.closedTabs.at(-1);
    if (!last) return;
    const id = uid();
    const tab = { ...last, id, refreshVersion: undefined } as Tab;
    set({ closedTabs: s.closedTabs.slice(0, -1) });
    get().openTab(tab);
  },
  splitPane: null,
  focusedPane: 'main',
  focusPane(pane) {
    const s = get();
    const selected = pane === 'split' ? s.splitPane?.tabId : s.splitPane?.mainTabId ?? (s.splitPane ? null : s.activeTabId);
    set({ focusedPane: s.splitPane ? pane : 'main' });
    if (selected) get().activateTab(selected);
    else set({ activeTabId: null });
  },
  openSplit(tabId, side) {
    const s = get();
    if (!s.tabs.some((tab) => tab.id === tabId)) return;
    const tabIds = [...new Set([...(s.splitPane?.tabIds ?? []), tabId])];
    const mainTabs = s.tabs.filter((tab) => !tabIds.includes(tab.id));
    const mainTabId = mainTabs.find((tab) => tab.id === (s.splitPane?.mainTabId ?? s.activeTabId))?.id ?? mainTabs.at(-1)?.id ?? null;
    set({ splitPane: { tabId, tabIds, mainTabId, side }, focusedPane: 'split' });
    get().activateTab(tabId);
  },
  moveTabToPane(tabId, pane) {
    const s = get();
    if (!s.splitPane || !s.tabs.some((tab) => tab.id === tabId)) return;
    if (pane === 'split') return get().openSplit(tabId, s.splitPane.side);
    const tabIds = s.splitPane.tabIds.filter((id) => id !== tabId);
    set({ splitPane: tabIds.length ? { ...s.splitPane, tabIds, tabId: tabIds.includes(s.splitPane.tabId) ? s.splitPane.tabId : tabIds.at(-1)!, mainTabId: tabId } : null });
    get().activateTab(tabId);
  },
  closeSplit() {
    set({ splitPane: null, focusedPane: 'main' });
  },
  tabGroups: [],
  gridDrafts: {},
  unsavedStructureTabs: {},
  treeRefresh: {},
  tableFavorites: loadTableFavorites(),
  setTableFavorites(profileId, nodes, favorite) {
    get().saveTableFavorites(updateTableFavorites(get().tableFavorites, profileId, nodes, favorite));
  },
  saveTableFavorites(next) {
    try {
      localStorage.setItem('earthql.tableFavorites', JSON.stringify(next));
    } catch {
      get().toast('error', 'Table bookmarks could not be saved.');
      return false;
    }
    set({ tableFavorites: next });
    return true;
  },
  pinnedTables: loadPinnedTables(),
  setTablePinned(profileId, nodes, pinned) {
    const keys = nodes.map((node) => pinnedTableKey(profileId, node));
    set((s) => {
      const next = pinned
        ? [...new Set([...s.pinnedTables, ...keys])]
        : s.pinnedTables.filter((key) => !keys.includes(key));
      try {
        localStorage.setItem('earthql.pinnedTables', JSON.stringify(next));
      } catch {
        get().toast('error', 'Pinned tables could not be saved.');
      }
      return { pinnedTables: next };
    });
  },
  toasts: [],
  notifications: [],
  addNotification(category, text) {
    const entry = { id: uid(), category, text, timestamp: Date.now(), read: false };
    set((state) => ({ notifications: [entry, ...state.notifications].slice(0, 100) }));
  },
  markNotificationsRead() {
    set((state) => ({ notifications: state.notifications.map((entry) => ({ ...entry, read: true })) }));
  },
  sqlCounter: 0,
  sqlRunDefault: loadSqlRunDefault(),
  setSqlRunDefault(mode) {
    try {
      localStorage.setItem('earthql.sqlRunDefault', mode);
    } catch {
      get().toast('error', 'Default run action could not be saved.');
    }
    set({ sqlRunDefault: mode });
  },
  defaultRowLimit: loadDefaultRowLimit(),
  setDefaultRowLimit(limit) {
    try {
      localStorage.setItem('earthql.defaultRowLimit', String(limit));
    } catch {
      get().toast('error', 'Default row limit could not be saved.');
    }
    set({ defaultRowLimit: limit });
  },
  beautifyUppercase: loadBeautifyUppercase(),
  setBeautifyUppercase(uppercase) {
    try {
      localStorage.setItem('earthql.beautifyUppercase', String(uppercase));
    } catch {
      get().toast('error', 'Preference could not be saved.');
    }
    set({ beautifyUppercase: uppercase });
  },
  keybindings: loadKeybindings(),
  setKeybinding(id, accelerator) {
    get().setKeybindings({ [id]: accelerator });
  },
  setKeybindings(changes) {
    commitKeybindings(sanitizeOverrides({ ...get().keybindings, ...changes }));
  },
  resetKeybinding(id) {
    const next = { ...get().keybindings };
    delete next[id];
    commitKeybindings(next);
  },
  resetAllKeybindings() {
    commitKeybindings({});
  },
  theme: initialTheme,
  setTheme(theme) {
    try {
      localStorage.setItem('earthql.theme', theme);
    } catch {
      get().toast('error', 'Theme could not be saved.');
    }
    applyTheme(theme);
    set({ theme });
  },
  uiStyle: initialUiStyle,
  setUiStyle(style) {
    try {
      localStorage.setItem('earthql.uiStyle', style);
    } catch {
      get().toast('error', 'UI style could not be saved.');
    }
    applyUiStyle(style);
    set({ uiStyle: style });
  },
  discardPrompt: null,
  confirmDiscard() {
    if (get().discardPrompt) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => set({ discardPrompt: { resolve } }));
  },
  resolveDiscard(discard) {
    const prompt = get().discardPrompt;
    set({ discardPrompt: null });
    prompt?.resolve(discard);
  },

  async loadProfiles() {
    const profiles = await api.profiles.list();
    let order: string[] = [];
    try {
      const saved: unknown = JSON.parse(localStorage.getItem('earthql.connectionOrder') ?? '[]');
      if (Array.isArray(saved)) order = saved.filter((id): id is string => typeof id === 'string');
    } catch { /* Use the default order if storage is unavailable. */ }
    const rank = new Map(order.map((id, index) => [id, index]));
    profiles.sort((a, b) => (rank.get(a.profile.id) ?? order.length) - (rank.get(b.profile.id) ?? order.length));
    set({ profiles });
  },

  moveProfile(sourceId, targetId, after) {
    const profiles = [...get().profiles];
    const sourceIds = new Set(typeof sourceId === 'string' ? [sourceId] : sourceId);
    if (sourceIds.has(targetId) || !profiles.some(({ profile }) => profile.id === targetId)) return;
    const moved = profiles.filter(({ profile }) => sourceIds.has(profile.id));
    if (!moved.length) return;
    const remaining = profiles.filter(({ profile }) => !sourceIds.has(profile.id));
    const target = remaining.findIndex(({ profile }) => profile.id === targetId);
    remaining.splice(target + (after ? 1 : 0), 0, ...moved);
    profiles.splice(0, profiles.length, ...remaining);
    try {
      localStorage.setItem('earthql.connectionOrder', JSON.stringify(profiles.map(({ profile }) => profile.id)));
    } catch {
      get().toast('error', 'Connection order could not be saved.');
    }
    set({ profiles });
  },

  async connect(profileId) {
    const state = get();
    if (state.connecting[profileId]) return false;
    set((s) => ({ connecting: { ...s.connecting, [profileId]: true }, connectErrors: { ...s.connectErrors, [profileId]: undefined } }));
    const reconnectStarted = state.connections[profileId] ? performance.now() : undefined;
    try {
      const connection = await (state.connections[profileId] ? api.connection.reconnect(profileId) : api.connection.open(profileId));
      set((s) => opened(s, profileId, connection));
      return true;
    } catch (e) {
      set((s) => ({ connectErrors: { ...s.connectErrors, [profileId]: errorInfo(e) } }));
      return false;
    } finally {
      if (reconnectStarted !== undefined) {
        const remaining = 450 - (performance.now() - reconnectStarted);
        if (remaining > 0) await new Promise<void>((resolve) => setTimeout(resolve, remaining));
      }
      set((s) => ({ connecting: { ...s.connecting, [profileId]: false } }));
    }
  },

  async openSeparate(sessionId, name) {
    const connection = await api.connection.openSeparate(sessionId, name);
    set((s) => opened(s, connection.sessionId, connection));
  },

  async disconnect(sessionId) {
    if (!await canDisconnect(get(), [sessionId])) return;
    try {
      await api.connection.close(sessionId);
      set((s) => disconnected(s, [sessionId]));
    } catch (e) {
      get().toast('error', errorInfo(e).message);
    }
  },

  async disconnectProfile(profileId) {
    const current = get();
    const ids = Object.keys(current.connections).filter((id) => current.connections[id].profileId === profileId);
    if (!await canDisconnect(current, ids)) return false;
    await api.connection.closeProfile(profileId);
    set((s) => disconnected(s, Object.keys(s.connections).filter((id) => s.connections[id].profileId === profileId)));
    return true;
  },

  markLost(profileId) {
    set((s) => (s.connections[profileId] ? { connections: { ...s.connections, [profileId]: { ...s.connections[profileId], status: 'lost' } } } : {}));
  },

  setScreen(screen) {
    set({ screen });
  },

  setActiveProfile(id) {
    set({ activeProfileId: id });
  },

  openTab(tab) {
    const s = get();
    // A foreign-key link opens a separate tab so it cannot overwrite another tab's filters or drafts.
    if (tab.kind === 'table' && !tab.initialFilters?.length) {
      const existing = s.tabs.find((t) => t.kind === 'table' && t.profileId === tab.profileId && !t.initialFilters?.length
        && JSON.stringify(t.object) === JSON.stringify(tab.object));
      if (existing) {
        set({
          activeTabId: existing.id,
          activeProfileId: tab.profileId,
          screen: 'workspace',
          tabs: tab.initialView === undefined ? s.tabs : s.tabs.map((current) => current.id === existing.id ? { ...current, initialView: tab.initialView } as Tab : current),
          tabGroups: expandGroupOf(s.tabGroups, existing.id),
        });
        get().activateTab(existing.id);
        return existing.id;
      }
    }
    const id = tab.id ?? uid();
    const splitPane = s.splitPane ? s.focusedPane === 'split'
      ? { ...s.splitPane, tabIds: [...s.splitPane.tabIds, id], tabId: id }
      : { ...s.splitPane, mainTabId: id } : null;
    set({ tabs: [...s.tabs, { ...tab, id } as Tab], splitPane, activeTabId: id, activeProfileId: tab.profileId, screen: 'workspace' });
    return id;
  },

  setTableView(id, view) {
    set((s) => ({ tabs: s.tabs.map((tab) => tab.id === id && tab.kind === 'table' ? { ...tab, initialView: view } : tab) }));
  },

  closeTab(id) {
    get().closeTabs([id]);
  },

  async closeTabs(ids, keepId) {
    let current = get();
    const closing = new Set(ids);
    let tabs = current.tabs.filter((tab) => !closing.has(tab.id));
    if (tabs.length === current.tabs.length) return;
    const drafts = ids.map((id) => current.gridDrafts[id]).filter(Boolean);
    if (drafts.some((draft) => draft.saving) || ids.some((id) => current.unsavedStructureTabs[id] === 'saving')) return current.toast('info', 'Wait for changes to finish saving.');
    if ((drafts.length || ids.some((id) => current.unsavedStructureTabs[id])) && !await current.confirmDiscard()) return;

    current = get();
    if (ids.some((id) => current.gridDrafts[id]?.saving || current.unsavedStructureTabs[id] === 'saving')) return current.toast('info', 'Wait for the cell changes to finish saving.');
    tabs = current.tabs.filter((tab) => !closing.has(tab.id));
    const activeIndex = current.tabs.findIndex((tab) => tab.id === current.activeTabId);
    const previousProfileId = current.tabs[activeIndex]?.profileId;
    // Closing a tab never switches the active connection by itself: stay on another tab for the same
    // connection (closest to where the active tab was) when one remains, and only fall back to a
    // different connection's tab once none of the previous connection's tabs are left open.
    const sameProfile = tabs
      .filter((tab) => tab.profileId === previousProfileId)
      .sort((a, b) => Math.abs(current.tabs.indexOf(a) - activeIndex) - Math.abs(current.tabs.indexOf(b) - activeIndex));
    const active = tabs.find((tab) => tab.id === (keepId ?? current.activeTabId))
      ?? sameProfile[0]
      ?? current.tabs.slice(Math.max(0, activeIndex)).find((tab) => !closing.has(tab.id))
      ?? tabs.at(-1);
    const tabGroups = withoutTabs(current.tabGroups, ids);
    const closedNow = current.tabs.filter((tab) => closing.has(tab.id));
    set({
      tabs,
      activeTabId: active?.id ?? null,
      ...(active && active.id !== current.activeTabId ? { activeProfileId: active.profileId } : {}),
      gridDrafts: Object.fromEntries(Object.entries(current.gridDrafts).filter(([id]) => !closing.has(id))),
      tabGroups: active ? expandGroupOf(tabGroups, active.id) : tabGroups,
      ...remainingPanes(current, tabs, active?.id ?? null),
      closedTabs: [...current.closedTabs, ...closedNow].slice(-MAX_CLOSED_TABS),
    });
  },

  renameTab(id, title) {
    const customTitle = title.trim();
    if (!customTitle) return;
    set((s) => ({ tabs: s.tabs.map((tab) => tab.id === id ? { ...tab, customTitle } : tab) }));
  },

  async refreshTab(id, preserveDrafts = false) {
    const current = get();
    if (current.gridDrafts[id]?.saving || current.unsavedStructureTabs[id] === 'saving') return current.toast('info', 'Wait for the cell changes to finish saving.');
    if (!preserveDrafts && (current.gridDrafts[id] || current.unsavedStructureTabs[id]) && !await current.confirmDiscard()) return;
    if (get().gridDrafts[id]?.saving || get().unsavedStructureTabs[id] === 'saving' || !get().tabs.some((tab) => tab.id === id)) return;
    set((state) => {
      const gridDrafts = { ...state.gridDrafts };
      const unsavedStructureTabs = { ...state.unsavedStructureTabs };
      if (!preserveDrafts) {
        delete gridDrafts[id];
        delete unsavedStructureTabs[id];
      }
      return { gridDrafts, unsavedStructureTabs,
        tabs: state.tabs.map((tab) => tab.id === id ? { ...tab, refreshVersion: (tab.refreshVersion ?? 0) + 1 } : tab) };
    });
  },

  activateTab(id) {
    const t = get().tabs.find((x) => x.id === id);
    if (!t) return;
    set((s) => ({ activeTabId: id, activeProfileId: t.profileId, tabGroups: expandGroupOf(s.tabGroups, id),
      focusedPane: s.splitPane?.tabIds.includes(id) ? 'split' : 'main',
      splitPane: s.splitPane ? s.splitPane.tabIds.includes(id) ? { ...s.splitPane, tabId: id } : { ...s.splitPane, mainTabId: id } : null,
    }));
  },

  moveTab(sourceId, targetId, after) {
    const tabs = [...get().tabs];
    const sourceIds = new Set(typeof sourceId === 'string' ? [sourceId] : sourceId);
    if (sourceIds.has(targetId) || !tabs.some((tab) => tab.id === targetId)) return;
    const moved = tabs.filter((tab) => sourceIds.has(tab.id));
    if (!moved.length) return;
    const remaining = tabs.filter((tab) => !sourceIds.has(tab.id));
    const target = remaining.findIndex((tab) => tab.id === targetId);
    remaining.splice(target + (after ? 1 : 0), 0, ...moved);
    set({ tabs: remaining });
  },

  moveTabsToGroup(ids, groupId) {
    const tabGroups = assignTabGroup(get().tabGroups, ids, groupId);
    set({ tabGroups });
    if (groupId === null) return;
    const group = tabGroups.find((g) => g.id === groupId);
    const lastOther = group?.tabIds.filter((id) => !ids.includes(id)).at(-1);
    if (lastOther) get().moveTab(ids, lastOther, true);
  },

  createTabGroup(name, tabIds, color) {
    const id = uid();
    set((s) => ({ tabGroups: [...s.tabGroups, { id, name, color, tabIds: [], collapsed: false }] }));
    get().moveTabsToGroup(tabIds, id);
    return id;
  },

  renameTabGroup(id, name) {
    const trimmed = name.trim();
    if (!trimmed) return;
    set((s) => ({ tabGroups: s.tabGroups.map((g) => g.id === id ? { ...g, name: trimmed } : g) }));
  },

  setTabGroupColor(id, color) {
    set((s) => ({ tabGroups: s.tabGroups.map((g) => g.id === id ? { ...g, color } : g) }));
  },

  toggleTabGroupCollapsed(id) {
    set((s) => ({ tabGroups: s.tabGroups.map((g) => g.id === id ? { ...g, collapsed: !g.collapsed } : g) }));
  },

  removeTabGroup(id) {
    set((s) => ({ tabGroups: s.tabGroups.filter((g) => g.id !== id) }));
  },

  setGridDraft(id, draft) {
    set((s) => {
      if (!s.tabs.some((t) => t.id === id)) return {};
      const gridDrafts = { ...s.gridDrafts };
      if (draft) gridDrafts[id] = draft;
      else delete gridDrafts[id];
      return { gridDrafts };
    });
  },

  newSqlTab(profileId, sql = '', context, title) {
    const n = get().sqlCounter + 1;
    set({ sqlCounter: n });
    const conn = get().connections[profileId];
    return get().openTab({
      kind: 'sql',
      profileId,
      title: title ?? `Query ${n}`,
      initialSql: sql,
      context: context ?? conn?.defaultContext ?? {},
    });
  },

  refreshTree(profileId, container) {
    const k = containerKey(profileId, container);
    set((s) => ({ treeRefresh: { ...s.treeRefresh, [k]: (s.treeRefresh[k] ?? 0) + 1 } }));
  },

  dismissToast(id) {
    set((s) => ({ toasts: s.toasts.filter((toast) => toast.id !== id) }));
  },

  toast(kind, text, category) {
    if (category) get().addNotification(category, text);
    const id = uid();
    set((s) => ({ toasts: [...s.toasts, { id, kind, text }] }));
    setTimeout(() => get().dismissToast(id), kind === 'error' ? 7000 : 4000);
  },
}));

export function profileOf(profileId: string): ProfileSummary | undefined {
  const { connections, profiles } = useApp.getState();
  const savedId = connections[profileId]?.profileId ?? profileId;
  return profiles.find((p) => p.profile.id === savedId);
}

export function connectionName(sessionId: string): string {
  const name = profileOf(sessionId)?.profile.name || 'Unnamed connection';
  const scope = useApp.getState().connections[sessionId]?.scope;
  return scope ? `${name} · ${scope.name}` : name;
}

/** Call when an API error happens on a live connection: network errors flag the connection as lost. */
export function noteError(profileId: string, e: ErrorInfo): void {
  if (e.category === 'network' || e.code === 'NOT_CONNECTED') useApp.getState().markLost(profileId);
}
