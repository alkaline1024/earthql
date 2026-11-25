import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MssqlProfile } from '@earthql/core';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
  getSecrets: vi.fn(),
}));

vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, handler: (...args: unknown[]) => Promise<unknown>) => mocks.handlers.set(name, handler) },
  BrowserWindow: {}, dialog: {}, app: {},
}));
vi.mock('../src/main/keychain', () => ({
  getSecrets: mocks.getSecrets, deleteAllSecrets: vi.fn(), deleteSecret: vi.fn(), setSecret: vi.fn(), storedFields: vi.fn(),
  saveImportedPassword: vi.fn(),
}));
vi.mock('../src/main/feedback', () => ({
  captureFeedbackScreenshot: vi.fn(), feedbackSettings: vi.fn(), saveFeedbackSettings: vi.fn(), submitFeedback: vi.fn(),
}));

import { registerIpc } from '../src/main/ipc';
import { SessionManager } from '../src/main/sessions';
import { mssqlDriver } from '@earthql/driver-mssql';

const profile: MssqlProfile = {
  id: 'test', name: 'Test', driver: 'mssql', host: 'localhost', port: 1433, database: '', user: 'user',
  tls: { mode: 'require' }, env: { name: 'Local', color: '#888' }, createdAt: 0, updatedAt: 0,
};

describe('database picker IPC', () => {
  beforeEach(() => {
    mocks.handlers.clear();
    mocks.getSecrets.mockReturnValue({ password: 'stored password' });
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
  });
});
