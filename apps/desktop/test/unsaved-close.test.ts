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
  it('preserves staged inserts when cancelling close and removes them only after Discard', async () => {
    const inserted = { rows: {}, inserts: [{ id: 'new', values: { name: { kind: 'value' as const, value: 'pending' } } }] };
    useApp.setState({ gridDrafts: { table: inserted } });
    const cancelled = useApp.getState().closeTabs(['table']);
    useApp.getState().resolveDiscard(false);
    await cancelled;
    expect(useApp.getState().gridDrafts.table).toEqual(inserted);
    const discarded = useApp.getState().closeTabs(['table']);
    useApp.getState().resolveDiscard(true);
    await discarded;
    expect(useApp.getState().gridDrafts).toEqual({});
  });
  it('preserves staged deletions on Cancel and clears them on Discard', async () => {
    const deleted = { rows: {}, deletes: { one: { key: [{ column: 'id', value: '1' }] } } };
    useApp.setState({ gridDrafts: { table: deleted } });
    const closing = useApp.getState().closeTabs(['table']);
    useApp.getState().resolveDiscard(false);
    await closing;
    expect(useApp.getState().gridDrafts.table).toEqual(deleted);
    const discarded = useApp.getState().closeTabs(['table']);
    useApp.getState().resolveDiscard(true);
    await discarded;
    expect(useApp.getState().gridDrafts).toEqual({});
  });
});
