import { app, BrowserWindow, dialog, type MessageBoxOptions } from 'electron';
import { autoUpdater } from 'electron-updater';

export function createUpdateCheck(beforeRestart: () => Promise<void>, restartFailed: () => void): (() => void) | undefined {
  if (process.platform !== 'darwin' || !app.isPackaged) return;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowPrerelease = false;

  let busy = false;
  let restarting = false;
  let downloadedVersion: string | undefined;

  function message(options: MessageBoxOptions) {
    const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    return window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options);
  }

  function progress(value: number) {
    for (const window of BrowserWindow.getAllWindows()) window.setProgressBar(value);
  }

  function recoverFromRestartFailure() {
    restarting = false;
    downloadedVersion = undefined;
    restartFailed();
  }

  // On macOS, native signature verification can fail after quitAndInstall returns.
  autoUpdater.on('error', () => {
    if (!restarting) return;
    recoverFromRestartFailure();
    void message({ type: 'error', message: 'The update could not be installed.', detail: 'Try again or download the new version from EarthQL Releases.' });
  });

  async function download(version: string) {
    const choice = await message({
      type: 'info', message: `EarthQL ${version} is available.`,
      detail: `You’re using version ${app.getVersion()}.`,
      buttons: ['Download Update', 'Later'], defaultId: 0, cancelId: 1,
    });
    if (choice.response !== 0) return;
    const onProgress = ({ percent }: { percent: number }) => progress(Math.max(0, Math.min(1, percent / 100)));
    progress(2);
    autoUpdater.on('download-progress', onProgress);
    try {
      await autoUpdater.downloadUpdate();
      downloadedVersion = version;
    } finally {
      autoUpdater.removeListener('download-progress', onProgress);
      progress(-1);
    }
  }

  async function check() {
    if (busy || restarting) return;
    busy = true;
    try {
      if (!downloadedVersion) {
        const result = await autoUpdater.checkForUpdates();
        if (!result?.isUpdateAvailable) {
          await message({ type: 'info', message: 'EarthQL is up to date.', detail: `Installed version ${app.getVersion()}.` });
          return;
        }
        await download(result.updateInfo.version);
      }
      if (!downloadedVersion) return;

      const choice = await message({
        type: 'info', message: `EarthQL ${downloadedVersion} is ready to install.`,
        detail: 'Save any unsaved SQL before restarting.',
        buttons: ['Restart and Install', 'Later'], defaultId: 0, cancelId: 1,
      });
      if (choice.response !== 0) return;
      restarting = true;
      await beforeRestart();
      autoUpdater.quitAndInstall();
    } catch {
      if (restarting) recoverFromRestartFailure();
      await message({ type: 'error', message: 'Could not update EarthQL.', detail: 'Check your connection and try Check for Updates again.' });
    } finally {
      busy = false;
    }
  }

  return () => { void check(); };
}
