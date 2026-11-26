import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const storage = new Map<string, string>();
const dataset: Record<string, string> = {};

async function loadStore() {
  vi.resetModules();
  return (await import('../src/renderer/src/store')).useApp;
}

beforeEach(() => {
  storage.clear();
  for (const key of Object.keys(dataset)) delete dataset[key];
  vi.stubGlobal('window', { earthqlBridge: { platform: 'darwin', invoke: vi.fn() } });
  vi.stubGlobal('document', {
    documentElement: {
      dataset,
      removeAttribute: (name: string) => {
        if (name === 'data-theme') delete dataset.theme;
      },
    },
  });
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
  });
});

afterEach(() => vi.unstubAllGlobals());

describe('UI style preference', () => {
  it('defaults to Modern for missing or invalid values', async () => {
    let app = await loadStore();
    expect(app.getState().uiStyle).toBe('modern');
    expect(dataset.uiStyle).toBe('modern');
    storage.set('earthql.uiStyle', 'unknown');
    app = await loadStore();
    expect(app.getState().uiStyle).toBe('modern');
    expect(dataset.uiStyle).toBe('modern');
  });

  it('persists and restores Modern independently of the color theme', async () => {
    let app = await loadStore();
    app.getState().setTheme('dark');
    app.getState().setUiStyle('modern');
    expect(storage.get('earthql.uiStyle')).toBe('modern');
    expect(dataset).toMatchObject({ theme: 'dark', uiStyle: 'modern' });
    app = await loadStore();
    expect(app.getState().uiStyle).toBe('modern');
    expect(app.getState().theme).toBe('dark');
    app.getState().setTheme('sepia');
    app.getState().setUiStyle('classic');
    expect(dataset).toMatchObject({ theme: 'sepia', uiStyle: 'classic' });
    expect(storage.get('earthql.theme')).toBe('sepia');
    expect(storage.get('earthql.uiStyle')).toBe('classic');
  });

  it('reports a storage failure while applying the style for the current session', async () => {
    const app = await loadStore();
    vi.stubGlobal('localStorage', { setItem: () => { throw new Error('unavailable'); } });
    app.getState().setUiStyle('modern');
    expect(dataset.uiStyle).toBe('modern');
    expect(app.getState().uiStyle).toBe('modern');
    expect(app.getState().toasts).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'error', text: 'UI style could not be saved.' }),
    ]));
  });
});
