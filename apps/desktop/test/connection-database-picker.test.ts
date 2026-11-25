import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectionProfile, MssqlProfile } from '@earthql/core';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
  getSecrets: vi.fn(),
  setSecret: vi.fn(),
  deleteSecret: vi.fn(),
  loadProfiles: vi.fn(),
  saveProfiles: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, handler: (...args: unknown[]) => Promise<unknown>) => mocks.handlers.set(name, handler) },
  BrowserWindow: {}, dialog: {}, app: {},
}));
vi.mock('../src/main/keychain', () => ({
  getSecrets: mocks.getSecrets, deleteAllSecrets: vi.fn(), deleteSecret: mocks.deleteSecret, setSecret: mocks.setSecret,
  saveImportedPassword: vi.fn(),
}));
vi.mock('../src/main/store', () => ({
  loadProfiles: mocks.loadProfiles, saveProfiles: mocks.saveProfiles, addHistory: vi.fn(), clearHistory: vi.fn(),
  deleteProfileData: vi.fn(), loadHistory: vi.fn(), loadSaved: vi.fn(), writeSaved: vi.fn(),
}));
vi.mock('../src/main/feedback', () => ({
  captureFeedbackScreenshot: vi.fn(), feedbackSettings: vi.fn(), saveFeedbackSettings: vi.fn(), submitFeedback: vi.fn(),
}));

import { registerIpc } from '../src/main/ipc';
import { SessionManager } from '../src/main/sessions';
import { mssqlDriver } from '@earthql/driver-mssql';
import { mysqlDriver } from '@earthql/driver-mysql';
import { postgresDriver } from '@earthql/driver-postgres';
import { databricksDriver } from '@earthql/driver-databricks';

const profile: MssqlProfile = {
  id: 'test', name: 'Test', driver: 'mssql', host: 'localhost', port: 1433, database: '', user: 'user',
  tls: { mode: 'require' }, env: { name: 'Local', color: '#888' }, createdAt: 0, updatedAt: 0,
};

describe('database picker IPC', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.handlers.clear();
    mocks.getSecrets.mockReturnValue({ password: 'stored password' });
    mocks.loadProfiles.mockReturnValue([profile]);
  });

  it('uses the unsaved profile and password, returns databases, and closes the temporary connection', async () => {
    const nodes = [{ kind: 'database' as const, name: 'app', path: {}, hasChildren: true }];
    const conn = mssqlDriver.connect(profile, {});
    vi.spyOn(conn, 'listChildren').mockResolvedValue(nodes);
    vi.spyOn(conn, 'close').mockResolvedValue(undefined);
    const sessions = new SessionManager(() => {});
    vi.spyOn(sessions, 'createConnection').mockReturnValue(conn);
    registerIpc(sessions);
    const result = await mocks.handlers.get('profiles:databases')!(null, profile, { password: 'new password' });
    expect(sessions.createConnection).toHaveBeenCalledWith(profile, { password: 'new password' });
    expect(mocks.getSecrets).not.toHaveBeenCalled();
    expect(conn.listChildren).toHaveBeenCalledWith(null);
    expect(conn.close).toHaveBeenCalledOnce();
    expect(result).toEqual({ ok: true, value: nodes });
  });

  it('uses stored secrets when omitted and returns classified errors after closing', async () => {
    const conn = mssqlDriver.connect(profile, {});
    vi.spyOn(conn, 'listChildren').mockRejectedValue(new Error('failed'));
    vi.spyOn(conn, 'classifyError').mockReturnValue({ category: 'auth', message: 'Sign-in failed' });
    vi.spyOn(conn, 'close').mockResolvedValue(undefined);
    const sessions = new SessionManager(() => {});
    vi.spyOn(sessions, 'createConnection').mockReturnValue(conn);
    registerIpc(sessions);
    const result = await mocks.handlers.get('profiles:databases')!(null, profile, {});
    expect(sessions.createConnection).toHaveBeenCalledWith(profile, { password: 'stored password' });
    expect(mocks.getSecrets).toHaveBeenCalledWith(profile.id, ['password']);
    expect(conn.close).toHaveBeenCalledOnce();
    expect(result).toEqual({ ok: false, error: { category: 'auth', message: 'Sign-in failed' } });
  });

  it('does not use a stored password that has been marked for removal', async () => {
    const conn = mssqlDriver.connect(profile, {});
    vi.spyOn(conn, 'listChildren').mockResolvedValue([]);
    vi.spyOn(conn, 'close').mockResolvedValue(undefined);
    const sessions = new SessionManager(() => {});
    vi.spyOn(sessions, 'createConnection').mockReturnValue(conn);
    registerIpc(sessions);
    await mocks.handlers.get('profiles:databases')!(null, profile, { password: '' });
    expect(sessions.createConnection).toHaveBeenCalledWith(profile, { password: '' });
    expect(mocks.getSecrets).not.toHaveBeenCalled();
  });

  it('tests a draft with a newly entered password without reading Keychain', async () => {
    const conn = mssqlDriver.connect(profile, {});
    vi.spyOn(conn, 'test').mockResolvedValue({ ok: true, steps: [] });
    vi.spyOn(conn, 'close').mockResolvedValue(undefined);
    const sessions = new SessionManager(() => {});
    vi.spyOn(sessions, 'createConnection').mockReturnValue(conn);
    registerIpc(sessions);
    expect(await mocks.handlers.get('profiles:test')!(null, profile, { password: 'new password' }))
      .toEqual({ ok: true, value: { ok: true, steps: [] } });
    expect(mocks.getSecrets).not.toHaveBeenCalled();
  });
});

