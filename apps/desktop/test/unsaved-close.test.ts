import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const confirmDiscard = vi.fn();
let useApp: typeof import('../src/renderer/src/store').useApp;
beforeAll(async () => {
  vi.stubGlobal('window', { earthqlBridge: { platform: 'darwin', confirmDiscard } });
  ({ useApp } = await import('../src/renderer/src/store'));
});
beforeEach(() => {
  confirmDiscard.mockReset();
  useApp.setState({ discardPrompt: null });
  useApp.setState({
    tabs: [{ id: 'table', kind: 'table', profileId: 'connection', object: { name: 'items' }, objectKind: 'table' }],
    activeTabId: 'table', gridDrafts: {}, toasts: [],
  });
});

describe('closing tabs with unsaved cell edits', () => {
  it('closes a clean tab without asking', () => {
    useApp.getState().closeTab('table');
    expect(confirmDiscard).not.toHaveBeenCalled();
    expect(useApp.getState().tabs).toHaveLength(0);
  });
  it('preserves the tab and draft when Cancel is selected', async () => {
    useApp.setState({ gridDrafts: { table: { rows: {} } } });
    const closing = useApp.getState().closeTabs(['table']);
    expect(useApp.getState().discardPrompt).not.toBeNull();
    useApp.getState().resolveDiscard(false);
    await closing;
    expect(useApp.getState().tabs).toHaveLength(1);
    expect(useApp.getState().gridDrafts.table).toBeDefined();
  });
  it('removes the tab and draft when Discard is selected', async () => {
    useApp.setState({ gridDrafts: { table: { rows: {} } } });
    const closing = useApp.getState().closeTabs(['table']);
    useApp.getState().resolveDiscard(true);
    await closing;
    expect(useApp.getState().tabs).toHaveLength(0);
    expect(useApp.getState().gridDrafts).toEqual({});
  });
  it('blocks closing while a save is in progress', () => {
    useApp.setState({ gridDrafts: { table: { rows: {}, saving: true } } });
    useApp.getState().closeTab('table');
    expect(confirmDiscard).not.toHaveBeenCalled();
    expect(useApp.getState().tabs).toHaveLength(1);
  });
});
