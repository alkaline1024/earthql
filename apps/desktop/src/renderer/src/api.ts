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
  profiles: {
    list: () => call('profiles:list'),
    save: (p, s) => call('profiles:save', p, s),
    remove: (id) => call('profiles:remove', id),
    test: (p, s) => call('profiles:test', p, s),
  },
  connection: {
    open: (id) => call('connection:open', id),
    close: (id) => call('connection:close', id),
  },
  meta: {
    children: (id, node) => call('meta:children', id, node),
    structure: (id, o, refresh) => call('meta:structure', id, o, refresh),
    privileges: (id, o) => call('meta:privileges', id, o),
    completion: (id, ctx) => call('meta:completion', id, ctx),
  },
  data: { browse: (id, req) => call('data:browse', id, req) },
  query: {
    run: (id, runId, sql, ctx, limit) => call('query:run', id, runId, sql, ctx, limit),
    cancel: (runId) => call('query:cancel', runId),
    more: (cursorId, n) => call('query:more', cursorId, n),
    closeCursor: (cursorId) => call('query:closeCursor', cursorId),
    onPhase: (cb) => bridge.on('query:phase', cb as any),
  },
  write: {
    previewInsert: (id, spec) => call('write:previewInsert', id, spec),
    insert: (id, spec) => call('write:insert', id, spec),
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
  exports: {
    run: (exportId, scope, opts) => call('export:run', exportId, scope, opts),
    cancel: (exportId) => call('export:cancel', exportId),
    onProgress: (cb) => bridge.on('export:progress', cb as any),
  },
};

export function onMenuCommand(cb: (cmd: string) => void): () => void {
  return bridge.on('menu:command', cb as any);
}

export const uid = () => crypto.randomUUID();