describe('lazy Keychain access', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.handlers.clear();
  });

  it('lists every driver without reading saved credentials', async () => {
    const profiles: ConnectionProfile[] = [
      profile, { ...profile, id: 'my', driver: 'mysql' }, { ...profile, id: 'pg', driver: 'postgres' },
      { id: 'dbx', name: 'DBX', driver: 'databricks', host: 'host', httpPath: '/sql', authMode: 'access-token', env: profile.env, createdAt: 0, updatedAt: 0 },
    ];
    mocks.loadProfiles.mockReturnValue(profiles);
    registerIpc(new SessionManager(() => {}));
    expect(await mocks.handlers.get('profiles:list')!(null)).toEqual({
      ok: true, value: profiles.map((p) => ({ profile: p, storedSecrets: null })),
    });
    expect(mocks.getSecrets).not.toHaveBeenCalled();
  });

  it('saves ordinary profile changes without reading, writing or deleting Keychain items', async () => {
    mocks.loadProfiles.mockReturnValue([profile]);
    registerIpc(new SessionManager(() => {}));
    expect(await mocks.handlers.get('profiles:save')!(null, { ...profile, name: 'Updated' }, {})).toMatchObject({ ok: true });
    expect(mocks.getSecrets).not.toHaveBeenCalled();
    expect(mocks.setSecret).not.toHaveBeenCalled();
    expect(mocks.deleteSecret).not.toHaveBeenCalled();
  });

  it('removes only the previous credential when changing authentication mode', async () => {
    const old: ConnectionProfile = {
      id: 'dbx', name: 'DBX', driver: 'databricks', host: 'host', httpPath: '/sql', authMode: 'access-token',
      env: profile.env, createdAt: 0, updatedAt: 0,
    };
    mocks.loadProfiles.mockReturnValue([old]);
    registerIpc(new SessionManager(() => {}));
    const changed: ConnectionProfile = { ...old, authMode: 'oauth-m2m', clientId: 'client' };
    expect(await mocks.handlers.get('profiles:save')!(null, changed, { clientSecret: 'new' })).toMatchObject({ ok: true });
    expect(mocks.setSecret).toHaveBeenCalledWith('dbx', 'clientSecret', 'new');
    expect(mocks.deleteSecret).toHaveBeenCalledExactlyOnceWith('dbx', 'accessToken');
    expect(mocks.getSecrets).not.toHaveBeenCalled();
  });

  it('does not access Keychain when classifying errors for closed sessions', () => {
    const sessions = new SessionManager(() => {});
    expect(sessions.errorFor(profile.id, new Error('Not connected')).message).toContain('Not connected');
    expect(mocks.getSecrets).not.toHaveBeenCalled();
  });

  it('surfaces a denied Keychain request without requesting it a second time', async () => {
    mocks.loadProfiles.mockReturnValue([profile]);
    mocks.getSecrets.mockImplementation(() => { throw new Error('Keychain access denied'); });
    const sessions = new SessionManager(() => {});
    registerIpc(sessions);
    const result = await mocks.handlers.get('connection:open')!(null, profile.id);
    expect(result).toMatchObject({ ok: false, error: { message: 'Keychain access denied' } });
    expect(mocks.getSecrets).toHaveBeenCalledTimes(1);
  });

  it.each([
    { profile, driver: mssqlDriver, field: 'password' as const },
    { profile: { ...profile, driver: 'mysql' as const }, driver: mysqlDriver, field: 'password' as const },
    { profile: { ...profile, driver: 'postgres' as const, database: 'postgres' }, driver: postgresDriver, field: 'password' as const },
    { profile: { id: 'dbx', name: 'DBX', driver: 'databricks' as const, host: 'host', httpPath: '/sql', authMode: 'access-token' as const, env: profile.env, createdAt: 0, updatedAt: 0 }, driver: databricksDriver, field: 'accessToken' as const },
    { profile: { id: 'dbx', name: 'DBX', driver: 'databricks' as const, host: 'host', httpPath: '/sql', authMode: 'oauth-m2m' as const, clientId: 'client', env: profile.env, createdAt: 0, updatedAt: 0 }, driver: databricksDriver, field: 'clientSecret' as const },
  ])('reads only $field when connecting $profile.driver', async ({ profile: selected, driver, field }) => {
    mocks.loadProfiles.mockReturnValue([selected]);
    mocks.getSecrets.mockReturnValue({ [field]: 'stored' });
    const conn = driver.connect(selected, { [field]: 'stored' });
    vi.spyOn(conn, 'listChildren').mockResolvedValue([]);
    vi.spyOn(conn, 'close').mockResolvedValue(undefined);
    const sessions = new SessionManager(() => {});
    vi.spyOn(sessions, 'createConnection').mockReturnValue(conn);
    await sessions.open(selected.id);
    expect(mocks.getSecrets).toHaveBeenCalledExactlyOnceWith(selected.id, [field]);
    await sessions.close(selected.id);
  });
});
