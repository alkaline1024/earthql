import { useEffect, useState } from 'react';
import type { ExportResult, ExportScope } from '../../../shared/api';
import { api, errorInfo, uid } from '../api';
import { useApp } from '../store';
import { ErrorView, Modal, Spinner } from './common';

export interface ExportOption {
  id: string;
  label: string;
  detail?: string;
  /** When absent, the option is shown disabled with `unavailable` as the reason. */
  scope?: ExportScope;
  unavailable?: string;
}

export function ExportDialog({
  name,
  options,
  onClose,
  onExported,
}: {
  name: string;
  options: ExportOption[];
  onClose: () => void;
  /** Called with the option id after a successful export. */
  onExported?: (optionId: string) => void;
}) {
  const firstEnabled = options.find((o) => o.scope)?.id ?? options[0]?.id;
  const [choice, setChoice] = useState(firstEnabled);
  const [nullText, setNullText] = useState<'' | 'NULL'>('');
  const [bom, setBom] = useState(true);
  const [exportId] = useState(uid);
  const [running, setRunning] = useState(false);
  const [rows, setRows] = useState(0);
  const [result, setResult] = useState<ExportResult | null>(null);
  const toast = useApp((s) => s.toast);

  useEffect(() => api.exports.onProgress((p) => p.exportId === exportId && setRows(p.rows)), [exportId]);

  const selected = options.find((o) => o.id === choice);

  async function run() {
    if (!selected?.scope) return;
    setRunning(true);
    setResult(null);
    try {
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      const r = await api.exports.run(exportId, selected.scope, { nullText, bom, suggestedName: `${name}-${stamp}.csv` });
      setResult(r);
      if (r.status === 'ok' || (r.status !== 'dialog-cancelled' && selected.scope.kind === 'cursor')) onExported?.(selected.id);
      if (r.status === 'ok') {
        toast('ok', `Exported ${r.rows?.toLocaleString()} rows to ${r.path}`, 'Export');
        onClose();
      }
    } catch (e) {
      setResult({ status: 'error', error: errorInfo(e) });
    } finally {
      setRunning(false);
    }
  }

  return (
    <Modal
      title="Export CSV"
      narrow
      onClose={() => (running ? undefined : onClose())}
      footer={
        <>
          {running && (
            <>
              <Spinner />
              <span className="muted">{rows.toLocaleString()} rows written…</span>
            </>
          )}
          <span className="spacer" />
          {running ? (
            <button className="btn" onClick={() => void api.exports.cancel(exportId)}>
              Stop export
            </button>
          ) : (
            <>
              <button className="btn" onClick={onClose}>
                Cancel
              </button>
              <button className="btn primary" disabled={!selected?.scope} onClick={() => void run()}>
                Choose file & export…
              </button>
            </>
          )}
        </>
      }
    >
      <div className="col">
        <b>What to export</b>
        {options.map((o) => (
          <label key={o.id} className="check" style={{ alignItems: 'flex-start', opacity: o.scope ? 1 : 0.6 }}>
            <input type="radio" name="scope" checked={choice === o.id} disabled={!o.scope || running} onChange={() => setChoice(o.id)} style={{ marginTop: 3 }} />
            <span>
              {o.label}
              {o.detail && <div className="muted small">{o.detail}</div>}
              {!o.scope && o.unavailable && <div className="small" style={{ color: 'var(--warn)' }}>Not available: {o.unavailable}</div>}
            </span>
          </label>
        ))}
        <b style={{ marginTop: 8 }}>Format</b>
        <div className="row">
          <span className="muted">Write NULL as</span>
          <div className="segmented">
            <button className={nullText === '' ? 'on' : ''} onClick={() => setNullText('')}>
              empty field
            </button>
            <button className={nullText === 'NULL' ? 'on' : ''} onClick={() => setNullText('NULL')}>
              NULL
            </button>
          </div>
        </div>
        <span className="muted small">Empty strings are always written as "" so they stay distinct from NULL.</span>
        <label className="check">
          <input type="checkbox" checked={bom} onChange={(e) => setBom(e.target.checked)} /> Add UTF-8 BOM (helps Excel show Thai and other Unicode text)
        </label>
        {result?.status === 'error' && result.error && <ErrorView error={result.error} />}
        {result?.status === 'cancelled-by-user' && <div className="muted">Export stopped; the partial file was removed.</div>}
      </div>
    </Modal>
  );
}
