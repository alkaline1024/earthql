import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../src/renderer/src/api', () => ({ api: {}, errorInfo: vi.fn(), uid: () => 'new-tab' }));
import { useApp, type NewTab } from '../src/renderer/src/store';

const table: NewTab = { kind: 'table', profileId: 'local', object: { database: 'demo', name: 'users' }, objectKind: 'table', initialView: 'data' };
const view = () => { const tab = useApp.getState().tabs[0]; return tab.kind === 'table' ? tab.initialView : undefined; };

describe('opening an existing table in Data or Structure', () => {
  beforeEach(() => useApp.setState({ tabs: [], gridDrafts: {}, activeTabId: null, activeProfileId: null, screen: 'workspace' }));
  it('reuses the tab and applies the requested view in both directions', () => {
    const id = useApp.getState().openTab(table);
    expect(useApp.getState().openTab({ ...table, initialView: 'structure' })).toBe(id);
    expect(view()).toBe('structure');
    useApp.getState().openTab({ ...table, initialView: 'data' });
    expect(view()).toBe('data');
    expect(useApp.getState().tabs).toHaveLength(1);
  });
  it('honors a repeated Structure request after switching manually to Data', () => {
    const id = useApp.getState().openTab({ ...table, initialView: 'structure' });
    useApp.getState().setTableView(id, 'data');
    expect(view()).toBe('data');
    useApp.getState().openTab({ ...table, initialView: 'structure' });
    expect(view()).toBe('structure');
  });
  it('activates the correct connection and preserves unsaved changes', () => {
    const id = useApp.getState().openTab(table);
    const draft = { rows: { one: { key: [], changes: [{ column: 'name', value: 'Edited' }] } } };
    useApp.getState().setGridDraft(id, draft);
    useApp.setState({ activeProfileId: 'other', screen: 'connections' });
    useApp.getState().openTab({ ...table, initialView: 'structure' });
    expect(useApp.getState().activeProfileId).toBe('local');
    expect(useApp.getState().screen).toBe('workspace');
    expect(useApp.getState().gridDrafts[id]).toBe(draft);
  });
});
