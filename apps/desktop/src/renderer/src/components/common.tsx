import { useEffect, type CSSProperties, type ReactNode } from 'react';
import { DRIVER_LABELS, type ConnectionProfile, type DriverId, type ErrorCategory, type ErrorInfo, type EnvironmentTag } from '@earthql/core';

export const DRIVER_META: Record<DriverId, { short: string; color: string; sub: string }> = {
  postgres: { short: 'Pg', color: '#336791', sub: 'database → schema → table' },
  mysql: { short: 'My', color: '#e48e00', sub: 'database → table' },
  databricks: { short: 'Db', color: '#ff3621', sub: 'catalog → schema → table' },
  mssql: { short: 'SS', color: '#a91d22', sub: 'database → schema → table' },
};

export function DriverIcon({ driver, size = 18 }: { driver: DriverId; size?: number }) {
  const m = DRIVER_META[driver];
  return (
    <span
      title={DRIVER_LABELS[driver]}
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size / 4),
        background: m.color,
        color: 'white',
        fontSize: Math.round(size * 0.48),
        fontWeight: 700,
        display: 'inline-grid',
        placeItems: 'center',
        flexShrink: 0,
      }}
    >
      {m.short}
    </span>
  );
}

export function EnvBadge({ env, big, busy }: { env: EnvironmentTag; big?: boolean; busy?: boolean }) {
  if (!env?.name) return null;
  return (
    <span className={`env${big ? ' big' : ''}`} aria-busy={busy} title={busy ? "Reconnecting" : undefined} style={{ '--env': env.color } as CSSProperties}>
      {env.name}
    </span>
  );
}

export function Spinner() {
  return <span className="spinner" />;
}

const CATEGORY_TITLE: Record<ErrorCategory, string> = {
  network: 'Cannot reach the server',
  tls: 'TLS / certificate problem',
  auth: 'Sign-in failed',
  permission: 'Not allowed',
  not_found: 'Not found',
  syntax: 'SQL error',
  constraint: 'Rejected by the database',
  cancelled: 'Cancelled',
  timeout: 'Timed out',
  outcome_unknown: 'Result unknown — connection lost during a write',
  config: 'Check the settings',
  unsupported: 'Not supported',
  unknown: 'Error',
};

const CATEGORY_ICON: Partial<Record<ErrorCategory, string>> = {
  network: '⚡︎',
  tls: '🔒',
  auth: '🔑',
  permission: '⛔︎',
  cancelled: '⏹',
  outcome_unknown: '⚠︎',
};

export function categoryTitle(c: ErrorCategory): string {
  return CATEGORY_TITLE[c] ?? 'Error';
}

export function ErrorView({ error, actions, compact, onDismiss }: { error: ErrorInfo; actions?: ReactNode; compact?: boolean; onDismiss?: () => void }) {
  const tone = error.category === 'cancelled' ? 'info' : error.category === 'outcome_unknown' || error.category === 'permission' ? 'warn' : '';
  return (
    <div className={`errbox ${tone}`}>
      <div className="e-ico">{CATEGORY_ICON[error.category] ?? '✕'}</div>
      <div className="grow">
        <div className="e-title">{categoryTitle(error.category)}</div>
        <div className="e-msg">{error.message}</div>
        {!compact && error.hint && <div className="e-hint">{error.hint}</div>}
        {error.code && <div className="e-code">Code: {error.code}</div>}
        {actions && <div className="row" style={{ marginTop: 8 }}>{actions}</div>}
      </div>
      {onDismiss && (
        <button type="button" className="btn ghost icon e-dismiss" aria-label="Dismiss" title="Dismiss" onClick={onDismiss}>
          ✕
        </button>
      )}
    </div>
  );
}

export function StateView({ icon, title, children }: { icon?: string; title: string; children?: ReactNode }) {
  return (
    <div className="state">
      {icon && <div className="big-ico">{icon}</div>}
      <h3>{title}</h3>
      {children}
    </div>
  );
}

export function Modal({
  title,
  onClose,
  children,
  footer,
  narrow,
  headExtra,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  narrow?: boolean;
  headExtra?: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal${narrow ? ' narrow' : ''}`} role="dialog" aria-modal="true">
        <div className="modal-head">
          <h2>{title}</h2>
          {headExtra}
          <span className="spacer" />
          <button className="btn ghost icon" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

/** Shown at every write confirmation: which connection, which environment, which target. */
export function ConfirmTarget({ profile, action, target }: { profile: ConnectionProfile; action: string; target: string }) {
  const prod = /prod/i.test(profile.env.name);
  return (
    <div className={`confirm-target${prod ? ' prod' : ''}`} style={{ '--env': profile.env.color } as CSSProperties}>
      <span className="k">Action</span>
      <b>{action}</b>
      <span className="k">Connection</span>
      <span className="row">
        <DriverIcon driver={profile.driver} size={16} />
        <b>{profile.name}</b>
        <EnvBadge env={profile.env} />
      </span>
      <span className="k">Target</span>
      <code>{target}</code>
    </div>
  );
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)} s`;
  const m = Math.floor(ms / 60000);
  return `${m}m ${Math.round((ms % 60000) / 1000)}s`;
}

export function plural(n: number, word: string): string {
  return `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
}
