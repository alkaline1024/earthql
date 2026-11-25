import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  send: vi.fn(),
  message: vi.fn(async () => ({ response: 1 })),
  manifest: vi.fn(async () => ({})),
  newer: vi.fn(() => true),
}));
vi.mock('electron', () => ({
  app: { isPackaged: true, getVersion: () => '0.1.1' },
  BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [{ webContents: { send: mocks.send }, setProgressBar: vi.fn() }] },
  dialog: { showMessageBox: mocks.message },
  ipcMain: { handle: (channel: string, handler: (...args: any[]) => any) => mocks.handlers.set(channel, handler) },
}));
vi.mock('../src/main/update-release', () => ({
  releaseKey: () => ({}),
  getUpdateManifest: mocks.manifest,
  readUpdateRelease: () => ({ version: '0.1.2' }),
  isNewerVersion: mocks.newer,
}));
import { createUpdateCheck } from '../src/main/updates';

describe('update availability', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.handlers.clear();
    mocks.manifest.mockResolvedValue({});
    mocks.newer.mockReturnValue(true);
    vi.stubGlobal('__EARTHQL_UPDATE_PUBLIC_KEY__', 'test-key');
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    vi.spyOn(process, 'arch', 'get').mockReturnValue('arm64');
  });
  it('silently discovers a release and starts the existing installer from IPC', async () => {
    createUpdateCheck(async () => {}, () => {});
    await vi.waitFor(() => expect(mocks.send).toHaveBeenCalledWith('updates:status', { available: true, busy: false }));
    expect(mocks.message).not.toHaveBeenCalled();
    expect(mocks.handlers.get('updates:status')!().value.available).toBe(true);
    mocks.handlers.get('updates:install')!();
    expect(mocks.handlers.get('updates:status')!().value.busy).toBe(true);
    await vi.waitFor(() => expect(mocks.message).toHaveBeenCalled());
    await vi.waitFor(() => expect(mocks.handlers.get('updates:status')!().value.busy).toBe(false));
  });
  it('keeps the action hidden when up to date', async () => {
    mocks.newer.mockReturnValue(false);
    createUpdateCheck(async () => {}, () => {});
    await vi.waitFor(() => expect(mocks.send).toHaveBeenCalled());
    expect(mocks.handlers.get('updates:status')!().value.available).toBe(false);
    mocks.handlers.get('updates:install')!();
    expect(mocks.message).not.toHaveBeenCalled();
  });
  it('does not show a dialog when background discovery fails', async () => {
    mocks.manifest.mockRejectedValue(new Error('offline'));
    createUpdateCheck(async () => {}, () => {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.handlers.get('updates:status')!().value).toEqual({ available: false, busy: false });
    expect(mocks.message).not.toHaveBeenCalled();
  });
});
