import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

let useApp: typeof import('../src/renderer/src/store').useApp;
beforeAll(async () => {
  vi.stubGlobal('window', { earthqlBridge: { platform: 'darwin' } });
  ({ useApp } = await import('../src/renderer/src/store'));
});
beforeEach(() => {
  useApp.setState({
    tabs: [
      { id: 't1', kind: 'sql', profileId: 'conn', title: 'Query 1', initialSql: '', context: {} },
      { id: 't2', kind: 'sql', profileId: 'conn', title: 'Query 2', initialSql: '', context: {} },
      { id: 't3', kind: 'sql', profileId: 'conn', title: 'Query 3', initialSql: '', context: {} },
    ],
    activeTabId: 't1',
    tabGroups: [],
    gridDrafts: {},
    toasts: [],
  });
});

function ids() {
  return useApp.getState().tabs.map((t) => t.id);
}

describe('tab reordering', () => {
  it('moves a tab next to another tab', () => {
    useApp.getState().moveTab('t1', 't3', true);
    expect(ids()).toEqual(['t2', 't3', 't1']);
  });
});

describe('tab groups', () => {
  it('creates a group from one tab and keeps later additions adjacent to it', () => {
    const groupId = useApp.getState().createTabGroup('Group A', ['t1'], '#e5484d');
    expect(ids()).toEqual(['t1', 't2', 't3']);
    expect(useApp.getState().tabGroups.find((g) => g.id === groupId)?.tabIds).toEqual(['t1']);

    useApp.getState().moveTabsToGroup(['t3'], groupId);
    expect(ids()).toEqual(['t1', 't3', 't2']);
    expect(useApp.getState().tabGroups.find((g) => g.id === groupId)?.tabIds).toEqual(['t1', 't3']);
  });

  it('strips a closed tab from its group and drops the group once empty', async () => {
    const groupId = useApp.getState().createTabGroup('Group A', ['t1'], '#e5484d');
    useApp.getState().moveTabsToGroup(['t3'], groupId);

    await useApp.getState().closeTabs(['t1']);
    expect(useApp.getState().tabGroups.find((g) => g.id === groupId)?.tabIds).toEqual(['t3']);

    await useApp.getState().closeTabs(['t3']);
    expect(useApp.getState().tabGroups.find((g) => g.id === groupId)).toBeUndefined();
  });

  it('expands a collapsed group when one of its tabs is activated', () => {
    const groupId = useApp.getState().createTabGroup('Group A', ['t2'], '#e5484d');
    useApp.getState().toggleTabGroupCollapsed(groupId);
    expect(useApp.getState().tabGroups.find((g) => g.id === groupId)?.collapsed).toBe(true);

    useApp.getState().activateTab('t2');
    expect(useApp.getState().tabGroups.find((g) => g.id === groupId)?.collapsed).toBe(false);
  });
});
