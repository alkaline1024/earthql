import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

let useApp: typeof import('../src/renderer/src/store').useApp;
const invoke = vi.fn(async () => ({ ok: true, value: undefined }));
const storage = new Map<string, string>();

beforeAll(async () => {
  vi.stubGlobal('window', { earthqlBridge: { platform: 'darwin', invoke } });
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
    removeItem: (k: string) => void storage.delete(k),
  });
  ({ useApp } = await import('../src/renderer/src/store'));
});

beforeEach(() => {
  invoke.mockClear();
  storage.clear();
  useApp.setState({ keybindings: {}, toasts: [] });
});

describe('keybinding store', () => {
  it('stores a new shortcut, persists it and pushes it to the native menu', () => {
    useApp.getState().setKeybinding('close-tab', 'cmd+alt+w');
    expect(useApp.getState().keybindings).toEqual({ 'close-tab': 'CmdOrCtrl+Alt+W' });
    expect(JSON.parse(storage.get('earthql.keybindings')!)).toEqual({ 'close-tab': 'CmdOrCtrl+Alt+W' });
    expect(invoke).toHaveBeenCalledWith('keybindings:apply', { overrides: { 'close-tab': 'CmdOrCtrl+Alt+W' }, suspended: false });
  });

  it('unbinds with null', () => {
    useApp.getState().setKeybinding('refresh', null);
    expect(useApp.getState().keybindings).toEqual({ refresh: null });
  });

  it('applies several changes at once, e.g. when taking over a shortcut', () => {
    useApp.getState().setKeybindings({ 'close-tab': null, 'new-sql-tab': 'CmdOrCtrl+W' });
    expect(useApp.getState().keybindings).toEqual({ 'close-tab': null, 'new-sql-tab': 'CmdOrCtrl+W' });
  });

  it('resets one shortcut, then all of them', () => {
    useApp.getState().setKeybindings({ 'close-tab': 'CmdOrCtrl+Alt+W', refresh: null });
    useApp.getState().resetKeybinding('close-tab');
    expect(useApp.getState().keybindings).toEqual({ refresh: null });
    useApp.getState().resetAllKeybindings();
    expect(useApp.getState().keybindings).toEqual({});
    expect(storage.has('earthql.keybindings')).toBe(false);
    expect(invoke).toHaveBeenLastCalledWith('keybindings:apply', { overrides: {}, suspended: false });
  });

  it('ignores invalid or built-in entries', () => {
    useApp.getState().setKeybindings({ 'sys-copy': 'CmdOrCtrl+K', run: 'T' });
    expect(useApp.getState().keybindings).toEqual({});
  });
});
