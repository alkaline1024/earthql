import { app, BrowserWindow, Menu, shell, ipcMain } from 'electron';
import path from 'node:path';
import { registerIpc } from './ipc';
import { SessionManager } from './sessions';
import { createUpdateCheck } from './updates';

app.setName('EarthQL');

let mainWindow: BrowserWindow | null = null;
const sessions = new SessionManager((channel, payload) => {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel, payload);
});

let allowWindowClose = false;
let quitRequested = false;
app.on('before-quit', () => { quitRequested = true; });
ipcMain.on('window:closeConfirmed', (event, discard: unknown) => {
  if (discard !== true) { quitRequested = false; return; }
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window) return;
  allowWindowClose = true;
  if (quitRequested) app.quit();
  else window.close();
});

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 600,
    title: 'EarthQL',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    vibrancy: 'sidebar',
    visualEffectState: 'followWindow',
    backgroundColor: '#00000000',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  allowWindowClose = false;
  mainWindow.on('close', (event) => {
    if (allowWindowClose) return;
    event.preventDefault();
    mainWindow?.webContents.send('menu:command', 'close-window');
  });

  mainWindow.once('ready-to-show', () => mainWindow?.show());

  // Never navigate the app window away; open links in the default browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (url !== mainWindow?.webContents.getURL()) e.preventDefault();
  });

  if (process.env.ELECTRON_RENDERER_URL) void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
}

function buildMenu(): void {
  const send = (cmd: string) => () => mainWindow?.webContents.send('menu:command', cmd);
  const checkForUpdates = createUpdateCheck(async () => {
    quitting = true;
    await closeSessionsForQuit();
  }, () => { quitting = false; });
  if (!checkForUpdates) {
    ipcMain.handle('updates:status', () => ({ ok: true, value: { available: false, busy: false } }));
    ipcMain.handle('updates:install', () => ({ ok: true, value: undefined }));
  }
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Preferences…', accelerator: 'Cmd+,', click: send('open-settings') },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        { label: 'New Connection…', accelerator: 'CmdOrCtrl+Shift+N', click: send('new-connection') },
        { label: 'New SQL Editor Tab', accelerator: 'CmdOrCtrl+T', click: send('new-sql-tab') },
        { type: 'separator' },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: send('close-tab') },
        { label: 'Close All Tabs', accelerator: 'CmdOrCtrl+Shift+W', click: send('close-all-tabs') },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'Query',
      submenu: [
        { label: 'Run Current', accelerator: 'CmdOrCtrl+Enter', click: send('run') },
        { label: 'Run All', accelerator: 'CmdOrCtrl+Shift+Enter', click: send('run-all') },
        { label: 'Cancel', accelerator: 'CmdOrCtrl+.', click: send('cancel') },
        { type: 'separator' },
        { label: 'Beautify', accelerator: 'CmdOrCtrl+I', click: send('beautify') },
        { type: 'separator' },
        { label: 'Add to Queries', accelerator: 'CmdOrCtrl+S', click: send('save') },
        { label: 'Save SQL as…', accelerator: 'CmdOrCtrl+Shift+S', click: send('save-sql-file') },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Refresh', accelerator: 'CmdOrCtrl+R', click: send('refresh') },
        { type: 'separator' },
        { role: 'toggleDevTools' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
    { role: 'help', submenu: [
      { label: 'Check for Updates…', enabled: !!checkForUpdates, click: checkForUpdates },
      { label: 'Send Feedback…', click: send('send-feedback') },
    ] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  if (!app.isPackaged) {
    app.dock?.setIcon(path.join(app.getAppPath(), 'src', 'renderer', 'public', 'earthql.png'));
  }
  registerIpc(sessions);
  buildMenu();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

let quitting = false;
function closeSessionsForQuit() {
  // Close database sessions (Databricks sessions, pooled connections) but never hang the quit.
  return Promise.race([sessions.closeAll().catch(() => undefined), new Promise<void>((resolve) => setTimeout(resolve, 3000))]);
}

app.on('will-quit', (e) => {
  if (quitting) return;
  quitting = true;
  e.preventDefault();
  void closeSessionsForQuit().then(() => app.quit());
});

// Quit cleanly (closing database sessions) when the process is asked to stop from outside.
for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => app.quit());

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
