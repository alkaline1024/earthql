import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ConnectionProfile } from '@earthql/core';

vi.mock('../src/renderer/src/api', () => ({
  api: {}, uid: () => 'fixture-id', errorInfo: vi.fn(), onMenuCommand: () => () => undefined,
}));

let validateProfile: typeof import('../src/renderer/src/components/ConnectionsScreen').validateProfile;

beforeAll(async () => {
  vi.stubGlobal('localStorage', { getItem: () => null });
  ({ validateProfile } = await import('../src/renderer/src/components/ConnectionsScreen'));
});
afterAll(() => vi.unstubAllGlobals());

const base = {
  id: 'test', name: 'Test', host: 'localhost', port: 1433, database: '', user: 'user',
  tls: { mode: 'require' as const }, env: { name: 'Local', color: '#888' }, createdAt: 0, updatedAt: 0,
};

describe('connection profile validation', () => {
  afterEach(() => { vi.doUnmock('../src/renderer/src/store'); });
  it('allows SQL Server without a database while retaining other required fields', () => {
    const profile: ConnectionProfile = { ...base, driver: 'mssql' };
    expect(validateProfile(profile, {}, [])).toEqual([]);
    expect(validateProfile({ ...profile, user: '' }, {}, [])).toEqual(['Username']);
    expect(validateProfile({ ...profile, database: 'master' }, {}, [])).toEqual([]);
  });

  it('still requires a PostgreSQL database', () => {
    expect(validateProfile({ ...base, driver: 'postgres' }, {}, [])).toContain('Database');
  });

  it('renders the database picker for SQL Server profiles', async () => {
    vi.stubGlobal('localStorage', { getItem: () => null });
    vi.resetModules();
    const store = await import('../src/renderer/src/store');
    const { useApp } = store;
    vi.doMock('../src/renderer/src/store', () => ({
      ...store,
      useApp: Object.assign((selector?: (state: ReturnType<typeof useApp.getState>) => unknown) =>
        selector ? selector(useApp.getState()) : useApp.getState(), useApp),
    }));
    const { ConnectionsScreen } = await import('../src/renderer/src/components/ConnectionsScreen');
    const render = (driver: 'mssql' | 'postgres') => {
      useApp.setState({ profiles: [{ profile: { ...base, driver }, storedSecrets: [] }], connections: {}, connecting: {}, connectErrors: {} });
      return renderToStaticMarkup(createElement(ConnectionsScreen, { initialProfileId: base.id }));
    };
    expect(render('mssql')).toContain('aria-label="Choose database"');
    expect(render('postgres')).not.toContain('aria-label="Choose database"');
  });
});
