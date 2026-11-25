import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

let useApp: typeof import('../src/renderer/src/store').useApp;
beforeAll(async () => {
  vi.stubGlobal('window', { earthqlBridge: { platform: 'darwin' } });
  ({ useApp } = await import('../src/renderer/src/store'));
});
beforeEach(() => {
  useApp.setState({
    tabs: [
      { id: 'a1', kind: 'sql', profileId: 'p1', title: 'A1', initialSql: '', context: {} },
      { id: 'b1', kind: 'sql', profileId: 'p2', title: 'B1', initialSql: '', context: {} },
      { id: 'a2', kind: 'sql', profileId: 'p1', title: 'A2', initialSql: '', context: {} },
      { id: 'b2', kind: 'sql', profileId: 'p2', title: 'B2', initialSql: '', context: {} },
    ],
    activeTabId: 'a2',
    activeProfileId: 'p1',
    tabGroups: [],
    gridDrafts: {},
    toasts: [],
  });
});

describe('closing a tab never switches the active connection on its own', () => {
  it('leaves activeProfileId untouched when the closed tab was not active', async () => {
    await useApp.getState().closeTabs(['b1']);
    expect(useApp.getState().activeTabId).toBe('a2');
    expect(useApp.getState().activeProfileId).toBe('p1');
  });

  it('picks another tab on the same connection when closing the active tab, even if it is not the nearest tab', async () => {
    // a2 (p1) is active; the nearest remaining tab by position is b2 (p2), but a1 (p1) keeps the connection.
    await useApp.getState().closeTabs(['a2']);
    expect(useApp.getState().activeTabId).toBe('a1');
    expect(useApp.getState().activeProfileId).toBe('p1');
  });

  it('falls back to a different connection only once no tab remains for the old one', async () => {
    await useApp.getState().closeTabs(['a1', 'a2']);
    expect(useApp.getState().activeProfileId).toBe('p2');
  });

  it('still switches the connection on an explicit activateTab call', () => {
    useApp.getState().activateTab('b1');
    expect(useApp.getState().activeTabId).toBe('b1');
    expect(useApp.getState().activeProfileId).toBe('p2');
  });
});
