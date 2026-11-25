import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readTableGroupFile, saveTableGroupFile } from '../src/main/table-group-files';

const mocks = vi.hoisted(() => ({
  save: vi.fn(), open: vi.fn(), invoke: vi.fn(), expose: vi.fn(),
}));
vi.mock('electron', () => ({
  BrowserWindow: { getFocusedWindow: () => ({}), getAllWindows: () => [] },
  dialog: { showSaveDialog: mocks.save, showOpenDialog: mocks.open },
  contextBridge: { exposeInMainWorld: mocks.expose },
  ipcRenderer: { invoke: mocks.invoke, on: vi.fn(), removeListener: vi.fn(), send: vi.fn() },
}));

const text = JSON.stringify({
  format: 'earthql-table-groups', version: 1,
  groups: [{ name: 'Sales', color: '#123abc', collapsed: true, members: ['orders', 'summary'] }],
});
let directory: string;
let filename: string;

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'earthql-group-files-'));
  filename = path.join(directory, 'groups.json');
  for (const mock of Object.values(mocks)) mock.mockReset();
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await fs.rm(directory, { recursive: true, force: true });
});

describe('group file dialogs', () => {
  it('writes and reads the exact validated JSON selected through native dialogs', async () => {
    mocks.save.mockResolvedValue({ canceled: false, filePath: filename });
    expect(await saveTableGroupFile(text)).toEqual({ status: 'ok', path: filename });
    expect(await fs.readFile(filename, 'utf8')).toBe(text);
    mocks.open.mockResolvedValue({ canceled: false, filePaths: [filename] });
    expect(await readTableGroupFile()).toBe(text);
  });

  it('cancels without writing files and rejects invalid data before showing a save dialog', async () => {
    mocks.save.mockResolvedValue({ canceled: true });
    mocks.open.mockResolvedValue({ canceled: true, filePaths: [] });
    expect(await saveTableGroupFile(text)).toEqual({ status: 'dialog-cancelled' });
    expect(await readTableGroupFile()).toBeNull();
    expect(await fs.readdir(directory)).toEqual([]);
    mocks.save.mockClear();
    await expect(saveTableGroupFile('{}')).rejects.toThrow('unsupported');
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it('accepts exactly 1 MiB and rejects one byte more, malformed JSON and invalid UTF-8', async () => {
    const full = text + ' '.repeat(1024 * 1024 - Buffer.byteLength(text, 'utf8'));
    mocks.open.mockResolvedValue({ canceled: false, filePaths: [filename] });
    await fs.writeFile(filename, full);
    expect(await readTableGroupFile()).toBe(full);
    await fs.writeFile(filename, full + ' ');
    await expect(readTableGroupFile()).rejects.toThrow('1 MiB');
    await fs.writeFile(filename, '{');
    await expect(readTableGroupFile()).rejects.toThrow();
    await fs.writeFile(filename, Buffer.from([0xff]));
    await expect(readTableGroupFile()).rejects.toThrow();
  });

  it('surfaces file read failures', async () => {
    mocks.open.mockResolvedValue({ canceled: false, filePaths: [filename] });
    await expect(readTableGroupFile()).rejects.toThrow('ENOENT');
  });

  it('routes renderer group file methods through the real preload allowlist', async () => {
    vi.resetModules();
    await import('../src/preload/index');
    const bridge = mocks.expose.mock.calls[0][1];
    vi.stubGlobal('window', { earthqlBridge: bridge });
    const { api } = await import('../src/renderer/src/api');
    mocks.invoke.mockResolvedValueOnce({ ok: true, value: text });
    expect(await api.groupFiles.read()).toBe(text);
    mocks.invoke.mockResolvedValueOnce({ ok: true, value: { status: 'ok', path: filename } });
    expect(await api.groupFiles.save(text)).toEqual({ status: 'ok', path: filename });
    expect(mocks.invoke.mock.calls).toEqual([['groupFiles:read'], ['groupFiles:save', text]]);
  });
});
