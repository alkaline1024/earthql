import { useEffect, useRef, useState } from 'react';
import type { ErrorInfo } from '@earthql/core';
import { FEEDBACK_MAX_DESCRIPTION, FEEDBACK_MAX_TITLE, type FeedbackKind, type FeedbackSettings } from '../../../shared/feedback';
import { api, errorInfo, uid } from '../api';
import { ErrorView, Modal, Spinner } from './common';
import { FeedbackScreenshot } from './FeedbackScreenshot';

export function FeedbackDialog({ screenshot, onClose }: { screenshot: string | null; onClose: () => void }) {
  const [id] = useState(uid);
  const [kind, setKind] = useState<FeedbackKind>('bug');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [image, setImage] = useState(screenshot);
  const [attach, setAttach] = useState(false);
  const [settings, setSettings] = useState<FeedbackSettings>();
  const [showSettings, setShowSettings] = useState(false);
  const [url, setUrl] = useState('');
  const [key, setKey] = useState('');
  const [error, setError] = useState<ErrorInfo>();
  const [pending, setPending] = useState(false);
  const [receipt, setReceipt] = useState<string>();
  const busy = useRef(false);
  const ready = !!settings?.endpoint && (settings.bundled || settings.hasKey);

  useEffect(() => {
    let active = true;
    api.feedback.settings().then((value) => {
      if (!active) return;
      setSettings(value);
      setUrl(value.endpoint);
      setShowSettings(!value.bundled && !value.hasKey);
    }).catch((e: unknown) => {
      if (active) { setError(errorInfo(e)); setShowSettings(true); }
    });
    return () => { active = false; };
  }, []);

  async function perform(action: () => Promise<void>) {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError(undefined);
    try { await action(); }
    catch (e) { setError(errorInfo(e)); }
    finally { busy.current = false; setPending(false); }
  }

  function saveSettings() {
    void perform(async () => {
      const value = await api.feedback.saveSettings(url, key);
      setSettings(value);
      setUrl(value.endpoint);
      setKey('');
      setShowSettings(false);
    });
  }

  function send() {
    if (!ready || !title.trim() || !description.trim()) return;
    void perform(async () => {
      const result = await api.feedback.submit({ id, kind, title, description, screenshot: attach ? image ?? undefined : undefined });
      setReceipt(result.id);
      setImage(null);
    });
  }

  return (
    <Modal title="Send Feedback" onClose={() => { if (!busy.current) onClose(); }} footer={
      <>
        {pending && <Spinner />}
        <span className="spacer" />
        <button className="btn" disabled={pending} onClick={onClose}>{receipt ? 'Done' : 'Cancel'}</button>
        {!receipt && <button className="btn primary" disabled={pending || (showSettings ? !url.trim() : !ready || !title.trim() || !description.trim())}
          onClick={showSettings ? saveSettings : send}>{showSettings ? 'Save Settings' : 'Send Feedback'}</button>}
      </>
    }>
      {receipt ? (
        <div className="col" role="status">
          <b>Feedback sent</b>
          <span>Reference <code>{receipt}</code></span>
        </div>
      ) : (
        <div className="col feedback-form">
          <div className="row">
            <b>{showSettings ? 'Feedback Settings' : 'Tell us what happened or what could improve'}</b>
            <span className="spacer" />
            {!settings?.bundled && (
              <button className="btn small ghost" disabled={pending} onClick={() => { setShowSettings(!showSettings); setError(undefined); setKey(''); }}>
                {showSettings ? 'Back to report' : 'Feedback Settings'}
              </button>
            )}
          </div>
          {showSettings ? (
            <>
              <label className="col">Apps Script Web App URL
                <input className="input" type="url" value={url} disabled={pending} onChange={(e) => setUrl(e.target.value)} placeholder="https://script.google.com/macros/s/…/exec" />
              </label>
              <label className="col">Submission key
                <input className="input" type="password" autoComplete="off" value={key} disabled={pending} onChange={(e) => setKey(e.target.value)}
                  placeholder={ready && url.trim() === settings?.endpoint ? 'Stored in Keychain' : '64-character key from your Apps Script setup'} />
              </label>
              <span className="small muted">Use the same key as the FEEDBACK_KEY script property. EarthQL stores it in macOS Keychain.</span>
            </>
          ) : (
            <>
              <label className="col">Type
                <select className="input" value={kind} disabled={pending} onChange={(e) => setKind(e.target.value === 'suggestion' ? 'suggestion' : 'bug')}>
                  <option value="bug">Bug</option><option value="suggestion">Suggestion</option>
                </select>
              </label>
              <label className="col">Title
                <input className="input" value={title} maxLength={FEEDBACK_MAX_TITLE} disabled={pending} onChange={(e) => setTitle(e.target.value)} />
              </label>
              <label className="col">Description
                <textarea className="input" value={description} rows={4} maxLength={FEEDBACK_MAX_DESCRIPTION} disabled={pending} onChange={(e) => setDescription(e.target.value)} />
              </label>
              {image ? (
                <>
                  <div className="row">
                    <label className="check">
                      <input type="checkbox" checked={attach} disabled={pending} onChange={(e) => setAttach(e.target.checked)} /> Attach screenshot
                    </label>
                    <span className="spacer" />
                    <button className="btn small ghost" disabled={pending} onClick={() => { setImage(null); setAttach(false); }}>Remove screenshot</button>
                  </div>
                  <FeedbackScreenshot image={image} onEdit={(value) => { setImage(value); setAttach(false); }} disabled={pending}
                    onReset={image !== screenshot && screenshot ? () => { setImage(screenshot); setAttach(false); } : undefined} />
                </>
              ) : <span className="small muted">This report will be sent without a screenshot.</span>}
              {!ready && <span className="small muted">Enter the URL and submission key in Feedback Settings to enable sending.</span>}
            </>
          )}
          {error && <ErrorView error={error} />}
        </div>
      )}
    </Modal>
  );
}
