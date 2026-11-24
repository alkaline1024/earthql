import type { ReactNode } from 'react';
import { profileOf, useApp } from '../store';
import { DriverIcon, EnvBadge } from './common';

/** Shows, for every tab, which connection (and environment) and which target it works against. */
export function ContextBar({ profileId, target, kindLabel, children }: { profileId: string; target: ReactNode; kindLabel?: string; children?: ReactNode }) {
  useApp((s) => s.profiles); // re-render on profile rename
  const p = profileOf(profileId)?.profile;
  const lost = useApp((s) => s.connections[profileId]?.status === 'lost');
  const connect = useApp((s) => s.connect);
  if (!p) return null;
  return (
    <>
      <div className="ctxbar">
        <DriverIcon driver={p.driver} size={16} />
        <div className="crumbs">
          <b>{p.name}</b>
          <EnvBadge env={p.env} />
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
          <span className="grow">The connection to {p.name} was lost. Results shown may be out of date.</span>
          <button className="btn small" onClick={() => void connect(profileId)}>
            Reconnect
          </button>
        </div>
      )}
    </>
  );
}
