import type { ErrorInfo } from '@earthql/core';
import type { EarthQLApi, IpcResult } from '../../shared/api';

export class AppError extends Error {
  constructor(readonly info: ErrorInfo) {
    super(info.message);
  }
}

export function errorInfo(e: unknown): ErrorInfo {
  if (e instanceof AppError) return e.info;
  return { category: 'unknown', message: String((e as any)?.message ?? e) };
}

const bridge = window.earthqlBridge;

async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  const r = (await bridge.invoke(channel, ...args)) as IpcResult<T>;
  if (!r.ok) throw new AppError(r.error);
  return r.value;
}

export const api: EarthQLApi = {
  platform: bridge.platform,
  updates: {
    status: () => call('updates:status'),
    install: () => call('updates:install'),
    onStatus: (cb) => bridge.on('updates:status', cb as any),
  },
  keybindings: {
    apply: (overrides, suspended = false) => call('keybindings:apply', { overrides, suspended }),
  },
  groupFiles: {
    read: () => call('groupFiles:read'),
    save: (text) => call('groupFiles:save', text),
  },
  profiles: {
    setDefaultDatabase: (id, database) => call('profiles:setDefaultDatabase', id, database),
    list: () => call('profiles:list'),
    importTablePlus: (password) => call('profiles:importTablePlus', password),
    exportTablePlus: (profileId, password) => call('profiles:exportTablePlus', profileId, password),
    save: (p, s) => call('profiles:save', p, s),
    remove: (id) => call('profiles:remove', id),
    test: (p, s) => call('profiles:test', p, s),
    databases: (p, s) => call('profiles:databases', p, s),
  },
  connection: {
    open: (id) => call('connection:open', id),
    openSeparate: (id, name) => call('connection:openSeparate', id, name),
    reconnect: (id) => call('connection:reconnect', id),
    close: (id) => call('connection:close', id),
    closeProfile: (id) => call('connection:closeProfile', id),
  },
  meta: {
    children: (id, node) => call('meta:children', id, node),
    structure: (id, o, refresh) => call('meta:structure', id, o, refresh),
    privileges: (id, o) => call('meta:privileges', id, o),
    completion: (id, ctx) => call('meta:completion', id, ctx),
  },
  data: {
    browse: (id, req) => call('data:browse', id, req),
    previewBrowse: (id, req) => call('data:previewBrowse', id, req),
  },
  query: {
    run: (id, runId, sql, ctx, limit) => call('query:run', id, runId, sql, ctx, limit),
    cancel: (runId) => call('query:cancel', runId),
    more: (cursorId, n) => call('query:more', cursorId, n),
    closeCursor: (cursorId) => call('query:closeCursor', cursorId),
    onPhase: (cb) => bridge.on('query:phase', cb as any),
    saveFile: (sql, suggestedName) => call('query:saveFile', sql, suggestedName),
    rowsAsInsert: (id, object, columns, rows) => call('query:rowsAsInsert', id, object, columns, rows),
  },
  write: {
    previewInsert: (id, spec) => call('write:previewInsert', id, spec),
    insert: (id, spec) => call('write:insert', id, spec),
    updateCells: (id, object, rows) => call('write:updateCells', id, object, rows),
    saveGrid: (id, object, changes) => call('write:saveGrid', id, object, changes),
    deleteRows: (id, object, rows) => call('write:deleteRows', id, object, rows),
    previewCreate: (id, spec) => call('write:previewCreate', id, spec),
    create: (id, spec) => call('write:create', id, spec),
  },
  history: {
    list: (id) => call('history:list', id),
    clear: (id) => call('history:clear', id),
  },
  saved: {
    list: (id) => call('saved:list', id),
    save: (id, q) => call('saved:save', id, q),
    remove: (id, qid) => call('saved:remove', id, qid),
  },
  tableActions: { saveStructure: (id, object, edits) => call('tableActions:saveStructure', id, object, edits), run: (profileId, request) => call('tableActions:run', profileId, request) },
  tableFiles: {
    export: (id, profileId, items, options) => call('tableFiles:export', id, profileId, items, options),
    read: (profileId, object, format, options) => call('tableFiles:read', profileId, object, format, options),
    import: (token, mapping, emptyAsNull) => call('tableFiles:import', token, mapping, emptyAsNull),
    release: (token) => call('tableFiles:release', token),
    cancel: (id) => call('tableFiles:cancel', id),
  },
  exports: {
    run: (exportId, scope, opts) => call('export:run', exportId, scope, opts),
    cancel: (exportId) => call('export:cancel', exportId),
    onProgress: (cb) => bridge.on('export:progress', cb as any),
  },
  feedback: {
    settings: () => call('feedback:settings'),
    saveSettings: (url, key) => call('feedback:saveSettings', url, key),
    capture: () => call('feedback:capture'),
    submit: (draft) => call('feedback:submit', draft),
  },
};

export function onMenuCommand(cb: (cmd: string) => void): () => void {
  return bridge.on('menu:command', cb as any);
}

export const uid = () => crypto.randomUUID();
