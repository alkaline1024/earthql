import { app, ipcMain } from 'electron';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { bundledFeedbackEndpoint, postToAppsScript } from './feedback';
import {
  loadActivityRandomizeUsername, loadActivitySharing, loadOrCreateActivityInstallationId,
  saveActivityRandomizeUsername, saveActivitySharing,
} from './store';

const HOUR = 60 * 60 * 1000;

function macMetadata() {
  if (process.platform !== 'darwin') return {};
  const version = process.getSystemVersion?.();
  const macosVersion = version && /^\d{1,4}(?:\.\d{1,4}){0,2}$/.test(version) ? version : undefined;
  let model: string | undefined;
  try {
    const value = execFileSync('/usr/sbin/sysctl', ['-n', 'hw.model'], { encoding: 'utf8', timeout: 500 }).trim();
    if (/^[A-Za-z0-9][A-Za-z0-9,._ -]{0,63}$/.test(value)) model = value;
  } catch {
    // Model is optional on machines where sysctl cannot supply it.
  }
  return { macosVersion, model };
}

export function setupActivity(dev: { preview?: boolean; send?: boolean } = {}) {
  const endpoint = app.isPackaged || dev.send ? bundledFeedbackEndpoint() : '';
  const preview = !app.isPackaged && !endpoint && !!dev.preview;
  const available = !!endpoint || preview;
  let enabled = available && (!app.isPackaged || loadActivitySharing());
  let randomizeUsername = !!endpoint && loadActivityRandomizeUsername();
  let metadata: ReturnType<typeof macMetadata> | undefined;
  let installationId: string | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let session: { id: string; abort: AbortController } | undefined;

  function stop() {
    if (timer) clearInterval(timer);
    timer = undefined;
    session?.abort.abort();
    session = undefined;
  }

  function activityUsername(): string | undefined {
    if (randomizeUsername) return installationId ? `user-${installationId}` : undefined;
    try {
      const name = os.userInfo().username;
      return name.length > 0 && name.length <= 256 ? name : undefined;
    } catch { return undefined; }
  }

  function start() {
    if (!endpoint || !enabled || session) return;
    if (!installationId) {
      try { installationId = loadOrCreateActivityInstallationId(); }
      catch {
        if (!app.isPackaged) console.warn('[activity] Could not save the installation ID.');
      }
    }
    metadata ??= macMetadata();
    const current = { id: randomUUID(), abort: new AbortController() };
    session = current;
    const send = (event: 'open' | 'heartbeat') => {
      const activity = { sessionId: current.id, installationId, username: activityUsername(), event, appVersion: app.getVersion(), ...metadata };
      const signal = AbortSignal.any([current.abort.signal, AbortSignal.timeout(15_000)]);
      void postToAppsScript(endpoint, JSON.stringify({ activity }), signal)
        .then((result) => {
          if (app.isPackaged || current.abort.signal.aborted) return;
          if (result?.ok === true && result.id === current.id) {
            console.info(`[activity] ${event} recorded in Google Sheets.`);
            return;
          }
          const code = typeof result?.code === 'string' && /^[A-Z_]{1,32}$/.test(result.code)
            ? result.code : 'UNEXPECTED_RESPONSE';
          console.warn(`[activity] ${event} rejected (${code}). Check the Apps Script deployment version and ACTIVITY_ENABLED.`);
        })
        .catch(() => {
          if (!app.isPackaged && !current.abort.signal.aborted) {
            console.warn(`[activity] ${event} could not reach the Apps Script endpoint.`);
          }
        });
    };
    send('open');
    timer = setInterval(() => send('heartbeat'), HOUR);
    timer.unref();
  }

  function settings() { return { available, enabled, preview, installationId, randomizeUsername }; }
  ipcMain.handle('activity:settings', () => ({ ok: true, value: settings() }));
  ipcMain.handle('activity:setEnabled', (_event, value: unknown) => {
    if (!available || typeof value !== 'boolean') {
      return { ok: false, error: { category: 'config', message: 'Activity sharing is unavailable.' } };
    }
    try { if (app.isPackaged) saveActivitySharing(value); }
    catch { return { ok: false, error: { category: 'unknown', message: 'Could not save the activity preference.' } }; }
    enabled = value;
    if (enabled) start();
    else stop();
    return { ok: true, value: settings() };
  });

  ipcMain.handle('activity:setRandomizeUsername', (_event, value: unknown) => {
    if (!available || typeof value !== 'boolean') {
      return { ok: false, error: { category: 'config', message: 'Activity sharing is unavailable.' } };
    }
    try { if (!preview) saveActivityRandomizeUsername(value); }
    catch { return { ok: false, error: { category: 'unknown', message: 'Could not save the username preference.' } }; }
    randomizeUsername = value;
    return { ok: true, value: settings() };
  });

  app.once('quit', stop);
  start();
}
