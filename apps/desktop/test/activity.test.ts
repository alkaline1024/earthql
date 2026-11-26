import { afterEach, expect, it, vi } from 'vitest';
import { setupActivity } from '../src/main/activity';

const mocks = vi.hoisted(() => ({
  app: { isPackaged: true, getVersion: () => '0.3.0', once: vi.fn() },
  handle: vi.fn(),
  send: vi.fn(async () => null),
  load: vi.fn(() => false),
  installation: vi.fn(() => "8fc06a92-32ba-4bee-84a5-e2d856a037c0"),
  save: vi.fn(),
  loadRandomize: vi.fn(() => false),
  saveRandomize: vi.fn(),
}));
vi.mock('node:child_process', () => ({ execFileSync: () => 'Mac14,3\n' }));
vi.mock('node:os', () => ({ default: { userInfo: () => ({ username: 'earthql-test' }) } }));
vi.mock('electron', () => ({ app: mocks.app, ipcMain: { handle: mocks.handle } }));
vi.mock('../src/main/feedback', () => ({ bundledFeedbackEndpoint: () => 'endpoint', postToAppsScript: mocks.send }));
vi.mock('../src/main/store', () => ({ loadActivitySharing: mocks.load, loadOrCreateActivityInstallationId: mocks.installation, saveActivitySharing: mocks.save,
  loadActivityRandomizeUsername: mocks.loadRandomize, saveActivityRandomizeUsername: mocks.saveRandomize,
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.useRealTimers();
  mocks.app.isPackaged = true;
});

it('sends on opt-in and hourly, groups one session, and stops on opt-out', () => {
  vi.useFakeTimers();
  vi.stubGlobal('process', Object.create(process, {
    platform: { value: 'darwin' },
    getSystemVersion: { value: () => '26.1' },
  }));
  setupActivity();
  const setEnabled = mocks.handle.mock.calls.find(([channel]) => channel === 'activity:setEnabled')![1];
  vi.advanceTimersByTime(3600000);
  expect(mocks.send).not.toHaveBeenCalled();
  setEnabled({}, true);
  expect(mocks.send).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(3599999);
  expect(mocks.send).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(1);
  const [open, beat] = mocks.send.mock.calls.map((call) => JSON.parse((call as unknown[])[1] as string).activity);
  expect(open).toEqual({ event: 'open', sessionId: expect.any(String), installationId: mocks.installation(), username: 'earthql-test', appVersion: '0.3.0', macosVersion: '26.1', model: 'Mac14,3' });
  expect(beat).toEqual({ ...open, event: 'heartbeat' });
  setEnabled({}, false);
  vi.advanceTimersByTime(3600000);
  expect(mocks.send).toHaveBeenCalledTimes(2);
});

it('sends once at launch for opted-in users and skips dev builds', () => {
  vi.useFakeTimers();
  mocks.load.mockReturnValue(true);
  setupActivity();
  expect(mocks.send).toHaveBeenCalledTimes(1);
  mocks.app.once.mock.calls[0][1]();
  mocks.app.isPackaged = false;
  setupActivity();
  vi.advanceTimersByTime(3600000);
  expect(mocks.send).toHaveBeenCalledTimes(1);
});

it('shows an in-memory activity toggle in dev preview without sending', () => {
  vi.useFakeTimers();
  mocks.app.isPackaged = false;
  setupActivity({ preview: true });
  const settings = mocks.handle.mock.calls.find(([channel]) => channel === 'activity:settings')![1];
  const setEnabled = mocks.handle.mock.calls.find(([channel]) => channel === 'activity:setEnabled')![1];
  expect(settings().value).toEqual({ available: true, enabled: true, preview: true, randomizeUsername: false });
  expect(setEnabled({}, false).value.enabled).toBe(false);
  expect(setEnabled({}, true).value.enabled).toBe(true);
  vi.advanceTimersByTime(3600000);
  expect(mocks.send).not.toHaveBeenCalled();
  expect(mocks.save).not.toHaveBeenCalled();
});

it('sends from dev only when explicitly enabled and leaves the installed preference untouched', () => {
  vi.useFakeTimers();
  mocks.app.isPackaged = false;
  setupActivity({ preview: true, send: true });
  const settings = mocks.handle.mock.calls.find(([channel]) => channel === 'activity:settings')![1];
  const setEnabled = mocks.handle.mock.calls.find(([channel]) => channel === 'activity:setEnabled')![1];
  expect(settings().value).toEqual({ available: true, enabled: true, preview: false, randomizeUsername: false, installationId: mocks.installation() });
  expect(mocks.send).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(3600000);
  expect(mocks.send).toHaveBeenCalledTimes(2);
  setEnabled({}, false);
  vi.advanceTimersByTime(3600000);
  expect(mocks.send).toHaveBeenCalledTimes(2);
  expect(mocks.save).not.toHaveBeenCalled();
});

it('uses the stored randomization preference at launch and updates it for later events', () => {
  vi.useFakeTimers();
  mocks.load.mockReturnValue(true);
  mocks.loadRandomize.mockReturnValueOnce(true);
  setupActivity();
  const setRandomize = mocks.handle.mock.calls.find(([channel]) => channel === 'activity:setRandomizeUsername')![1];
  const usernames = () => mocks.send.mock.calls.map((call) => JSON.parse((call as unknown[])[1] as string).activity.username);
  expect(usernames()).toEqual([`user-${mocks.installation()}`]);
  expect(setRandomize({}, false).value.randomizeUsername).toBe(false);
  expect(mocks.saveRandomize).toHaveBeenCalledWith(false);
  vi.advanceTimersByTime(3600000);
  expect(usernames()).toEqual([`user-${mocks.installation()}`, 'earthql-test']);
  mocks.app.once.mock.calls[0][1]();
});
