import type { ExportResult, TableImportResult } from '../../shared/api';
import { api, errorInfo } from './api';
import { useApp, type AppNotification } from './store';

export async function backgroundTransfer(
  id: string,
  category: 'Import' | 'Export',
  label: string,
  run: () => Promise<ExportResult | TableImportResult>,
  cancel: () => Promise<void>,
  completed?: (result: ExportResult | TableImportResult) => void,
): Promise<void> {
  await trackTransfer(id, category, label, run(), cancel, completed);
}

/** Tracks an already-running transfer in the notifications area (used to send a foreground export to the background). */
export async function trackTransfer(
  id: string,
  category: 'Import' | 'Export',
  label: string,
  running: Promise<ExportResult | TableImportResult>,
  cancel: () => Promise<void>,
  completed?: (result: ExportResult | TableImportResult) => void,
): Promise<void> {
  const update = (changes: Partial<AppNotification>) => useApp.getState().updateNotification(id, changes);
  const entry: AppNotification = {
    id, category, text: `${label} · Starting…`, timestamp: Date.now(), read: false, status: 'running',
    stop: async () => {
      update({ status: 'stopping', text: `${label} · Stopping…` });
      try { await cancel(); }
      catch (error) { update({ status: 'running', text: `${label} · ${errorInfo(error).message}` }); }
    },
  };
  useApp.setState((state) => ({ notifications: [entry, ...state.notifications] }));
  const off = api.exports.onProgress((progress) => {
    if (progress.exportId === id) update({ text: `${label} · ${progress.rows.toLocaleString()} rows` });
  });
  try {
    const result = await running;
    const message = result.status === 'ok' ? `Completed · ${result.rows?.toLocaleString() ?? 0} rows`
      : result.status === 'dialog-cancelled' ? 'Cancelled'
      : result.status === 'cancelled' || result.status === 'cancelled-by-user' ? `Stopped · ${result.rows?.toLocaleString() ?? 0} rows processed`
      : result.status === 'outcome_unknown' ? 'Outcome unknown. Check the database before trying again.'
      : result.error?.message ?? 'Failed';
    update({ status: 'done', stop: undefined, read: false, text: `${label} · ${message}`,
      path: result.status === 'ok' && 'path' in result ? result.path : undefined });
    completed?.(result);
  } catch (error) {
    update({ status: 'done', stop: undefined, read: false, text: `${label} · ${errorInfo(error).message}` });
  } finally { off(); }
}
