import { useEffect, useRef, useState, type ReactNode } from 'react';
import { connectionName, profileOf, useApp } from '../store';
import { DriverIcon, EnvBadge } from './common';

/** Shows, for every tab, which connection (and environment) and which target it works against. */
export function ContextBar({ profileId, target, kindLabel, children, onConnectionChange, connectionDisabled }: { profileId: string; target: ReactNode; kindLabel?: string; children?: ReactNode; onConnectionChange?: (id: string) => void; connectionDisabled?: boolean }) {
  useApp((s) => s.profiles); // re-render on profile rename
  const p = profileOf(profileId)?.profile;
  const lost = useApp((s) => s.connections[profileId]?.status === 'lost');
  const connections = useApp((s) => s.connections);
  const connect = useApp((s) => s.connect);
  const [open, setOpen] = useState(false);
  const picker = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    picker.current?.querySelector<HTMLButtonElement>('[aria-current="true"]')?.focus();
    const dismiss = (event: PointerEvent) => {
      if (!picker.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [open]);
  if (!p) return null;
  const label = <><DriverIcon driver={p.driver} size={16} /><b>{connectionName(profileId)}</b><EnvBadge env={p.env} /></>;
  return (
    <>
      <div className="ctxbar">
        <div className="crumbs">
          {onConnectionChange ? <span className="ctx-connection-picker" ref={picker}
            onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && open) {
                event.preventDefault();
                event.stopPropagation();
                setOpen(false);
                trigger.current?.focus();
              }
              if (!open || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
              event.preventDefault();
              const options = Array.from(picker.current?.querySelectorAll<HTMLButtonElement>('.ctx-connection-menu button') ?? []);
              const index = options.indexOf(document.activeElement as HTMLButtonElement);
              options[(index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length]?.focus();
            }}>
            <button ref={trigger} type="button" className="ctx-connection-trigger" aria-label={`Query connection: ${connectionName(profileId)}`}
              aria-expanded={open} disabled={connectionDisabled} onClick={() => setOpen(!open)}>
              {label}<span aria-hidden="true" className="ctx-connection-chevron" />
            </button>
            {open && <span className="ctx-connection-menu" role="group" aria-label="Open connections">
              {Object.entries(connections).filter(([id, connection]) => id === profileId || connection.status === 'connected').map(([id]) => {
                const profile = profileOf(id)?.profile;
                if (!profile) return null;
                return <button key={id} type="button" aria-current={id === profileId} onClick={() => {
                  setOpen(false);
                  trigger.current?.focus();
                  onConnectionChange(id);
                }}>
                  <DriverIcon driver={profile.driver} size={16} />
                  <span className="ctx-connection-name">{connectionName(id)}</span>
                  <EnvBadge env={profile.env} />
                  {id === profileId && <span aria-hidden="true">✓</span>}
                </button>;
              })}
            </span>}
          </span> : <span className="ctx-connection-label">{label}</span>}
          <span className="sep">›</span>
          {kindLabel && <span className="muted">{kindLabel}</span>}
          <span className="mono" style={{ color: 'var(--text)' }}>
            {target}
          </span>
        </div>
        <span className="spacer" />
        {children}
      </div>
      {lost && (
        <div className="banner">
          <span>⚡︎</span>
          <span className="grow">The connection to {connectionName(profileId)} was lost. Results shown may be out of date.</span>
          <button className="btn small" onClick={() => void connect(profileId)}>
            Reconnect
          </button>
        </div>
      )}
    </>
  );
}
