import { useState } from 'react';
import { describePath, type ObjectPath, type WriteResult } from '@earthql/core';
import { tableActionOptions, type TableAction } from '../../../shared/table-actions';
import { api, errorInfo } from '../api';
import { profileOf, useApp } from '../store';
import { objectHasUnsavedChanges } from '../unsaved-changes';
import { ConfirmTarget, ErrorView, Modal, Spinner } from './common';

export function TableActionDialog({ profileId, object, objects, action, onClose }: { profileId: string; object: ObjectPath; objects?: ObjectPath[]; action: TableAction; onClose: () => void }) {
  const targets = objects ?? [object];
  const multiple = targets.length > 1;
  const [completed, setCompleted] = useState(0);
  const profile = profileOf(profileId)?.profile;
  const supported = tableActionOptions(profile?.driver ?? 'mysql');
  const [cloneName, setCloneName] = useState(`${object.name}_clone`);
  const [copyData, setCopyData] = useState(true);
  const [restartIdentity, setRestartIdentity] = useState(supported.restartIdentity || supported.resetsIdentity);
  const [ignoreForeignKeys, setIgnoreForeignKeys] = useState(false);
  const [cascade, setCascade] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<WriteResult | null>(null);
  const unsaved = useApp((state) => targets.some((target) => objectHasUnsavedChanges(state.tabs, state.gridDrafts, profileId, target, 'table')));
  const toast = useApp((state) => state.toast);
  const label = action === 'clone' ? 'Clone' : action === 'truncate' ? 'Truncate' : 'Delete';
  const blocked = (action !== 'clone' && unsaved) || result?.status === 'outcome_unknown' || (multiple && !!result) || (action === 'clone' && multiple);
  async function run() {
    if (busy || blocked) return;
    setBusy(true); setResult(null);
    try {
      const successful: ObjectPath[] = [];
      let failure: WriteResult | null = null;
      try {
        for (const target of targets) {
          const response = await api.tableActions.run(profileId, { action, object: target, cloneName, copyData, restartIdentity: action === 'truncate' && restartIdentity, ignoreForeignKeys: action !== 'clone' && ignoreForeignKeys, cascade: action !== 'clone' && cascade });
          if (response.status !== 'ok') { failure = response; break; }
          successful.push(target); setCompleted(successful.length);
        }
      } catch (error) { failure = { status: 'error', error: errorInfo(error), durationMs: 0 }; }
      const state = useApp.getState();
      const same = (a: ObjectPath, b: ObjectPath) => a.catalog === b.catalog && a.database === b.database && a.schema === b.schema && a.name === b.name;
      const matching = state.tabs.filter((tab) => tab.kind === 'table' && tab.profileId === profileId && successful.some((target) => same(tab.object, target)));
      if (action === 'delete') state.closeTabs(matching.map((tab) => tab.id));
      if (action === 'truncate') for (const tab of matching) state.refreshTab(tab.id, true);
      for (const target of successful) state.refreshTree(profileId, target);
      if (failure) setResult(failure);
      else {
        onClose();
        toast('ok', action === 'clone' ? `Cloned ${object.name} as ${cloneName.trim()}.` : `${action === 'truncate' ? 'Truncated' : 'Deleted'} ${multiple ? `${successful.length} tables` : describePath(object)}.`);
      }
    } catch (error) { setResult({ status: 'error', error: errorInfo(error), durationMs: 0 }); }
    finally { setBusy(false); }
  }
  return <Modal narrow title={multiple ? `${label} ${targets.length} tables` : `${label} table “${object.name}”`} onClose={() => { if (!busy) onClose(); }}>
    <form className="col" onSubmit={(event) => { event.preventDefault(); void run(); }}>
      {profile && <ConfirmTarget profile={profile} action={label} target={multiple ? `${targets.length} tables` : describePath(object)} />}
      {multiple && <ul className="table-action-targets">{targets.map((target) => <li key={JSON.stringify(target)}>{describePath(target)}</li>)}</ul>}
      <fieldset className="table-transfer-fieldset col" disabled={busy}>
        {action === 'clone' ? <>
          <label>Clone name<input className="input" autoFocus value={cloneName} onFocus={(event) => event.currentTarget.select()} onChange={(event) => setCloneName(event.target.value)} style={{ width: '100%', marginTop: 6 }} /></label>
          <label className="check"><input type="checkbox" checked={copyData} onChange={(event) => setCopyData(event.target.checked)} />Duplicate table content</label>
          <span className="muted small">Copies saved database data. {profile?.driver === 'postgres' ? 'Copies column definitions, indexes and checks; foreign keys and triggers are not copied.' : profile?.driver === 'mssql' || profile?.driver === 'databricks' ? 'Copies columns and data; indexes, keys and triggers are not copied.' : 'Copies columns and indexes; foreign keys and triggers are not copied.'}</span>
        </> : <>
          <p style={{ margin: '0 0 8px' }}>{action === 'truncate' ? multiple ? 'Remove every row from the selected tables. Their structure is kept.' : 'Remove every row from this table. The table structure is kept.' : multiple ? 'Permanently remove all selected tables and their data.' : 'Permanently remove this table and its data.'}</p>
          {action === 'truncate' && (supported.restartIdentity || supported.resetsIdentity) && <div>
            <label className="check"><input type="checkbox" checked={restartIdentity} disabled={!supported.restartIdentity} onChange={(event) => setRestartIdentity(event.target.checked)} />Restart identity</label>
            <div className="muted small">{supported.resetsIdentity ? 'This database resets identity automatically when truncating.' : 'Reset sequences owned by this table.'}</div>
          </div>}
          {supported.ignoreForeignKeys && <div>
            <label className="check"><input type="checkbox" checked={ignoreForeignKeys} onChange={(event) => setIgnoreForeignKeys(event.target.checked)} />{action === 'truncate' ? 'Disable foreign key check' : 'Ignore foreign key checks'}</label>
            <div className="muted small">May leave related rows without a referenced parent. Checks are restored after the operation.</div>
          </div>}
          {supported.cascade && <div>
            <label className="check"><input type="checkbox" checked={cascade} onChange={(event) => setCascade(event.target.checked)} />Cascade</label>
            <div className="muted small">{action === 'truncate' ? 'Also truncate tables that reference this table.' : 'Also drop dependent objects, including referencing constraints.'}</div>
          </div>}
        </>}
      </fieldset>
      {unsaved && action !== 'clone' && <div className="banner">Save or discard this table’s unsaved changes before {action === 'delete' ? 'deleting' : 'truncating'} it.</div>}
      {multiple && (busy || result) && <div className="muted">{completed} of {targets.length} tables completed.{result ? ' Stopped at an error; completed operations remain. Close this dialog and refresh the selection before retrying.' : ''}</div>}
      {result?.error && <ErrorView error={result.error} />}
      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 8 }}>
        <button className="btn" type="button" disabled={busy} onClick={onClose}>Cancel</button>
        <button className={`btn ${action === 'clone' ? 'primary' : 'danger'}`} type="submit" disabled={busy || blocked || (action === 'clone' && (!cloneName.trim() || cloneName.trim() === object.name))}>{busy ? <Spinner /> : null}{label}</button>
      </div>
    </form>
  </Modal>;
}
