import { contextBridge, ipcRenderer } from 'electron';

// Only these channels are reachable from the renderer.
const INVOKE = new Set([
  'profiles:list', 'profiles:save', 'profiles:remove', 'profiles:test',
  'connection:open', 'connection:close',
  'meta:children', 'meta:structure', 'meta:privileges', 'meta:completion',
  'data:browse',
  'query:run', 'query:cancel', 'query:more', 'query:closeCursor',
  'write:previewInsert', 'write:insert', 'write:previewCreate', 'write:create',
  'history:list', 'history:clear', 'saved:list', 'saved:save', 'saved:remove',
  'export:run', 'export:cancel',
]);
const EVENTS = new Set(['query:phase', 'export:progress', 'menu:command']);

contextBridge.exposeInMainWorld('earthqlBridge', {
  platform: process.platform,
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
