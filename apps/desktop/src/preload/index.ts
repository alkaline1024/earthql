import { contextBridge, ipcRenderer } from 'electron';

// Only these channels are reachable from the renderer.
const INVOKE = new Set([
  'updates:status', 'updates:install',
  'profiles:list', 'profiles:save', 'profiles:remove', 'profiles:test',
  'profiles:importTablePlus', 'profiles:exportTablePlus',
  'connection:open', 'connection:close',
  'connection:openSeparate', 'connection:reconnect', 'connection:closeProfile',
  'meta:children', 'meta:structure', 'meta:privileges', 'meta:completion',
  'data:browse',
  'query:run', 'query:cancel', 'query:more', 'query:closeCursor', 'query:saveFile',
  'write:previewInsert', 'write:insert', 'write:previewCreate', 'write:create',
  'write:updateCells',
  'history:list', 'history:clear', 'saved:list', 'saved:save', 'saved:remove',
  'export:run', 'export:cancel',
  'tableActions:run',
  'tableFiles:export', 'tableFiles:read', 'tableFiles:import', 'tableFiles:release', 'tableFiles:cancel',
  'feedback:settings', 'feedback:saveSettings', 'feedback:capture', 'feedback:submit',
]);
const EVENTS = new Set(['updates:status', 'query:phase', 'export:progress', 'menu:command']);

contextBridge.exposeInMainWorld('earthqlBridge', {
  platform: process.platform,
  closeWindow: (discard: boolean) => ipcRenderer.send('window:closeConfirmed', discard),
  invoke(channel: string, ...args: unknown[]) {
    if (!INVOKE.has(channel)) return Promise.reject(new Error(`Blocked IPC channel: ${channel}`));
    return ipcRenderer.invoke(channel, ...args);
  },
  on(channel: string, cb: (payload: unknown) => void) {
    if (!EVENTS.has(channel)) throw new Error(`Blocked IPC event: ${channel}`);
    const listener = (_e: unknown, payload: unknown) => cb(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
