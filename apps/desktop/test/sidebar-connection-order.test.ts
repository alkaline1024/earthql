import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { LiveConnection } from '../src/renderer/src/store';
import type { ProfileSummary } from '../src/shared/api';

vi.mock('../src/renderer/src/api', () => ({
  api: {}, uid: () => 'fixture-id', errorInfo: vi.fn(), onMenuCommand: () => () => undefined,
}));

let useApp: typeof import('../src/renderer/src/store').useApp;
let orderedConnectionIds: typeof import('../src/renderer/src/store').orderedConnectionIds;
let saved: Map<string, string>;
let setItem: ReturnType<typeof vi.fn>;

const connection = (id: string, profileId = id): LiveConnection => ({
  sessionId: id, profileId, status: 'connected', defaultContext: {},
  capabilities: {} as LiveConnection['capabilities'],
});
const profiles = ['Alpha', 'Beta', 'Gamma'].map((name, i): ProfileSummary => ({
  profile: {
    id: ['a', 'b', 'c'][i], name, driver: 'mysql', host: 'localhost', port: 3306, database: 'demo',
    user: 'fixture', tls: { mode: 'disable' }, env: { name: 'Local', color: '#888' }, createdAt: 0, updatedAt: 0,
  },
  storedSecrets: [],
}));

beforeEach(async () => {
  vi.resetModules();
  saved = new Map();
  setItem = vi.fn((key: string, value: string) => saved.set(key, value));
  vi.stubGlobal('localStorage', { getItem: (key: string) => saved.get(key) ?? null, setItem });
  ({ useApp, orderedConnectionIds } = await import('../src/renderer/src/store'));
  useApp.setState({
    connections: { a: connection('a'), b: connection('b'), c: connection('c') },
    sidebarConnectionOrder: [], activeProfileId: 'b', profiles: [], toasts: [],
    gridDrafts: { pending: { rows: {}, inserts: [{ id: 'new', values: {} }] } },
  });
});

afterEach(() => {
  vi.doUnmock('../src/renderer/src/store');
  vi.unstubAllGlobals();
});

describe('sidebar connection ordering', () => {
  it('moves before and after a target without changing active connections or drafts', () => {
    const original = useApp.getState();
    useApp.getState().moveConnection('c', 'a', false);
    expect(orderedConnectionIds(original.connections, useApp.getState().sidebarConnectionOrder)).toEqual(['c', 'a', 'b']);
    useApp.getState().moveConnection('c', 'b', true);
    expect(useApp.getState().sidebarConnectionOrder).toEqual(['a', 'b', 'c']);
    expect(useApp.getState().connections).toBe(original.connections);
    expect(useApp.getState().activeProfileId).toBe('b');
    expect(useApp.getState().gridDrafts).toBe(original.gridDrafts);
    expect(JSON.parse(saved.get('earthql.sidebarConnectionOrder')!)).toEqual(['a', 'b', 'c']);
  });

  it('reorders separate sessions of the same profile independently', () => {
    useApp.setState({
      connections: {
        a: connection('a'),
        separate1: { ...connection('separate1', 'a'), scope: { kind: 'database', name: 'demo' } },
        separate2: { ...connection('separate2', 'a'), scope: { kind: 'database', name: 'demo' } },
      },
    });
    useApp.getState().moveConnection('separate2', 'a', false);
    expect(useApp.getState().sidebarConnectionOrder).toEqual(['separate2', 'a', 'separate1']);
  });

  it('restores persisted order, ignores closed sessions, and appends new connections', async () => {
    saved.set('earthql.sidebarConnectionOrder', JSON.stringify(['b', 'b', 9, 'closed', 'a']));
    vi.resetModules();
    const restored = await import('../src/renderer/src/store');
    expect(restored.useApp.getState().sidebarConnectionOrder).toEqual(['b', 'closed', 'a']);
    expect(restored.orderedConnectionIds(useApp.getState().connections, restored.useApp.getState().sidebarConnectionOrder))
      .toEqual(['b', 'a', 'c']);
  });

  it('ignores cancelled or stale drops and reports persistence failures', () => {
    useApp.getState().moveConnection('a', 'a', true);
    useApp.getState().moveConnection('missing', 'a', false);
    useApp.getState().moveConnection('a', 'missing', false);
    useApp.getState().moveConnection('constructor', 'a', false);
    expect(setItem).not.toHaveBeenCalled();
    expect(useApp.getState().sidebarConnectionOrder).toEqual([]);
    setItem.mockImplementationOnce(() => { throw new Error('Storage unavailable'); });
    useApp.getState().moveConnection('c', 'a', false);
    expect(useApp.getState().sidebarConnectionOrder).toEqual(['c', 'a', 'b']);
    expect(useApp.getState().toasts.at(-1)?.text).toBe('Sidebar connection order could not be saved.');
  });

  it('remembers closed saved profiles while pruning closed temporary sessions', () => {
    useApp.setState({
      profiles, connections: { a: connection('a'), c: connection('c') },
      sidebarConnectionOrder: ['old-temporary', 'a', 'b', 'c'],
    });
    useApp.getState().moveConnection('c', 'a', false);
    expect(useApp.getState().sidebarConnectionOrder).toEqual(['c', 'a', 'b']);
    expect(orderedConnectionIds({ a: connection('a'), c: connection('c'), b: connection('b') }, useApp.getState().sidebarConnectionOrder))
      .toEqual(['c', 'a', 'b']);
  });

  it('renders draggable sidebar connections in the chosen order', async () => {
    useApp.setState({
      activeProfileId: null, sidebarConnectionOrder: ['b', 'a', 'c'],
      profiles,
    });
    const store = await import('../src/renderer/src/store');
    vi.doMock('../src/renderer/src/store', () => ({
      ...store,
      useApp: Object.assign((selector?: (state: ReturnType<typeof useApp.getState>) => unknown) =>
        selector ? selector(useApp.getState()) : useApp.getState(), useApp),
    }));
    const { Sidebar } = await import('../src/renderer/src/components/Sidebar');
    const html = renderToStaticMarkup(createElement(Sidebar));
    expect(html.match(/draggable="true"/g)).toHaveLength(3);
    expect(html.indexOf('aria-label="Beta"')).toBeGreaterThan(-1);
    expect(html.indexOf('aria-label="Beta"')).toBeLessThan(html.indexOf('aria-label="Alpha"'));
    expect(html.indexOf('aria-label="Alpha"')).toBeLessThan(html.indexOf('aria-label="Gamma"'));
    expect(html).toContain('Drag to reorder connections');
  });
});
