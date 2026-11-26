import { api, errorInfo } from '../api';
import { useApp } from '../store';
import { Modal } from './common';

/** Summarizes exported object names like "a, b and 8 more" for the progress dialog. */
export function exportSummary(names: string[]): string {
  if (names.length <= 3) return names.join(', ');
  return `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
}

export function ExportProgressModal({ title, summary, rows, total, stopping, onStop, onBackground }: {
  title: string;
  summary: string;
  rows: number;
  total?: number;
  stopping: boolean;
  onStop: () => void;
  onBackground: () => void;
}) {
  return (
    <Modal narrow title={title} onClose={() => undefined} footer={<>
      <button className="btn" disabled={stopping} onClick={onStop}>{stopping ? 'Stopping…' : 'Stop'}</button>
      <span className="spacer" />
      <button className="btn primary" onClick={onBackground}>Export in Background</button>
    </>}>
      <div className="export-progress">
        <div className="export-progress-row">
          <span className="export-progress-names" title={summary}>{summary}</span>
          <span className="muted">{total !== undefined ? `${rows.toLocaleString()}/${total.toLocaleString()} rows` : `${rows.toLocaleString()} rows`}</span>
        </div>
        {total !== undefined
          ? <progress className="export-progress-bar" value={Math.min(rows, total)} max={Math.max(total, 1)} />
          : <progress className="export-progress-bar" />}
      </div>
    </Modal>
  );
}

export function ExportSuccessModal({ path, onClose }: { path?: string; onClose: () => void }) {
  const setExportSuccessDialog = useApp((state) => state.setExportSuccessDialog);
  const toast = useApp((state) => state.toast);
  return (
    <Modal narrow title="Success" onClose={onClose}>
      <p>Export completed successfully</p>
      <div className="export-success-actions">
        {path && <button className="btn primary" autoFocus onClick={() => { void api.revealFile(path).catch((error) => toast('error', errorInfo(error).message)); onClose(); }}>Open containing folder</button>}
        <button className="btn" onClick={onClose}>Close</button>
        <button className="btn" onClick={() => { setExportSuccessDialog(false); onClose(); }}>Don’t show this again</button>
      </div>
    </Modal>
  );
}
