import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../src/renderer/src/api', () => ({ api: {}, errorInfo: vi.fn(), uid: () => crypto.randomUUID() }));
import { useApp } from '../src/renderer/src/store';

const open = (name: string) => useApp.getState().openTab({ kind: 'table', profileId: 'local', object: { name }, objectKind: 'table' });
describe('preview tabs', () => {
  beforeEach(() => useApp.setState({ tabs: [], gridDrafts: {}, unsavedStructureTabs: {}, tabGroups: [], splitPane: null, focusedPane: 'main', activeTabId: null, closedTabs: [] }));
  it('replaces an untouched preview with a fresh tab in the same slot', () => {
    const first = open('users');
    const next = open('orders');
    expect(next).not.toBe(first);
    expect(useApp.getState().tabs).toMatchObject([{ id: next, preview: true }]);
    expect(useApp.getState().closedTabs).toEqual([]);
  });
  it('keeps used tabs, even after their draft is cleared', () => {
    const first = open('users');
    useApp.getState().setGridDraft(first, { rows: {} });
    useApp.getState().setGridDraft(first, undefined);
    open('orders');
    expect(useApp.getState().tabs).toHaveLength(2);
    expect(useApp.getState().tabs[0].preview).toBe(false);
  });
  it('keeps an untouched tab when explicitly saved or kept', () => {
    const first = open('users');
    useApp.getState().keepTab(first);
    open('orders');
    expect(useApp.getState().tabs).toHaveLength(2);
    expect(useApp.getState().tabs[0]).toMatchObject({ id: first, preview: false });
  });
  it('always adds New Query and never replaces it', () => {
    const first = open('users');
    const query = useApp.getState().newSqlTab('local');
    const next = open('orders');
    expect(useApp.getState().tabs.map((t) => t.id)).toEqual([next, query]);
    expect(useApp.getState().tabs.find((t) => t.id === first)).toBeUndefined();
    useApp.getState().newSqlTab('local');
    expect(useApp.getState().tabs).toHaveLength(3);
  });
  it('keeps previews in the other split pane', () => {
    const main = open('users');
    useApp.setState({ splitPane: { tabId: main, tabIds: [], mainTabId: main, side: 'right' }, focusedPane: 'split' });
    const split = open('orders');
    const next = open('products');
    expect(useApp.getState().tabs.map((t) => t.id)).toEqual([main, next]);
    expect(useApp.getState().splitPane?.tabIds).toEqual([next]);
    expect(useApp.getState().tabs.some((t) => t.id === split)).toBe(false);
  });
});
