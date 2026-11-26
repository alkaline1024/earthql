import { useState } from 'react';
import {
  BACKUP_CATEGORIES, BACKUP_IDS, FILTER_PREFIX,
  type BackupCategory, type BackupPreview, type BackupSettings as Settings,
} from '../../../shared/app-backup';
import { api, errorInfo } from '../api';
import { parseConnectionGroups } from '../connection-groups';
import { parseSavedFilters } from '../saved-filters';
import { reloadBackupSettings, useApp } from '../store';
import { parseTableFavorites } from '../table-favorites';
import { parseTableGroups } from '../table-groups';

function capture(ids: BackupCategory[]): Settings {
  const settings: Settings = {};
  for (const id of ids) {
    const keys = BACKUP_CATEGORIES[id].keys.map((key) => 'earthql.' + key);
    if (id === 'filters') {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key?.startsWith(FILTER_PREFIX)) keys.push(key);
      }
    }
    settings[id] = Object.fromEntries(keys.map((key) => [key, localStorage.getItem(key)]));
  }
  return settings;
}

function validateSetting(key: string, value: string | null) {
  if (key.startsWith(FILTER_PREFIX)) parseSavedFilters(value);
  if (key === 'earthql.connectionGroups') parseConnectionGroups(value);
  if (key === 'earthql.tableGroups') parseTableGroups(value);
  if (key === 'earthql.tableFavorites') parseTableFavorites(value);
}

function writeSetting(key: string, value: string | null) {
  if (value === null) localStorage.removeItem(key);
  else localStorage.setItem(key, value);
}

export function BackupSettings({ setWorking }: { setWorking: (working: boolean) => void }) {
  const [backup, setBackup] = useState<BackupCategory[]>(BACKUP_IDS);
  const [restore, setRestore] = useState<BackupCategory[]>([]);
  const [preview, setPreview] = useState<BackupPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ error: boolean; text: string }>();
  const toast = useApp((s) => s.toast);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setWorking(true);
    setStatus(undefined);
    try { await action(); }
    catch (error) { setStatus({ error: true, text: errorInfo(error).message }); }
    finally {
      setBusy(false);
      setWorking(false);
    }
  }

  function choices(available: BackupCategory[], selected: BackupCategory[], onChange: (ids: BackupCategory[]) => void) {
    const all = selected.length === available.length;
    return <div className="col" style={{ gap: 8 }}>
      <button type="button" className="btn small" style={{ alignSelf: 'start' }} disabled={busy} onClick={() => onChange(all ? [] : available)}>
        {all ? 'Deselect all' : 'Select all'}
      </button>
      {available.map((id) => <label className="check" key={id}>
        <input type="checkbox" checked={selected.includes(id)} disabled={busy} onChange={(event) => {
          onChange(event.target.checked ? [...selected, id] : selected.filter((item) => item !== id));
        }} />
        <span><strong>{BACKUP_CATEGORIES[id].label}</strong> <span className="muted small">{BACKUP_CATEGORIES[id].detail}</span></span>
      </label>)}
    </div>;
  }

  return <div className="col" style={{ gap: 20 }}>
    <section>
      <h3 className="settings-h">Backup</h3>
      <p className="muted">Choose what to save in an EarthQL backup file. Passwords and tokens stay in Keychain.</p>
      {choices(BACKUP_IDS, backup, setBackup)}
      <div className="row" style={{ marginTop: 12 }}>
        <button type="button" className="btn primary" disabled={busy || !backup.length} onClick={() => void run(async () => {
          const name = await api.backup.save(capture(backup));
          if (!name) return;
          setStatus({ error: false, text: `Backup saved as ${name}.` });
          toast('ok', `Backup saved as ${name}.`, 'Export');
        })}>Save backup…</button>
      </div>
    </section>
    <section style={{ borderTop: '1px solid var(--line)', paddingTop: 16 }}>
      <h3 className="settings-h">Restore</h3>
      <p className="muted">Open a backup and choose what to restore.</p>
      <button type="button" className="btn" disabled={busy} onClick={() => void run(async () => {
        const next = await api.backup.open();
        if (!next) return;
        setPreview(next);
        setRestore(BACKUP_IDS.filter((id) => Object.hasOwn(next.settings, id)));
      })}>{preview ? 'Choose another file…' : 'Open backup…'}</button>
      {preview && <div className="col" style={{ gap: 10, marginTop: 12 }}>
        <div><strong>{preview.fileName}</strong> <span className="muted small">{new Date(preview.createdAt).toLocaleString()}</span></div>
        {choices(BACKUP_IDS.filter((id) => Object.hasOwn(preview.settings, id)), restore, setRestore)}
        <p className="muted small">
          Existing connections and query entries with matching IDs are kept. Selected bookmarks, groups and preferences
          replace their saved values. Saved filters replace filters for matching tables. Queries and history need their original connection.
        </p>
        <div className="row">
          <button type="button" className="btn" disabled={busy} onClick={() => setPreview(null)}>Cancel</button>
          <button type="button" className="btn primary" disabled={busy || !restore.length} onClick={() => void run(async () => {
            const values = restore.flatMap((id) => Object.entries(preview.settings[id] ?? {}));
            for (const [key, value] of values) validateSetting(key, value);
            const previous = new Map(values.map(([key]) => [key, localStorage.getItem(key)]));
            let missingProfiles: number;
            try {
              for (const [key, value] of values) writeSetting(key, value);
              missingProfiles = await api.backup.restore(preview.token, restore);
            } catch (error) {
              // Release any newly used storage before restoring the original values.
              for (const key of previous.keys()) localStorage.removeItem(key);
              for (const [key, value] of previous) writeSetting(key, value);
              throw error;
            }
            setPreview(null);
            const text = missingProfiles
              ? `Backup restored. Queries or history for ${missingProfiles} missing connection(s) were skipped.`
              : 'Backup restored.';
            try { await reloadBackupSettings(); }
            catch { toast('error', 'Backup restored. Reopen EarthQL to reload all settings.'); }
            setStatus({ error: false, text });
            toast('ok', text, 'Import');
          })}>Restore selected</button>
        </div>
      </div>}
    </section>
    {busy && <p role="status" className="muted">Working…</p>}
    {status && <p role={status.error ? 'alert' : 'status'}>{status.text}</p>}
  </div>;
}
