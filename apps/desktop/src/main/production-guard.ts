import { BrowserWindow, dialog } from 'electron';
import { makeError } from '@earthql/core';
import type { SessionManager } from './sessions';
import { loadProfiles } from './store';

export async function confirmProductionOperation(sessions: SessionManager, sessionId: string, action: string): Promise<void> {
  const live = sessions.get(sessionId);
  const profile = loadProfiles().find((item) => item.id === live.profile.id);
  if (!profile) throw makeError('config', 'The connection profile no longer exists.');
  if (!/prod/i.test(profile.env.name)) return;
  const options = {
    type: 'warning' as const,
    title: 'Production connection',
    message: `${action} on ${profile.name}?`,
    detail: `This connection is marked ${profile.env.name}. Verify the target before continuing. SQL may have side effects even when it appears to read data.`,
    buttons: ['Cancel', 'Continue'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  };
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const result = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
  if (result.response !== 1) throw makeError('cancelled', 'Cancelled. No changes were sent to the database.');
  const current = loadProfiles().find((item) => item.id === profile.id);
  if (sessions.get(sessionId) !== live || !current || current.updatedAt !== profile.updatedAt || current.env.name !== profile.env.name) {
    throw makeError('cancelled', 'The connection changed while confirmation was open. Try again.');
  }
}
