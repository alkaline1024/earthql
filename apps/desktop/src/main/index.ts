import { app, BrowserWindow, Menu, shell, ipcMain } from 'electron';
import path from 'node:path';
import { registerIpc } from './ipc';
import { SessionManager } from './sessions';
import { createUpdateCheck } from './updates';
import { SHORTCUTS, effectiveAccelerator, matchesAccelerator, sanitizeOverrides, type KeybindingOverrides } from '../shared/keybindings';

app.setName('EarthQL');
// Chromium's swipe-to-navigate-pages gesture intercepts two-finger horizontal trackpad
// swipes over scrollable content (e.g. the data grid), making horizontal scrolling feel
// broken. There is no in-app page history to navigate, so disable it outright.
app.commandLine.appendSwitch('disable-features', 'OverscrollHistoryNavigation');

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

  // Handle Reconnect before the focused editor or Chromium can consume the key.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (keybindingsSuspended || input.type !== 'keyDown') return;
    const accelerator = effectiveAccelerator('reconnect', keybindings);
    const key = {
      key: input.key,
      code: input.code,
      metaKey: input.meta,
      ctrlKey: input.control,
      altKey: input.alt,
      shiftKey: input.shift,
    };
    if (!matchesAccelerator(key, accelerator, process.platform === 'darwin')) return;
    event.preventDefault();
    if (!input.isAutoRepeat) mainWindow?.webContents.send('menu:command', 'reconnect');
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

let keybindings: KeybindingOverrides = {};
// While Settings records a keystroke every accelerator is dropped, so the key reaches the page
// instead of firing the action it is currently bound to.
let keybindingsSuspended = false;
let checkForUpdates: ReturnType<typeof createUpdateCheck>;

function setupUpdates(): void {
  checkForUpdates = createUpdateCheck(async () => {
    quitting = true;
    await closeSessionsForQuit();
  }, () => { quitting = false; });
  if (!checkForUpdates) {
    ipcMain.handle('updates:status', () => ({ ok: true, value: { available: false, busy: false } }));
    ipcMain.handle('updates:install', () => ({ ok: true, value: undefined }));
  }
}

function buildMenu(): void {
  const send = (cmd: string) => () => mainWindow?.webContents.send('menu:command', cmd);
  // Every rebindable menu item comes from the keybinding registry in ../shared/keybindings.
  const item = (id: string): Electron.MenuItemConstructorOptions => {
    const def = SHORTCUTS.find((d) => d.id === id);
    if (!def?.command) throw new Error(`No menu command registered for shortcut "${id}"`);
    const accelerator = keybindingsSuspended ? null : effectiveAccelerator(id, keybindings);
    return { label: def.menuLabel ?? def.label, ...(accelerator ? { accelerator } : {}), click: send(def.command) };
  };
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        item('open-settings'),
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
        item('new-connection'),
        item('new-sql-tab'),
        item('reopen-closed-tab'),
        { type: 'separator' },
        item('close-tab'),
        item('close-all-tabs'),
      ],
    },
    { role: 'editMenu' },
    {
      label: 'Query',
      submenu: [
        item('run'),
        item('run-all'),
        item('cancel'),
        { type: 'separator' },
        item('beautify'),
        item('uglify'),
        { type: 'separator' },
        item('save'),
        item('save-sql-file'),
      ],
    },
    {
      label: 'View',
      submenu: [
        item('refresh'),
        item('reconnect'),
        { type: 'separator' },
        item('split-left'),
        item('split-right'),
        item('split-up'),
        item('split-down'),
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

ipcMain.handle('keybindings:apply', (_event, payload: unknown) => {
  try {
    const { overrides, suspended } = (payload ?? {}) as { overrides?: unknown; suspended?: unknown };
    keybindings = sanitizeOverrides(overrides);
    keybindingsSuspended = suspended === true;
    buildMenu();
    return { ok: true, value: undefined };
  } catch (error) {
    return { ok: false, error: { category: 'unknown', message: String((error as Error)?.message ?? error) } };
  }
});

app.whenReady().then(() => {
  if (!app.isPackaged) {
    app.dock?.setIcon(path.join(app.getAppPath(), 'src', 'renderer', 'public', 'earthql.png'));
  }
  registerIpc(sessions);
  setupUpdates();
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
