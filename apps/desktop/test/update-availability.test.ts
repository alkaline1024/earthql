import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  send: vi.fn(),
  message: vi.fn(async () => ({ response: 1 })),
  manifest: vi.fn(async () => ({})),
  newer: vi.fn(() => true),
  download: vi.fn(),
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
  readUpdateRelease: () => ({ version: '0.1.2', file: 'EarthQL-0.1.2-arm64-mac.zip' }),
  isNewerVersion: mocks.newer,
  downloadUpdate: mocks.download,
}));
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:fs/promises')>(),
  realpath: vi.fn(async (file: string) => file),
  mkdtemp: vi.fn(async () => '/tmp/earthql-test-stage'),
  rm: vi.fn(async () => {}),
}));
import { createUpdateCheck } from '../src/main/updates';

describe('update availability', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.handlers.clear();
    mocks.manifest.mockResolvedValue({});
    mocks.newer.mockReturnValue(true);
    mocks.message.mockResolvedValue({ response: 1 });
    vi.stubGlobal('__EARTHQL_UPDATE_PUBLIC_KEY__', 'test-key');
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    vi.spyOn(process, 'arch', 'get').mockReturnValue('arm64');
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  it('silently discovers a release and starts the existing installer from IPC', async () => {
    createUpdateCheck(async () => {}, () => {});
    await vi.waitFor(() => expect(mocks.send).toHaveBeenCalledWith('updates:status', { available: true, busy: false, downloadPercent: null }));
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
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mocks.manifest.mockRejectedValue(new Error('offline'));
    createUpdateCheck(async () => {}, () => {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mocks.handlers.get('updates:status')!().value).toEqual({ available: false, busy: false, downloadPercent: null });
    expect(mocks.message).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalled();
  });
  it('checks at startup and every 30 minutes without showing a dialog', async () => {
    vi.useFakeTimers();
    mocks.newer.mockReturnValue(false);
    createUpdateCheck(async () => {}, () => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.manifest).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000 - 1);
    expect(mocks.manifest).toHaveBeenCalledTimes(1);
    mocks.newer.mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.manifest).toHaveBeenCalledTimes(2);
    expect(mocks.handlers.get('updates:status')!().value.available).toBe(true);
    expect(mocks.message).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(mocks.manifest).toHaveBeenCalledTimes(3);
    expect(mocks.message).not.toHaveBeenCalled();
  });
  it('does not overlap automatic checks or interrupt a manual update', async () => {
    vi.useFakeTimers();
    let resolveBackground!: (value: object) => void;
    mocks.manifest.mockReturnValueOnce(new Promise((resolve) => { resolveBackground = resolve; }));
    let resolveDialog!: (value: { response: number }) => void;
    mocks.message.mockReturnValueOnce(new Promise((resolve) => { resolveDialog = resolve; }));
    const check = createUpdateCheck(async () => {}, () => {})!;
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(mocks.manifest).toHaveBeenCalledTimes(1);
    resolveBackground({});
    await vi.advanceTimersByTimeAsync(0);
    check();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.message).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(mocks.manifest).toHaveBeenCalledTimes(2);
    resolveDialog({ response: 1 });
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    expect(mocks.manifest).toHaveBeenCalledTimes(3);
    expect(mocks.message).toHaveBeenCalledTimes(1);
  });
  it('does not let a stale background check overwrite a manual check', async () => {
    let resolveBackground!: (value: object) => void;
    mocks.manifest.mockReturnValueOnce(new Promise((resolve) => { resolveBackground = resolve; }));
    const check = createUpdateCheck(async () => {}, () => {})!;
    check();
    await vi.waitFor(() => expect(mocks.handlers.get('updates:status')!().value).toEqual({ available: true, busy: false, downloadPercent: null }));
    mocks.newer.mockReturnValueOnce(false);
    resolveBackground({});
    await vi.waitFor(() => expect(mocks.newer).toHaveBeenCalledTimes(2));
    expect(mocks.handlers.get('updates:status')!().value.available).toBe(true);
  });
  it('publishes download percentages and clears them after a failure', async () => {
    const resourcesPath = Object.getOwnPropertyDescriptor(process, 'resourcesPath');
    Object.defineProperty(process, 'resourcesPath', { configurable: true, value: '/Applications/EarthQL.app/Contents/Resources' });
    mocks.message.mockResolvedValueOnce({ response: 0 });
    mocks.download.mockImplementationOnce(async (_release, _file, progress: (fraction: number) => void) => {
      progress(0.257);
      progress(1);
      throw new Error('download failed');
    });
    try {
      createUpdateCheck(async () => {}, () => {});
      await vi.waitFor(() => expect(mocks.handlers.get('updates:status')!().value.available).toBe(true));
      mocks.handlers.get('updates:install')!();
      await vi.waitFor(() => expect(mocks.send).toHaveBeenCalledWith('updates:status', { available: true, busy: true, downloadPercent: 100 }));
      expect(mocks.send).toHaveBeenCalledWith('updates:status', { available: true, busy: true, downloadPercent: 0 });
      expect(mocks.send).toHaveBeenCalledWith('updates:status', { available: true, busy: true, downloadPercent: 25 });
      await vi.waitFor(() => expect(mocks.handlers.get('updates:status')!().value).toEqual({ available: true, busy: false, downloadPercent: null }));
      expect(mocks.message).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ type: 'error' }));
    } finally {
      if (resourcesPath) Object.defineProperty(process, 'resourcesPath', resourcesPath);
      else Reflect.deleteProperty(process, 'resourcesPath');
    }
  });
});
