import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ConnectionProfile } from '@earthql/core';

vi.mock('../src/renderer/src/api', () => ({
  api: {}, uid: () => 'fixture-id', errorInfo: vi.fn(), onMenuCommand: () => () => undefined,
}));

let validateProfile: typeof import('../src/renderer/src/components/ConnectionsScreen').validateProfile;
let parseDatabricksJdbc: typeof import('../src/renderer/src/components/ConnectionsScreen').parseDatabricksJdbc;

beforeAll(async () => {
  vi.stubGlobal('localStorage', { getItem: () => null });
  ({ validateProfile, parseDatabricksJdbc } = await import('../src/renderer/src/components/ConnectionsScreen'));
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

  describe('Databricks JDBC import', () => {
    const jdbc = 'jdbc:databricks://adb-example.14.azuredatabricks.net:443/default;httpPath=/sql/1.0/warehouses/example;AuthMech=11;Auth_Flow=1;OAuth2ClientId=client;OAuth2Secret=secret=part';

    it('extracts M2M settings and the schema without including the secret in the profile settings', () => {
      const { clientSecret, ...settings } = parseDatabricksJdbc(jdbc);
      expect(settings).toEqual({
        host: 'adb-example.14.azuredatabricks.net', httpPath: '/sql/1.0/warehouses/example',
        schema: 'default', clientId: 'client', azureTenantId: '',
      });
      expect(clientSecret).toBe('secret=part');
      expect(JSON.stringify(settings)).not.toContain('secret');
      expect(parseDatabricksJdbc(jdbc.replace('/default;', ';') + ';AzureTenantId=tenant;')).toMatchObject({ schema: '', azureTenantId: 'tenant' });
    });

    it.each([
      'jdbc:postgresql://host/db;AuthMech=11;Auth_Flow=1',
      jdbc.replace(':443/', ':8443/'),
      jdbc.replace('Auth_Flow=1', 'Auth_Flow=2'),
      jdbc.replace(';OAuth2Secret=secret=part', ''),
      `${jdbc};unsupported=secret-value`,
      `${jdbc};httpPath=/other`,
      jdbc.replace('/default;', '/bad%zz;'),
    ])('rejects invalid or unsupported URLs without exposing their values', (input) => {
      try {
        parseDatabricksJdbc(input);
        throw new Error('URL unexpectedly accepted');
      } catch (e) {
        expect(e).toBeInstanceOf(Error);
        expect((e as Error).message).not.toContain('secret');
        expect((e as Error).message).not.toBe('URL unexpectedly accepted');
      }
    });

    it('shows the paste field only for Databricks profiles', async () => {
      vi.resetModules();
      const store = await import('../src/renderer/src/store');
      const { useApp } = store;
      vi.doMock('../src/renderer/src/store', () => ({
        ...store,
        useApp: Object.assign((selector?: (state: ReturnType<typeof useApp.getState>) => unknown) =>
          selector ? selector(useApp.getState()) : useApp.getState(), useApp),
      }));
      const { ConnectionsScreen } = await import('../src/renderer/src/components/ConnectionsScreen');
      const databricks: ConnectionProfile = {
        id: 'dbx', name: 'DBX', driver: 'databricks', host: 'host', httpPath: '/sql',
        authMode: 'oauth-m2m', env: base.env, createdAt: 0, updatedAt: 0,
      };
      const profiles: ConnectionProfile[] = [
        databricks, ...(['postgres', 'mysql', 'mssql'] as const).map((driver) => ({ ...base, driver })),
      ];
      for (const profile of profiles) {
        useApp.setState({ profiles: [{ profile, storedSecrets: null }], connections: {}, connecting: {}, connectErrors: {} });
        const markup = renderToStaticMarkup(createElement(ConnectionsScreen, { initialProfileId: profile.id }));
        expect(markup.includes('id="databricks-jdbc"')).toBe(profile.driver === 'databricks');
      }
      vi.doUnmock('../src/renderer/src/store');
    });
  });

  it('still requires a PostgreSQL database', () => {
    expect(validateProfile({ ...base, driver: 'postgres' }, {}, [])).toContain('Database');
  });

  it('accepts an unverified saved Databricks secret but requires one for a new profile', () => {
    const profile: ConnectionProfile = {
      id: 'dbx', name: 'DBX', driver: 'databricks', host: 'host', httpPath: '/sql',
      authMode: 'access-token', env: base.env, createdAt: 0, updatedAt: 0,
    };
    expect(validateProfile(profile, {}, null)).toEqual([]);
    expect(validateProfile(profile, {}, [])).toContain('Access token');
    expect(validateProfile(profile, { accessToken: 'value' }, [])).toEqual([]);
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
      useApp.setState({ profiles: [{ profile: { ...base, driver }, storedSecrets: null }], connections: {}, connecting: {}, connectErrors: {} });
      return renderToStaticMarkup(createElement(ConnectionsScreen, { initialProfileId: base.id }));
    };
    expect(render('mssql')).toContain('aria-label="Choose database"');
    expect(render('mssql')).toContain('Leave blank to use a saved Keychain value, if available');
    expect(render('mssql')).toContain('EarthQL uses free ad-hoc signing');
    expect(render('postgres')).not.toContain('aria-label="Choose database"');
  });
});
