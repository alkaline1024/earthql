import { create } from 'zustand';
import type { Capabilities, ErrorInfo, ExecContext, GridRowUpdate, ObjectKind, ObjectPath } from '@earthql/core';
import type { ProfileSummary } from '../../shared/api';
import { api, errorInfo, uid } from './api';

export interface LiveConnection {
  profileId: string;
  capabilities: Capabilities;
  defaultContext: ExecContext;
  /** 'lost' after a network error; the user can reconnect. */
  status: 'connected' | 'lost';
}

export type Tab =
  | { id: string; kind: 'table'; profileId: string; object: ObjectPath; objectKind: ObjectKind; initialView?: 'data' | 'structure' }
  | { id: string; kind: 'sql'; profileId: string; title: string; initialSql: string; context: ExecContext }
  | { id: string; kind: 'create'; profileId: string; container: Partial<ObjectPath> };

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

  loadProfiles(): Promise<void>;
  connect(profileId: string): Promise<boolean>;
  disconnect(profileId: string): Promise<void>;
  markLost(profileId: string): void;
  setScreen(s: AppState['screen']): void;
  setActiveProfile(id: string): void;
  openTab(tab: NewTab): string;
  closeTab(id: string): void;
  activateTab(id: string): void;
  setGridDraft(id: string, draft: GridDraft | undefined): void;
  newSqlTab(profileId: string, sql?: string, context?: ExecContext, title?: string): string;
  refreshTree(profileId: string, container: Partial<ObjectPath>): void;
  toast(kind: Toast['kind'], text: string): void;
}

export const containerKey = (profileId: string, p: Partial<ObjectPath>) =>
  `${profileId}|${p.catalog ?? ''}|${p.database ?? ''}|${p.schema ?? ''}`;

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

  async loadProfiles() {
    const profiles = await api.profiles.list();
    set({ profiles });
  },

  async connect(profileId) {
    set((s) => ({ connecting: { ...s.connecting, [profileId]: true }, connectErrors: { ...s.connectErrors, [profileId]: undefined } }));
    try {
      const c = await api.connection.open(profileId);
      set((s) => ({
        connections: { ...s.connections, [profileId]: { ...c, status: 'connected' } },
        activeProfileId: profileId,
        screen: 'workspace',
        treeRefresh: { ...s.treeRefresh, [containerKey(profileId, {})]: (s.treeRefresh[containerKey(profileId, {})] ?? 0) + 1 },
      }));
      return true;
    } catch (e) {
      set((s) => ({ connectErrors: { ...s.connectErrors, [profileId]: errorInfo(e) } }));
      return false;
    } finally {
      set((s) => ({ connecting: { ...s.connecting, [profileId]: false } }));
    }
  },

  async disconnect(profileId) {
    const current = get();
    const drafts = current.tabs.filter((t) => t.profileId === profileId).map((t) => current.gridDrafts[t.id]).filter(Boolean);
    if (drafts.some((draft) => draft.saving)) return get().toast('info', 'Wait for the cell changes to finish saving.');
    if (drafts.length && !window.confirm('Disconnect and discard the unsaved cell changes for this connection?')) return;
    await api.connection.close(profileId).catch(() => undefined);
    set((s) => {
      const connections = { ...s.connections };
      delete connections[profileId];
      const tabs = s.tabs.filter((t) => t.profileId !== profileId);
      const remaining = Object.keys(connections);
      return {
        connections,
        tabs,
        gridDrafts: Object.fromEntries(tabs.flatMap(({ id }) => s.gridDrafts[id] ? [[id, s.gridDrafts[id]]] : [])),
        activeTabId: tabs.some((t) => t.id === s.activeTabId) ? s.activeTabId : (tabs[tabs.length - 1]?.id ?? null),
        activeProfileId: s.activeProfileId === profileId ? (remaining[0] ?? null) : s.activeProfileId,
        screen: remaining.length ? s.screen : 'connections',
      };
    });
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
        set({ activeTabId: existing.id });
        return existing.id;
      }
    }
    const id = tab.id ?? uid();
    set({ tabs: [...s.tabs, { ...tab, id } as Tab], activeTabId: id, activeProfileId: tab.profileId, screen: 'workspace' });
    return id;
  },

  closeTab(id) {
    const draft = get().gridDrafts[id];
    if (draft?.saving) return get().toast('info', 'Wait for the cell changes to finish saving.');
    if (draft && !window.confirm('Discard the unsaved cell changes in this tab?')) return;
    set((s) => {
      const idx = s.tabs.findIndex((t) => t.id === id);
      const tabs = s.tabs.filter((t) => t.id !== id);
      let activeTabId = s.activeTabId;
      if (s.activeTabId === id) activeTabId = tabs[Math.min(idx, tabs.length - 1)]?.id ?? null;
      const { [id]: _draft, ...gridDrafts } = s.gridDrafts;
      return { tabs, activeTabId, gridDrafts };
    });
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
  return useApp.getState().profiles.find((p) => p.profile.id === profileId);
}

/** Call when an API error happens on a live connection: network errors flag the connection as lost. */
export function noteError(profileId: string, e: ErrorInfo): void {
  if (e.category === 'network' || e.code === 'NOT_CONNECTED') useApp.getState().markLost(profileId);
}
