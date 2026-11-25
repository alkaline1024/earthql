import { useEffect, useState } from 'react';
import type { UpdateStatus } from '../../../shared/api';
import { api, errorInfo } from '../api';
import { useApp } from '../store';

export function UpdateButton() {
  const [status, setStatus] = useState<UpdateStatus>({ available: false, busy: false });
  const [starting, setStarting] = useState(false);
  useEffect(() => {
    let active = true;
    let received = false;
    const off = api.updates.onStatus((next) => { received = true; if (active) setStatus(next); });
    void api.updates.status().then((next) => { if (active && !received) setStatus(next); }).catch(() => undefined);
    return () => { active = false; off(); };
  }, []);
  if (!status.available) return null;
  return (
    <div className="update-notice">
      <span className="update-available" role="status">Update available</span>
      <button type="button" className="btn small no-drag update-button" disabled={status.busy || starting}
      title="Download and install the latest EarthQL update"
      onClick={async () => {
        setStarting(true);
        try { await api.updates.install(); }
        catch (error) { useApp.getState().toast('error', errorInfo(error).message); }
        finally { setStarting(false); }
      }}>
      {status.busy || starting ? 'Updating…' : 'Update'}
      </button>
    </div>
  );
}
