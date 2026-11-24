import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import {
  DRIVER_LABELS,
  secretFieldsFor,
  type ConnectionProfile,
  type DriverId,
  type EnvironmentTag,
  type SecretField,
  type Secrets,
  type TestResult,
  type TlsMode,
} from '@earthql/core';
import { api, errorInfo, uid } from '../api';
import { useApp } from '../store';
import { DRIVER_META, DriverIcon, EnvBadge, ErrorView, Spinner, formatDuration } from './common';

const ENV_PRESETS: EnvironmentTag[] = [
  { name: 'Development', color: '#2f9e5b' },
  { name: 'Staging', color: '#d48806' },
  { name: 'Production', color: '#e5484d' },
  { name: 'Local', color: '#6e56cf' },
];

const DEFAULT_PORTS: Record<DriverId, number> = { postgres: 5432, mysql: 3306, mssql: 1433, databricks: 443 };

function blankProfile(driver: DriverId): ConnectionProfile {
  const base = { id: uid(), name: '', env: ENV_PRESETS[0], createdAt: 0, updatedAt: 0 };
  switch (driver) {
    case 'postgres':
      return { ...base, driver, host: 'localhost', port: 5432, database: 'postgres', user: 'postgres', tls: { mode: 'disable' } };
    case 'mysql':
      return { ...base, driver, host: 'localhost', port: 3306, database: '', user: 'root', tls: { mode: 'disable' } };
    case 'mssql':
      return { ...base, driver, host: 'localhost', port: 1433, database: 'master', user: 'sa', tls: { mode: 'require' } };
    case 'databricks':
      return { ...base, driver, host: '', httpPath: '', authMode: 'oauth-m2m', clientId: '', catalog: '', schema: '' };
  }
}

function describe(p: ConnectionProfile): string {
  if (p.driver === 'databricks') return `${p.host || '—'} · ${p.authMode === 'oauth-m2m' ? 'OAuth M2M' : 'Access token'}`;
  return `${p.user}@${p.host}:${p.port}${'database' in p && p.database ? '/' + p.database : ''}`;
}

