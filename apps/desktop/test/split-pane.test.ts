import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

let useApp: typeof import('../src/renderer/src/store').useApp;
beforeAll(async () => {
  vi.stubGlobal('window', { earthqlBridge: { platform: 'darwin' } });
  ({ useApp } = await import('../src/renderer/src/store'));
});
beforeEach(() => {
  useApp.setState({
    tabs: [
      { id: 'a', kind: 'sql', profileId: 'p1', title: 'A', initialSql: '', context: {} },
      { id: 'b', kind: 'sql', profileId: 'p1', title: 'B', initialSql: '', context: {} },
    ],
    activeTabId: 'a',
    activeProfileId: 'p1',
    splitPane: null,
    tabGroups: [],
    gridDrafts: {},
    toasts: [],
  });
});

describe('split pane', () => {
  it('pins a tab to a side without touching the active tab', () => {
    useApp.getState().openSplit('b', 'right');
    expect(useApp.getState().splitPane).toEqual({ tabId: 'b', side: 'right' });
    expect(useApp.getState().activeTabId).toBe('a');
  });

  it('toggles off when opening the same tab on the same side again', () => {
    useApp.getState().openSplit('b', 'right');
    useApp.getState().openSplit('b', 'right');
    expect(useApp.getState().splitPane).toBeNull();
  });

  it('replaces an existing split rather than keeping two at once', () => {
    useApp.getState().openSplit('b', 'right');
    useApp.getState().openSplit('a', 'left');
    expect(useApp.getState().splitPane).toEqual({ tabId: 'a', side: 'left' });
  });

  it('closeSplit clears it', () => {
    useApp.getState().openSplit('b', 'right');
    useApp.getState().closeSplit();
    expect(useApp.getState().splitPane).toBeNull();
  });

  it('clears the split when its tab is closed', async () => {
    useApp.getState().openSplit('b', 'right');
    await useApp.getState().closeTabs(['b']);
    expect(useApp.getState().splitPane).toBeNull();
  });

  it('leaves the split alone when a different tab is closed', async () => {
    useApp.getState().openSplit('b', 'right');
    useApp.setState({ tabs: [...useApp.getState().tabs, { id: 'c', kind: 'sql', profileId: 'p1', title: 'C', initialSql: '', context: {} }] });
    await useApp.getState().closeTabs(['c']);
    expect(useApp.getState().splitPane).toEqual({ tabId: 'b', side: 'right' });
  });
});
