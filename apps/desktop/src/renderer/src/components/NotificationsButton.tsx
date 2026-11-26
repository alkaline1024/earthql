import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { Spinner } from './common';
import { useApp } from '../store';

export function NotificationsButton() {
  const notifications = useApp((state) => state.notifications);
  const markRead = useApp((state) => state.markNotificationsRead);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const active = notifications.filter((entry) => entry.status === 'running' || entry.status === 'stopping').length;
  const unread = notifications.filter((entry) => !entry.read).length;

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    window.addEventListener('pointerdown', dismiss);
    return () => window.removeEventListener('pointerdown', dismiss);
  }, [open]);

  return (
    <div className="notification-control no-drag" ref={root} onKeyDown={(event) => {
      if (event.key === 'Escape' && open) {
        event.stopPropagation();
        setOpen(false);
        trigger.current?.focus();
      }
    }}>
      <button type="button" className="btn small" ref={trigger}
        aria-expanded={open} aria-controls="notification-panel"
        onClick={() => {
          if (!open) markRead();
          setOpen(!open);
        }}>
        <svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 11h10l-1.5-2V6a3.5 3.5 0 1 0-7 0v3zM6.5 13a1.6 1.6 0 0 0 3 0" />
        </svg>
        {active > 0 && <Spinner />}
        Notifications {unread > 0 && <span className="notification-count" aria-label={`${unread} unread`}>{unread}</span>}
      </button>
      {open && <section id="notification-panel" className="notification-panel" aria-label="Notifications">
        <h2>Notifications</h2>
        {notifications.length === 0 ? <p className="muted">No notifications yet.</p> : <ul>
          {notifications.map((entry) => <li key={entry.id}>
            <div className="row"><b>{entry.category}</b><span className="spacer" /><time className="muted" dateTime={new Date(entry.timestamp).toISOString()}>
              {new Date(entry.timestamp).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })}
            </time></div>
            <div className="notification-message">{entry.status === 'running' || entry.status === 'stopping' ? <Spinner /> : null}{entry.text}</div>
            {entry.stop && <button className="btn small" disabled={entry.status === 'stopping'} onClick={() => void entry.stop?.()}>{entry.status === 'stopping' ? 'Stopping…' : 'Stop'}</button>}
            {entry.path && <button className="btn small" onClick={() => void api.revealFile(entry.path!).catch((error) => useApp.getState().toast('error', String(error)))}>Open in {/Mac/.test(navigator.platform) ? 'Finder' : 'Folder'}</button>}
          </li>)}
        </ul>}
      </section>}
    </div>
  );
}
