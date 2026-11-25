import { app, BrowserWindow, dialog, type MessageBoxOptions } from 'electron';
import { execFile, spawn } from 'node:child_process';
import { copyFile, lstat, mkdtemp, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { downloadUpdate, getUpdateManifest, isNewerVersion, readUpdateRelease, releaseKey, type UpdateRelease } from './update-release';

declare const __EARTHQL_UPDATE_PUBLIC_KEY__: string;

const run = promisify(execFile);
const bundleId = 'com.earthql.app';
const plistBuddy = '/usr/libexec/PlistBuddy';

async function prepareUpdate(installed: string, release: UpdateRelease, progress: (fraction: number) => void) {
  if (path.extname(installed) !== '.app' || installed !== await realpath(installed) ||
    installed.startsWith('/Volumes/') || installed.includes('/AppTranslocation/')) {
    throw new Error('Move EarthQL.app to Applications and open it from there before updating.');
  }
  const stage = await mkdtemp(path.join(path.dirname(installed), '.earthql-update-')).catch(() => {
    throw new Error('EarthQL cannot write beside the installed app. Move it to a writable Applications folder.');
  });
  try {
    const zip = path.join(stage, release.file);
    const extracted = path.join(stage, 'extracted');
    await downloadUpdate(release, zip, progress);
    await run('/usr/bin/ditto', ['-x', '-k', zip, extracted], { timeout: 120000 });
    const candidate = path.join(extracted, 'EarthQL.app');
    if (!(await lstat(candidate)).isDirectory()) throw new Error('The update archive contains no EarthQL app.');
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', candidate], { timeout: 120000 });
    const plist = path.join(candidate, 'Contents', 'Info.plist');
    const read = async (key: string) => (await run(plistBuddy, ['-c', `Print ${key}`, plist])).stdout.trim();
    if (await read('CFBundleIdentifier') !== bundleId || await read('CFBundleShortVersionString') !== release.version) {
      throw new Error('The update bundle does not match the signed EarthQL release.');
    }
    await copyFile(path.join(process.resourcesPath, 'install-update.sh'), path.join(stage, 'install-update.sh'));
    await rm(zip);
    return stage;
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
}

async function handOffUpdate(installed: string, stage: string) {
  const child = spawn('/bin/bash', [path.join(stage, 'install-update.sh'), String(process.pid), installed, stage, app.getVersion()], {
    cwd: '/',
    detached: true,
    stdio: 'ignore',
  });
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  child.unref();
}

export function createUpdateCheck(beforeRestart: () => Promise<void>, restartFailed: () => void): (() => void) | undefined {
  if (process.platform !== 'darwin' || process.arch !== 'arm64' || !app.isPackaged || !__EARTHQL_UPDATE_PUBLIC_KEY__) return;
  const key = releaseKey(__EARTHQL_UPDATE_PUBLIC_KEY__);
  let busy = false;
  let restarting = false;

  function message(options: MessageBoxOptions) {
    const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    return window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options);
  }

  function progress(value: number) {
    for (const window of BrowserWindow.getAllWindows()) window.setProgressBar(value);
  }

  async function check() {
    if (busy || restarting) return;
    busy = true;
    let stage: string | undefined;
    try {
      const release = readUpdateRelease(await getUpdateManifest(), key);
      if (!isNewerVersion(release.version, app.getVersion())) {
        await message({ type: 'info', message: 'EarthQL is up to date.', detail: `Installed version ${app.getVersion()}.` });
        return;
      }
      const choice = await message({
        type: 'info', message: `EarthQL ${release.version} is available.`,
        buttons: ['Download Update', 'Later'], defaultId: 0, cancelId: 1,
      });
      if (choice.response !== 0) return;
      progress(2);
      const installed = path.resolve(process.resourcesPath, '../..');
      stage = await prepareUpdate(installed, release, progress);
      progress(-1);
      const install = await message({
        type: 'info', message: `EarthQL ${release.version} is ready to install.`,
        detail: 'Save any pending cell edits or SQL before restarting.',
        buttons: ['Restart and Install', 'Cancel'], defaultId: 0, cancelId: 1,
      });
      if (install.response !== 0) return;
      restarting = true;
      await beforeRestart();
      await handOffUpdate(installed, stage);
      stage = undefined;
      app.quit();
    } catch (error) {
      if (restarting) {
        restarting = false;
        restartFailed();
      }
      await message({
        type: 'error', message: 'Could not update EarthQL.',
        detail: error instanceof Error ? error.message.split('\n')[0] : 'Check your connection and try again.',
      });
    } finally {
      progress(-1);
      if (stage) await rm(stage, { recursive: true, force: true }).catch(() => undefined);
      busy = false;
    }
  }

  return () => { void check(); };
}
