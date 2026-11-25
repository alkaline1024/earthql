import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  convert: vi.fn(() => ({ rows: [{}], skipped: 0, reviewTls: 0 })),
  saveDialog: vi.fn(async () => ({ canceled: true })),
}));
vi.mock('electron', () => ({ BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] }, dialog: { showSaveDialog: mocks.saveDialog } }));
vi.mock('../src/main/store', () => ({ loadProfiles: mocks.load, saveProfiles: vi.fn() }));
vi.mock('../src/main/keychain', () => ({ saveImportedPassword: vi.fn() }));
vi.mock('../src/main/tableplus-connections', () => ({ exportTablePlusProfiles: mocks.convert, importTablePlusProfiles: vi.fn() }));
import { exportConnections } from '../src/main/connection-transfer';

describe('connection export selection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.load.mockReturnValue(['a', 'b', 'c'].map((id) => ({ id })));
  });
  it('exports only selected connections, with duplicates and stale IDs ignored', async () => {
    await exportConnections(['c', 'a', 'a', 'missing'], 'file-password');
    expect(mocks.convert).toHaveBeenCalledWith([{ id: 'a' }, { id: 'c' }]);
  });
  it('keeps all-connections and single-connection exports working', async () => {
    await exportConnections(null, 'file-password');
    expect(mocks.convert).toHaveBeenLastCalledWith([{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    await exportConnections('b', 'file-password');
    expect(mocks.convert).toHaveBeenLastCalledWith([{ id: 'b' }]);
  });
  it('does not turn an empty selection into an all-connections export', async () => {
    await exportConnections([], 'file-password');
    expect(mocks.convert).toHaveBeenCalledWith([]);
  });
});
