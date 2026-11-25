import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

let useApp: typeof import('../src/renderer/src/store').useApp;
beforeAll(async () => {
  vi.stubGlobal('window', { earthqlBridge: { platform: 'darwin' } });
  ({ useApp } = await import('../src/renderer/src/store'));
});
beforeEach(() => {
  useApp.setState({
    tabs: ['a', 'b', 'c'].map((id) => ({ id, kind: 'sql' as const, profileId: 'p1', title: id, initialSql: `select '${id}'`, context: {} })),
    activeTabId: 'a', activeProfileId: 'p1', splitPane: null, focusedPane: 'main',
    tabGroups: [], gridDrafts: {}, toasts: [], closedTabs: [],
  });
});

describe('independent split panels', () => {
  it.each(['left', 'right', 'up', 'down'] as const)('moves a tab to the %s panel without duplicating it', (side) => {
    useApp.getState().openSplit('a', side);
    const s = useApp.getState();
    expect(s.splitPane).toEqual({ tabId: 'a', tabIds: ['a'], mainTabId: 'c', side });
    expect(s.tabs.map((t) => t.id)).toEqual(['a', 'b', 'c']);
    expect(s.activeTabId).toBe('a');
    expect(s.focusedPane).toBe('split');
  });

  it('keeps independent active tabs while focus moves between panels', () => {
    useApp.getState().openSplit('b', 'right');
    useApp.getState().activateTab('c');
    expect(useApp.getState().splitPane?.tabId).toBe('b');
    expect(useApp.getState().splitPane?.mainTabId).toBe('c');
    useApp.getState().focusPane('split');
    expect(useApp.getState().activeTabId).toBe('b');
    useApp.getState().focusPane('main');
    expect(useApp.getState().activeTabId).toBe('c');
  });

  it('adds new tabs to the focused panel', () => {
    useApp.getState().openSplit('b', 'down');
    const splitId = useApp.getState().newSqlTab('p1', 'select 1');
    expect(useApp.getState().splitPane?.tabIds).toEqual(['b', splitId]);
    useApp.getState().focusPane('main');
    const mainId = useApp.getState().newSqlTab('p1', 'select 2');
    expect(useApp.getState().splitPane?.tabIds).not.toContain(mainId);
    expect(useApp.getState().splitPane?.mainTabId).toBe(mainId);
    expect(useApp.getState().splitPane?.tabId).toBe(splitId);
  });

  it('moves more tabs into the existing panel and can change its direction', () => {
    useApp.getState().openSplit('b', 'right');
    useApp.getState().openSplit('c', 'up');
    expect(useApp.getState().splitPane).toEqual({ tabId: 'c', tabIds: ['b', 'c'], mainTabId: 'a', side: 'up' });
    useApp.getState().openSplit('c', 'up');
    expect(useApp.getState().splitPane?.tabIds).toEqual(['b', 'c']);
  });

  it('supports moving tabs back to the main panel', () => {
    useApp.getState().openSplit('b', 'left');
    useApp.getState().openSplit('c', 'left');
    useApp.getState().moveTabToPane('c', 'main');
    expect(useApp.getState().splitPane).toEqual({ tabId: 'b', tabIds: ['b'], mainTabId: 'c', side: 'left' });
    expect(useApp.getState().focusedPane).toBe('main');
    useApp.getState().moveTabToPane('b', 'main');
    expect(useApp.getState().splitPane).toBeNull();
    expect(useApp.getState().activeTabId).toBe('b');
  });

  it('selects another tab in the same panel when its active tab closes', async () => {
    useApp.getState().openSplit('b', 'right');
    useApp.getState().openSplit('c', 'right');
    await useApp.getState().closeTabs(['c']);
    expect(useApp.getState().splitPane).toEqual({ tabId: 'b', tabIds: ['b'], mainTabId: 'a', side: 'right' });
    expect(useApp.getState().activeTabId).toBe('b');
  });

  it('keeps the other panel selection when a background tab closes', async () => {
    useApp.getState().openSplit('b', 'right');
    useApp.getState().activateTab('a');
    await useApp.getState().closeTabs(['c']);
    expect(useApp.getState().activeTabId).toBe('a');
    expect(useApp.getState().splitPane?.tabId).toBe('b');
  });

  it('collapses the split when its last tab closes', async () => {
    useApp.getState().openSplit('b', 'right');
    await useApp.getState().closeTabs(['b']);
    expect(useApp.getState().splitPane).toBeNull();
    expect(useApp.getState().focusedPane).toBe('main');
    expect(useApp.getState().tabs.map((t) => t.id)).toEqual(['a', 'c']);
  });

  it('allows an empty main panel and opens new tabs there', () => {
    useApp.setState({ tabs: [useApp.getState().tabs[0]] });
    useApp.getState().openSplit('a', 'down');
    expect(useApp.getState().splitPane?.mainTabId).toBeNull();
    useApp.getState().focusPane('main');
    expect(useApp.getState().activeTabId).toBeNull();
    const id = useApp.getState().newSqlTab('p1');
    expect(useApp.getState().splitPane?.mainTabId).toBe(id);
    expect(useApp.getState().splitPane?.tabIds).toEqual(['a']);
  });

  it('merges panels without closing tabs', () => {
    useApp.getState().openSplit('b', 'right');
    useApp.getState().closeSplit();
    expect(useApp.getState().splitPane).toBeNull();
    expect(useApp.getState().tabs).toHaveLength(3);
    expect(useApp.getState().activeTabId).toBe('b');
  });

  it('reopens a closed query into the focused panel with its SQL preserved', async () => {
    await useApp.getState().closeTabs(['c']);
    useApp.getState().openSplit('b', 'right');
    useApp.getState().reopenClosedTab();
    const s = useApp.getState();
    expect(s.splitPane?.tabIds).toContain(s.activeTabId);
    expect(s.tabs.find((tab) => tab.id === s.activeTabId)).toMatchObject({ initialSql: "select 'c'" });
  });

  it('ignores split requests for missing tabs', () => {
    useApp.getState().openSplit('missing', 'right');
    expect(useApp.getState().splitPane).toBeNull();
  });
});