export function ConnectionsScreen({ initialNew }: { initialNew?: boolean }) {
  const { profiles, loadProfiles, connections, connecting, connectErrors, connect, setScreen } = useApp();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ConnectionProfile | null>(null);
  const [isNew, setIsNew] = useState(false);

  useEffect(() => {
    void loadProfiles();
  }, [loadProfiles]);

  useEffect(() => {
    if (initialNew) startNew();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialNew]);

  useEffect(() => {
    if (!selectedId && !draft && profiles.length > 0) setSelectedId(profiles[0].profile.id);
  }, [profiles, selectedId, draft]);

  function startNew() {
    setDraft(null);
    setIsNew(true);
    setSelectedId(null);
  }

  const selected = profiles.find((p) => p.profile.id === selectedId);
  const anyOpen = Object.keys(connections).length > 0;

  return (
    <div className="conn-screen">
      <div className="conn-list">
        <div className="sidebar-top drag">
          <span className="spacer" />
          {anyOpen && (
            <button className="btn small no-drag" onClick={() => setScreen('workspace')}>
              Back to workspace
            </button>
          )}
        </div>
        <div className="row" style={{ padding: '0 14px 8px' }}>
          <b style={{ fontSize: 15 }}>Connections</b>
          <span className="spacer" />
          <button className="btn small" onClick={startNew}>
            ＋ New
          </button>
        </div>
        <div className="scroll grow">
          {profiles.length === 0 && <div className="tree-msg" style={{ padding: '8px 18px' }}>No saved connections yet.</div>}
          {profiles.map(({ profile }) => (
            <div
              key={profile.id}
              className={`conn-item${profile.id === selectedId && !isNew ? ' selected' : ''}`}
              onClick={() => {
                setSelectedId(profile.id);
                setIsNew(false);
                setDraft(null);
              }}
              onDoubleClick={() => void connect(profile.id)}
            >
              <div className="c-name">
                <DriverIcon driver={profile.driver} size={16} />
                <span className="grow" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {profile.name || '(unnamed)'}
                </span>
                {connections[profile.id] && <span className="dot" style={{ background: 'var(--ok)' }} title="Connected" />}
              </div>
              <div className="row">
                <EnvBadge env={profile.env} />
                <span className="c-sub">{describe(profile)}</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="conn-detail">
        {isNew && !draft && <DriverPicker onPick={(d) => setDraft(blankProfile(d))} />}
        {isNew && draft && (
          <ProfileEditor
            key={draft.id}
            initial={draft}
            storedSecrets={[]}
            isNew
            onSaved={(p) => {
              setIsNew(false);
              setDraft(null);
              setSelectedId(p.id);
            }}
            onCancel={() => {
              setIsNew(false);
              setDraft(null);
            }}
          />
        )}
        {!isNew && selected && (
          <ProfileEditor
            key={selected.profile.id + selected.profile.updatedAt}
            initial={selected.profile}
            storedSecrets={selected.storedSecrets}
            connected={!!connections[selected.profile.id]}
            connecting={!!connecting[selected.profile.id]}
            connectError={connectErrors[selected.profile.id]}
            onConnect={() => void connect(selected.profile.id)}
            onSaved={() => undefined}
            onDeleted={() => setSelectedId(null)}
            onDuplicate={() => {
              setDraft({ ...selected.profile, id: uid(), name: `${selected.profile.name} copy` });
              setIsNew(true);
            }}
          />
        )}
        {!isNew && !selected && (
          <div className="welcome" style={{ height: '100%' }}>
            <h2>Welcome to EarthQL</h2>
            <p>Connect to PostgreSQL, MySQL, Databricks or Microsoft SQL Server.</p>
            <button className="btn primary" onClick={startNew}>
              Add a connection
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function DriverPicker({ onPick }: { onPick: (d: DriverId) => void }) {
  return (
    <div>
      <h1>New connection</h1>
      <p className="muted">Choose a database type.</p>
      <div className="driver-grid">
        {(Object.keys(DRIVER_LABELS) as DriverId[]).map((d) => (
          <div key={d} className="driver-card" onClick={() => onPick(d)}>
            <span className="d-ico" style={{ background: DRIVER_META[d].color }}>
              {DRIVER_META[d].short}
            </span>
            <b>{DRIVER_LABELS[d]}</b>
            <span className="d-sub">{DRIVER_META[d].sub}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

const SECRET_LABEL: Record<SecretField, string> = { password: 'Password', clientSecret: 'Client secret', accessToken: 'Access token' };

function ProfileEditor({
  initial,
  storedSecrets,
  isNew,
  connected,
  connecting,
  connectError,
  onConnect,
  onSaved,
  onCancel,
  onDeleted,
  onDuplicate,
}: {
  initial: ConnectionProfile;
  storedSecrets: SecretField[];
  isNew?: boolean;
  connected?: boolean;
  connecting?: boolean;
  connectError?: ReturnType<typeof errorInfo>;
  onConnect?: () => void;
  onSaved: (p: ConnectionProfile) => void;
  onCancel?: () => void;
  onDeleted?: () => void;
  onDuplicate?: () => void;
}) {
  const { loadProfiles, connect, disconnect, toast } = useApp();
  const [p, setP] = useState<ConnectionProfile>(initial);
  const [secrets, setSecrets] = useState<Secrets>({});
  const [clearSecret, setClearSecret] = useState<Partial<Record<SecretField, boolean>>>({});
  const [test, setTest] = useState<TestResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const dirty = useMemo(() => JSON.stringify(p) !== JSON.stringify(initial) || Object.values(secrets).some(Boolean) || Object.values(clearSecret).some(Boolean), [p, initial, secrets, clearSecret]);

  const set = <K extends string>(k: K, v: unknown) => setP((x) => ({ ...x, [k]: v }) as ConnectionProfile);
  const secretFields = secretFieldsFor(p as any);

  const validation = useMemo(() => {
    const errs: string[] = [];
    if (!p.name.trim()) errs.push('Name');
    if (!p.host.trim()) errs.push(p.driver === 'databricks' ? 'Server Hostname' : 'Host');
    if (p.driver === 'databricks') {
      if (!p.httpPath.trim()) errs.push('HTTP Path');
      if (p.authMode === 'oauth-m2m' && !p.clientId?.trim()) errs.push('Client ID');
      if (p.authMode === 'oauth-m2m' && !secrets.clientSecret && !storedSecrets.includes('clientSecret')) errs.push('Client secret');
      if (p.authMode === 'access-token' && !secrets.accessToken && !storedSecrets.includes('accessToken')) errs.push('Access token');
    } else {
      if (!p.user.trim()) errs.push('Username');
      if ((p.driver === 'postgres' || p.driver === 'mssql') && !p.database.trim()) errs.push('Database');
    }
    return errs;
  }, [p, secrets, storedSecrets]);

  const secretsToSend = (): Secrets => {
    const out: Secrets = {};
    for (const f of secretFields) {
      if (secrets[f]) out[f] = secrets[f];
      else if (clearSecret[f]) out[f] = '';
    }
    return out;
  };

  async function runTest() {
    setTesting(true);
    setTest(null);
    try {
      setTest(await api.profiles.test(p, secretsToSend()));
    } catch (e) {
      setTest({ ok: false, steps: [], error: errorInfo(e) });
    } finally {
      setTesting(false);
    }
  }

  async function save(andConnect = false) {
    setSaveErr(null);
    if (validation.length) {
      setSaveErr(`Fill in: ${validation.join(', ')}`);
      return;
    }
    setSaving(true);
    try {
      const s = await api.profiles.save({ ...p, name: p.name.trim(), host: p.host.trim() } as ConnectionProfile, secretsToSend());
      await loadProfiles();
      setSecrets({});
      setClearSecret({});
      onSaved(s.profile);
      toast('ok', `Saved “${s.profile.name}”. Secrets are stored in the macOS Keychain.`);
      if (connected) {
        await disconnect(s.profile.id);
      }
      if (andConnect) await connect(s.profile.id);
    } catch (e) {
      setSaveErr(errorInfo(e).message);
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    await api.profiles.remove(p.id);
    await loadProfiles();
    onDeleted?.();
    toast('info', `Deleted “${p.name}” and its Keychain secrets.`);
  }

  const tlsModes: { mode: TlsMode; label: string }[] = [
    { mode: 'disable', label: 'Off' },
    { mode: 'require', label: p.driver === 'mssql' ? 'Encrypt (trust cert)' : 'Required' },
    { mode: 'verify', label: 'Verify certificate' },
  ];

  return (
    <div style={{ maxWidth: 720 }}>
      <div className="row" style={{ marginBottom: 16 }}>
        <DriverIcon driver={p.driver} size={30} />
        <div className="grow">
          <h1>{isNew ? `New ${DRIVER_LABELS[p.driver]} connection` : p.name || '(unnamed)'}</h1>
          <span className="muted">{DRIVER_LABELS[p.driver]}</span>
        </div>
        {!isNew && (
          <>
            {connected ? (
              <span className="pill ok">Connected</span>
            ) : (
              <button className="btn primary" onClick={onConnect} disabled={connecting || dirty}>
                {connecting ? <Spinner /> : null} Connect
              </button>
            )}
          </>
        )}
      </div>

      {connectError && !isNew && (
        <div style={{ marginBottom: 16 }}>
          <ErrorView error={connectError} />
        </div>
      )}

      <div className="form">
        <span className="lbl">Name</span>
        <input className="input" value={p.name} placeholder="e.g. Orders DB" onChange={(e) => set('name', e.target.value)} autoFocus={isNew} />

        <span className="lbl">Environment</span>
        <div className="env-chips">
          {ENV_PRESETS.map((e) => (
            <span
              key={e.name}
              className={`env-chip${p.env.name === e.name && p.env.color === e.color ? ' on' : ''}`}
              style={{ '--env': e.color } as CSSProperties}
              onClick={() => set('env', e)}
            >
              <span className="dot" style={{ background: e.color }} />
              {e.name}
            </span>
          ))}
          <input className="input" style={{ width: 120 }} value={p.env.name} onChange={(e) => set('env', { ...p.env, name: e.target.value })} title="Custom label" />
          <input type="color" value={p.env.color} onChange={(e) => set('env', { ...p.env, color: e.target.value })} title="Colour" style={{ width: 28, height: 24, border: 'none', background: 'none' }} />
        </div>
        <span className="help">Shown on every tab and on every write confirmation for this connection.</span>

        {p.driver === 'databricks' ? (
          <>
            <span className="lbl">Server Hostname</span>
            <input className="input mono" value={p.host} placeholder="dbc-a1b2c3d4-e5f6.cloud.databricks.com" onChange={(e) => set('host', e.target.value)} />
            <span className="lbl">HTTP Path</span>
            <input className="input mono" value={p.httpPath} placeholder="/sql/1.0/warehouses/1234567890abcdef" onChange={(e) => set('httpPath', e.target.value)} />
            <span className="help">From the SQL warehouse → Connection details.</span>
            <span className="lbl">Authentication</span>
            <div className="segmented">
              <button className={p.authMode === 'oauth-m2m' ? 'on' : ''} onClick={() => set('authMode', 'oauth-m2m')}>
                OAuth M2M (service principal)
              </button>
              <button className={p.authMode === 'access-token' ? 'on' : ''} onClick={() => set('authMode', 'access-token')}>
                Access token
              </button>
            </div>
            {p.authMode === 'oauth-m2m' ? (
              <>
                <span className="lbl">Client ID</span>
                <input className="input mono" value={p.clientId ?? ''} placeholder="service principal application ID" onChange={(e) => set('clientId', e.target.value)} />
                {/azuredatabricks\.net/i.test(p.host) && (
                  <>
                    <span className="lbl">Azure tenant ID</span>
                    <input className="input mono" value={p.azureTenantId ?? ''} placeholder="optional — only for Microsoft Entra ID service principals" onChange={(e) => set('azureTenantId', e.target.value)} />
                  </>
                )}
              </>
            ) : null}
            <span className="lbl">Catalog</span>
            <input className="input" value={p.catalog ?? ''} placeholder="optional, e.g. main" onChange={(e) => set('catalog', e.target.value)} />
            <span className="lbl">Schema</span>
            <input className="input" value={p.schema ?? ''} placeholder="optional, e.g. default" onChange={(e) => set('schema', e.target.value)} />
          </>
        ) : (
          <>
            <span className="lbl">{p.driver === 'mssql' ? 'Server Hostname' : 'Host'}</span>
            <div className="row">
              <input className="input mono grow" value={p.host} onChange={(e) => set('host', e.target.value)} />
              <span className="muted">Port</span>
              <input
                className="input mono"
                style={{ width: 80 }}
                value={p.port || ''}
                placeholder={String(DEFAULT_PORTS[p.driver])}
                onChange={(e) => set('port', Number(e.target.value.replace(/\D/g, '')) || 0)}
              />
            </div>
            <span className="lbl">Database</span>
            <input
              className="input mono"
              value={p.database ?? ''}
              placeholder={p.driver === 'mysql' ? 'optional default database' : ''}
              onChange={(e) => set('database', e.target.value)}
            />
            <span className="lbl">Username</span>
            <input className="input mono" value={p.user} onChange={(e) => set('user', e.target.value)} />
            {p.driver === 'mssql' && <span className="help">SQL Server Authentication (SQL login).</span>}
          </>
        )}

        {secretFields.map((f) => (
          <SecretInput
            key={f}
            label={SECRET_LABEL[f]}
            stored={storedSecrets.includes(f) && !clearSecret[f]}
            value={secrets[f] ?? ''}
            onChange={(v) => setSecrets((s) => ({ ...s, [f]: v }))}
            onForget={() => setClearSecret((c) => ({ ...c, [f]: true }))}
          />
        ))}

        {p.driver !== 'databricks' && (
          <>
            <span className="lbl">TLS</span>
            <div className="segmented">
              {tlsModes.map((m) => (
                <button key={m.mode} className={p.tls.mode === m.mode ? 'on' : ''} onClick={() => set('tls', { ...p.tls, mode: m.mode })}>
                  {m.label}
                </button>
              ))}
            </div>
            {p.tls.mode === 'verify' && (
              <>
                <span className="lbl">CA certificate</span>
                <textarea
                  className="textarea"
                  rows={4}
                  placeholder="Optional PEM (-----BEGIN CERTIFICATE-----). Leave empty to use the system trust store."
                  value={p.tls.caCert ?? ''}
                  onChange={(e) => set('tls', { ...p.tls, caCert: e.target.value })}
                />
                <span className="lbl">Server name</span>
                <input className="input mono" placeholder="optional override for certificate host name" value={p.tls.serverName ?? ''} onChange={(e) => set('tls', { ...p.tls, serverName: e.target.value })} />
              </>
            )}
            {p.tls.mode === 'require' && <span className="help">Traffic is encrypted but the server certificate is not verified.</span>}
          </>
        )}
        {p.driver === 'databricks' && (
          <>
            <span className="lbl">TLS</span>
            <span className="muted">Always on (HTTPS to the workspace).</span>
          </>
        )}
      </div>

      <div className="row" style={{ marginTop: 22, gap: 8 }}>
        <button className="btn" onClick={() => void runTest()} disabled={testing}>
          {testing ? <Spinner /> : null} Test Connection
        </button>
        <span className="spacer" />
        {saveErr && <span style={{ color: 'var(--danger)', fontSize: 12 }}>{saveErr}</span>}
        {isNew && (
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button className="btn" onClick={() => void save(false)} disabled={saving || (!isNew && !dirty)}>
          Save
        </button>
        <button className="btn primary" onClick={() => void save(true)} disabled={saving}>
          {saving ? <Spinner /> : null} {isNew ? 'Save & Connect' : 'Save & Reconnect'}
        </button>
      </div>

      {testing && p.driver === 'databricks' && (
        <p className="muted small" style={{ marginTop: 8 }}>
          Opening a session can take a few minutes while a stopped SQL warehouse starts.
        </p>
      )}
      {test && <TestResultView result={test} />}

      {!isNew && (
        <div className="row" style={{ marginTop: 28, borderTop: '1px solid var(--line)', paddingTop: 14 }}>
          <button className="btn small" onClick={onDuplicate}>
            Duplicate
          </button>
          {connected && (
            <button className="btn small" onClick={() => void disconnect(p.id)}>
              Disconnect
            </button>
          )}
          <span className="spacer" />
          {confirmDelete ? (
            <>
              <span className="small">Delete this profile, its Keychain secrets, history and saved queries?</span>
              <button className="btn small" onClick={() => setConfirmDelete(false)}>
                Keep
              </button>
              <button className="btn small danger" onClick={() => void remove()}>
                Delete
              </button>
            </>
          ) : (
            <button className="btn small ghost" style={{ color: 'var(--danger)' }} onClick={() => setConfirmDelete(true)}>
              Delete profile…
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function SecretInput({
  label,
  stored,
  value,
  onChange,
  onForget,
}: {
  label: string;
  stored: boolean;
  value: string;
  onChange: (v: string) => void;
  onForget: () => void;
}) {
  return (
    <>
      <span className="lbl">{label}</span>
      <div className="row">
        <input
          className="input mono grow"
          type="password"
          autoComplete="off"
          value={value}
          placeholder={stored ? '•••••••• saved in Keychain — type to replace' : ''}
          onChange={(e) => onChange(e.target.value)}
        />
        {stored && !value && (
          <button className="btn small ghost" onClick={onForget} title="Remove the saved value from the Keychain when you save">
            Forget
          </button>
        )}
      </div>
    </>
  );
}

function TestResultView({ result }: { result: TestResult }) {
  return (
    <div style={{ marginTop: 16 }}>
      <div className="row">
        {result.ok ? <span className="pill ok">✓ Connection works</span> : <span className="pill danger">✕ Connection failed</span>}
        {result.serverVersion && <span className="muted small">{result.serverVersion}</span>}
      </div>
      <div className="steps">
        {result.steps.map((s, i) => (
          <div key={i} className="step">
            <span className={s.ok ? 's-ok' : 's-bad'}>{s.ok ? '✓' : '✕'}</span>
            <span>{s.name}</span>
            {s.detail && <span className="muted">— {s.detail}</span>}
            {s.durationMs > 0 && <span className="s-time">{formatDuration(s.durationMs)}</span>}
          </div>
        ))}
      </div>
      {result.error && <ErrorView error={result.error} />}
    </div>
  );
}
