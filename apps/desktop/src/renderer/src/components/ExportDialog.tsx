import { backgroundTransfer, trackTransfer } from '../background-transfer';
import { useEffect, useRef, useState } from 'react';
import type { ExportResult, ExportScope } from '../../../shared/api';
import { api, errorInfo, uid } from '../api';
import { useApp } from '../store';
import { ErrorView, Modal } from './common';
import { ExportProgressModal, ExportSuccessModal } from './ExportProgress';

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
  const [total, setTotal] = useState<number | undefined>();
  const [phase, setPhase] = useState<'configure' | 'progress' | 'success'>('configure');
  const [stopping, setStopping] = useState(false);
  const [donePath, setDonePath] = useState<string | undefined>();
  const [result, setResult] = useState<ExportResult | null>(null);
  const inFlight = useRef<Promise<ExportResult> | null>(null);
  const backgrounded = useRef(false);
  const toast = useApp((s) => s.toast);
  const exportInBackground = useApp((s) => s.exportInBackground);
  const exportSuccessDialog = useApp((s) => s.exportSuccessDialog);

  useEffect(() => api.exports.onProgress((p) => { if (p.exportId === exportId) { setRows(p.rows); setTotal(p.total); } }), [exportId]);

  const selected = options.find((o) => o.id === choice);

  async function run() {
    if (!selected?.scope) return;
    if (running) return;
    setRunning(true);
    const scope = selected.scope;
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const start = () => api.exports.run(exportId, scope, { nullText, bom, suggestedName: `${name}-${stamp}.csv` });
    const cancel = () => api.exports.cancel(exportId);
    const notifyExported = (outcome: ExportResult) => {
      if (outcome.status === 'ok' || (outcome.status !== 'dialog-cancelled' && scope.kind === 'cursor')) onExported?.(selected.id);
    };
    if (exportInBackground) {
      void backgroundTransfer(exportId, 'Export', name, start, cancel, (outcome) => notifyExported(outcome as ExportResult));
      onClose();
      return;
    }
    setResult(null); setRows(0); setTotal(undefined); setStopping(false);
    setPhase('progress');
    const promise = start();
    inFlight.current = promise;
    let outcome: ExportResult;
    try { outcome = await promise; }
    catch (error) { outcome = { status: 'error', error: errorInfo(error) }; }
    inFlight.current = null;
    if (backgrounded.current) return;
    notifyExported(outcome);
    setRunning(false);
    setStopping(false);
    if (outcome.status === 'ok') {
      if (exportSuccessDialog) { setDonePath(outcome.path); setPhase('success'); }
      else { toast('ok', `Export completed · ${outcome.rows?.toLocaleString() ?? 0} rows`, 'Export'); onClose(); }
    } else {
      if (outcome.status !== 'dialog-cancelled') setResult(outcome);
      setPhase('configure');
    }
  }
  function toBackground() {
    if (!inFlight.current || !selected?.scope) return;
    const scope = selected.scope;
    backgrounded.current = true;
    void trackTransfer(exportId, 'Export', name, inFlight.current, () => api.exports.cancel(exportId), (outcome) => {
      const result = outcome as ExportResult;
      if (result.status === 'ok' || (result.status !== 'dialog-cancelled' && scope.kind === 'cursor')) onExported?.(selected.id);
    });
    onClose();
  }

  if (phase === 'progress') return <ExportProgressModal title="Export CSV" summary={name} rows={rows} total={total} stopping={stopping} onStop={() => { setStopping(true); void api.exports.cancel(exportId).catch(() => setStopping(false)); }} onBackground={toBackground} />;
  if (phase === 'success') return <ExportSuccessModal path={donePath} onClose={onClose} />;

  return (
    <Modal
      title="Export CSV"
      narrow
      onClose={() => (running ? undefined : onClose())}
      footer={
        <>
          <span className="spacer" />
          <button className="btn" disabled={running} onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={running || !selected?.scope} onClick={() => void run()}>
            Choose file & export…
          </button>
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
