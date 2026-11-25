import { create } from 'zustand';
import type { ErrorInfo, ExecContext, GridRowUpdate, ObjectKind, ObjectPath } from '@earthql/core';
import type { OpenConnection, ProfileSummary } from '../../shared/api';
import { api, errorInfo, uid } from './api';

export interface LiveConnection extends OpenConnection {
  /** 'lost' after a network error; the user can reconnect. */
  status: 'connected' | 'lost';
}

export type Tab = { customTitle?: string; refreshVersion?: number } & (
  | { id: string; kind: 'table'; profileId: string; object: ObjectPath; objectKind: ObjectKind; initialView?: 'data' | 'structure' }
  | { id: string; kind: 'sql'; profileId: string; title: string; initialSql: string; context: ExecContext }
  | { id: string; kind: 'create'; profileId: string; container: Partial<ObjectPath> }
);

type DistributiveOmit<T, K extends keyof any> = T extends unknown ? Omit<T, K> : never;
export type NewTab = DistributiveOmit<Tab, 'id'> & { id?: string };

export interface Toast {
  id: string;
  kind: 'ok' | 'error' | 'info';
  text: string;
}

export interface GridDraft {
  rows: Record<string, GridRowUpdate>;
  saving?: boolean;
  error?: ErrorInfo;
}

interface AppState {
  profiles: ProfileSummary[];
  connections: Record<string, LiveConnection>;
  connecting: Record<string, boolean>;
  connectErrors: Record<string, ErrorInfo | undefined>;
  activeProfileId: string | null;
  screen: 'connections' | 'workspace';
  tabs: Tab[];
  activeTabId: string | null;
  gridDrafts: Record<string, GridDraft>;
  /** Bumped to make the sidebar reload a container node: key = profileId + path */
  treeRefresh: Record<string, number>;
  toasts: Toast[];
  sqlCounter: number;
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
  setScreen(s: AppState['screen']): void;
  setActiveProfile(id: string): void;
  openTab(tab: NewTab): string;
  setTableView(id: string, view: 'data' | 'structure'): void;
  closeTab(id: string): void;
  closeTabs(ids: string[], keepId?: string): void;
  renameTab(id: string, title: string): void;
  refreshTab(id: string): void;
  activateTab(id: string): void;
  setGridDraft(id: string, draft: GridDraft | undefined): void;
  newSqlTab(profileId: string, sql?: string, context?: ExecContext, title?: string): string;
  refreshTree(profileId: string, container: Partial<ObjectPath>): void;
  toast(kind: Toast['kind'], text: string): void;
}

export const containerKey = (profileId: string, p: Partial<ObjectPath>) =>
  `${profileId}|${p.catalog ?? ''}|${p.database ?? ''}|${p.schema ?? ''}`;

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

function disconnected(state: AppState, sessionIds: string[]): Partial<AppState> {
  const closing = new Set(sessionIds);
  const connections = Object.fromEntries(Object.entries(state.connections).filter(([id]) => !closing.has(id)));
  const remaining = Object.keys(connections);
  const tabs = state.tabs.filter((tab) => !closing.has(tab.profileId));
  const active = tabs.find((tab) => tab.id === state.activeTabId) ?? tabs.at(-1);
  return {
    connections,
    tabs,
    gridDrafts: Object.fromEntries(tabs.flatMap(({ id }) => state.gridDrafts[id] ? [[id, state.gridDrafts[id]]] : [])),
    treeRefresh: Object.fromEntries(Object.entries(state.treeRefresh).filter(([key]) => !closing.has(key.split('|', 1)[0]))),
    activeTabId: active?.id ?? null,
    activeProfileId: state.activeProfileId && !closing.has(state.activeProfileId) ? state.activeProfileId : (active?.profileId ?? remaining[0] ?? null),
    screen: remaining.length ? state.screen : 'connections',
  };
}

export const useApp = create<AppState>((set, get) => ({
  profiles: [],
  connections: {},
  connecting: {},
  connectErrors: {},
  activeProfileId: null,
  screen: 'connections',
  tabs: [],
  activeTabId: null,
  gridDrafts: {},
  treeRefresh: {},
  toasts: [],
  sqlCounter: 0,
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
    try {
      const connection = await (state.connections[profileId] ? api.connection.reconnect(profileId) : api.connection.open(profileId));
      set((s) => opened(s, profileId, connection));
      return true;
    } catch (e) {
      set((s) => ({ connectErrors: { ...s.connectErrors, [profileId]: errorInfo(e) } }));
      return false;
    } finally {
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
    // Re-use an existing table tab for the same object.
    if (tab.kind === 'table') {
      const existing = s.tabs.find(
        (t) => t.kind === 'table' && t.profileId === tab.profileId && JSON.stringify(t.object) === JSON.stringify(tab.object),
      );
      if (existing) {
        set({
          activeTabId: existing.id,
          activeProfileId: tab.profileId,
          screen: 'workspace',
          tabs: tab.initialView === undefined ? s.tabs : s.tabs.map((current) => current.id === existing.id ? { ...current, initialView: tab.initialView } as Tab : current),
        });
        return existing.id;
      }
    }
    const id = tab.id ?? uid();
    set({ tabs: [...s.tabs, { ...tab, id } as Tab], activeTabId: id, activeProfileId: tab.profileId, screen: 'workspace' });
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
    if (drafts.some((draft) => draft.saving)) return current.toast('info', 'Wait for the cell changes to finish saving.');
    if (drafts.length && !await current.confirmDiscard()) return;

    current = get();
    if (ids.some((id) => current.gridDrafts[id]?.saving)) return current.toast('info', 'Wait for the cell changes to finish saving.');
    tabs = current.tabs.filter((tab) => !closing.has(tab.id));
    const activeIndex = current.tabs.findIndex((tab) => tab.id === current.activeTabId);
    const active = tabs.find((tab) => tab.id === (keepId ?? current.activeTabId))
      ?? current.tabs.slice(Math.max(0, activeIndex)).find((tab) => !closing.has(tab.id))
      ?? tabs.at(-1);
    set({
      tabs,
      activeTabId: active?.id ?? null,
      ...(active && active.id !== current.activeTabId ? { activeProfileId: active.profileId } : {}),
      gridDrafts: Object.fromEntries(Object.entries(current.gridDrafts).filter(([id]) => !closing.has(id))),
    });
  },

  renameTab(id, title) {
    const customTitle = title.trim();
    if (!customTitle) return;
    set((s) => ({ tabs: s.tabs.map((tab) => tab.id === id ? { ...tab, customTitle } : tab) }));
  },

  refreshTab(id) {
    const current = get();
    if (current.gridDrafts[id]?.saving) return current.toast('info', 'Wait for the cell changes to finish saving.');
    set((s) => ({ tabs: s.tabs.map((tab) => tab.id === id ? { ...tab, refreshVersion: (tab.refreshVersion ?? 0) + 1 } : tab) }));
  },

  activateTab(id) {
    const t = get().tabs.find((x) => x.id === id);
    set({ activeTabId: id, ...(t ? { activeProfileId: t.profileId } : {}) });
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

  toast(kind, text) {
    const id = uid();
    set((s) => ({ toasts: [...s.toasts, { id, kind, text }] }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), kind === 'error' ? 7000 : 4000);
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
