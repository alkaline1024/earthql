import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import {
  DRIVER_LABELS,
  secretFieldsFor,
  type ConnectionProfile,
  type DriverId,
  type ErrorInfo,
  type SecretField,
  type Secrets,
  type TestResult,
  type TlsMode,
} from '@earthql/core';
import { createPortal } from 'react-dom';
import { api, errorInfo, onMenuCommand, uid } from '../api';
import { ENV_PRESETS } from '../../../shared/environments';
import { useApp } from '../store';
import { ContextSubmenu as ConnectionMenuBranch } from './ContextSubmenu';
import { assignConnectionGroup, parseConnectionGroups, type ConnectionGroup } from '../connection-groups';
import { DRIVER_META, DriverIcon, EnvBadge, ErrorView, Modal, Spinner, formatDuration } from './common';
import { useShortcuts } from './Shortcut';
import { SidebarResizeHandle } from './SidebarResizeHandle';

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
  if (p.driver === 'databricks') return `${p.host || '—'}${p.catalog ? ' : ' + p.catalog : ''}`;
  return `${p.host || '—'}:${p.port}${p.database ? ' : ' + p.database : ''}`;
}

export function ConnectionsScreen({ initialNew, initialProfileId }: { initialNew?: boolean; initialProfileId?: string }) {
  const sidebarWidth = useApp((s) => s.sidebarWidth);
  const { profiles, loadProfiles, connections, connecting, connectErrors, connect, setScreen, moveProfile, disconnectProfile, toast } = useApp();
  const connectedProfiles = new Set(Object.values(connections).map(({ profileId }) => profileId));
  const connectingProfiles = new Set(Object.entries(connecting).flatMap(([id, busy]) => busy ? [connections[id]?.profileId ?? id] : []));
  const [selectedId, setSelectedId] = useState<string | null>(initialProfileId ?? null);
  const [selectedIds, setSelectedIds] = useState<string[]>(initialProfileId ? [initialProfileId] : []);
  const anchor = useRef<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; groupId?: string } | null>(null);
  const [groups, setGroups] = useState<ConnectionGroup[]>(() => {
    try { return parseConnectionGroups(localStorage.getItem('earthql.connectionGroups')); } catch { return []; }
  });
  const [groupEditor, setGroupEditor] = useState<{ id?: string; name: string; ids: string[] } | null>(null);
  const [groupError, setGroupError] = useState('');
  const [dragGroup, setDragGroup] = useState<string | null>(null);
  const newConnectionGroup = useRef<string | null>(null);
  const [exportIds, setExportIds] = useState<string[] | null>(null);
  const groupedIds = new Set(groups.flatMap((group) => group.profileIds));
  const sections = [
    ...groups.map((group) => ({ group, items: profiles.filter(({ profile }) => group.profileIds.includes(profile.id)) })),
    { group: null, items: profiles.filter(({ profile }) => !groupedIds.has(profile.id)) },
  ];
  const visibleProfiles = sections.flatMap(({ group, items }) => group?.collapsed ? [] : items);

  function saveGroups(next: ConnectionGroup[]) {
    try {
      localStorage.setItem('earthql.connectionGroups', JSON.stringify(next));
      setGroups(next);
      return true;
    } catch { toast('error', 'Connection groups could not be saved.'); return false; }
  }

  function moveToGroup(ids: string[], groupId: string | null) {
    return saveGroups(assignConnectionGroup(groups, ids, groupId));
  }

  function editGroup(group?: ConnectionGroup) {
    setMenu(null);
    setGroupError('');
    setGroupEditor({ id: group?.id, name: group?.name ?? '', ids: group ? [] : [...selectedIds] });
  }

  function saveGroup(event: FormEvent) {
    event.preventDefault();
    if (!groupEditor) return;
    const name = groupEditor.name.trim();
    if (!name) { setGroupError('Enter a group name.'); return; }
    if (groups.some((group) => group.id !== groupEditor.id && group.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      setGroupError('A group with this name already exists.'); return;
    }
    const next = groupEditor.id
      ? groups.map((group) => group.id === groupEditor.id ? { ...group, name } : group)
      : assignConnectionGroup([...groups, { id: uid(), name, profileIds: [], collapsed: false }], groupEditor.ids, null);
    if (!groupEditor.id) next[next.length - 1].profileIds = groupEditor.ids;
    if (saveGroups(next)) setGroupEditor(null);
  }

  function beginExport(ids: string[] | null) {
    setMenu(null);
    setExportIds(ids);
    setTransfer('export');
  }

  const [deleteIds, setDeleteIds] = useState<string[] | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [draft, setDraft] = useState<ConnectionProfile | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ id: string; after: boolean } | null>(null);
  const [transfer, setTransfer] = useState<'import' | 'export' | null>(null);

  useEffect(() => {
    void loadProfiles();
  }, [loadProfiles]);

  useEffect(() => {
    if (initialNew) startNew();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialNew]);

  useEffect(() => {
    if ((!selectedId || !profiles.some(({ profile }) => profile.id === selectedId)) && !draft && !isNew && profiles.length > 0) {
      setSelectedId(profiles[0].profile.id);
      setSelectedIds([profiles[0].profile.id]);
    }
  }, [profiles, selectedId, draft, isNew]);

  useEffect(() => {
    setSelectedIds((ids) => {
      const valid = ids.filter((id) => profiles.some(({ profile }) => profile.id === id));
      return valid;
    });
  }, [profiles]);

  useEffect(() => {
    if (!menu) return;
    menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    const close = (e: Event) => {
      if (e.target instanceof Node && menuRef.current?.contains(e.target)) return;
      setMenu(null);
    };
    window.addEventListener('pointerdown', close);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [menu]);

  function selectConnection(id: string, toggle = false, range = false) {
    const ids = visibleProfiles.map(({ profile }) => profile.id);
    if (range) {
      const from = ids.indexOf(anchor.current ?? selectedId ?? id);
      const to = ids.indexOf(id);
      const span = ids.slice(Math.min(Math.max(from, 0), to), Math.max(from, to) + 1);
      setSelectedIds((current) => toggle ? [...new Set([...current, ...span])] : span);
    } else {
      setSelectedIds((current) => toggle ? current.includes(id) ? current.filter((item) => item !== id) : [...current, id] : [id]);
      anchor.current = id;
    }
    setSelectedId(id);
    setIsNew(false);
    setDraft(null);
  }

  function openMenu(id: string | null, x: number, y: number, groupId?: string) {
    if (id && !selectedIds.includes(id)) selectConnection(id);
    setMenu({ x: Math.max(8, Math.min(x, window.innerWidth - 232)), y: Math.max(8, Math.min(y, window.innerHeight - 420)), groupId });
  }

  async function deleteSelected() {
    if (!deleteIds || deleting) return;
    setDeleting(true);
    try {
      for (const id of deleteIds) {
        if (!(await disconnectProfile(id))) return;
        await api.profiles.remove(id);
      }
      setDeleteIds(null);
      setSelectedIds([]);
      setSelectedId(null);
    } catch (e) { toast('error', errorInfo(e).message); }
    finally { await loadProfiles(); setDeleting(false); }
  }

  function startNew(groupId: string | null = null) {
    newConnectionGroup.current = groupId;
    setDraft(null);
    setIsNew(true);
    setSelectedId(null);
    setSelectedIds([]);
  }

  const selected = profiles.find((p) => p.profile.id === selectedId);
  const anyOpen = Object.keys(connections).length > 0;
  const exportable = profiles.some(({ profile }) => profile.driver !== 'databricks');

  return (
    <div className="conn-screen">
      <div className="conn-list" style={{ width: sidebarWidth }} onContextMenu={(e) => { e.preventDefault(); openMenu(null, e.clientX, e.clientY); }}>
        <SidebarResizeHandle />
        <div className="sidebar-top drag">
          <span className="spacer" />
          {anyOpen && (
            <button type="button" className="btn small ghost no-drag" onClick={() => setScreen('workspace')}>
              Workspace <span className="sidebar-chevron" aria-hidden="true" />
            </button>
          )}
        </div>
        <div className="row" style={{ padding: '0 14px 8px' }}>
          <b style={{ fontSize: 15 }}>Connections</b>
          <span className="spacer" />
          <button className="btn small" onClick={() => startNew()}>
            ＋ New
          </button>
        </div>
        <div className="row" style={{ padding: '0 14px 8px' }}>
          <button className="btn small" title="Import a TablePlus connection file" onClick={() => setTransfer('import')}>Import…</button>
          <button className="btn small" title="Export connections to TablePlus" disabled={!exportable} onClick={() => beginExport(null)}>Export…</button>
        </div>
        <div className="conn-toolbar-divider" role="separator" />
        <div className="scroll grow conn-selection-list" ref={listRef} tabIndex={0} role="listbox" aria-label="Connections" aria-multiselectable="true"
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
              e.preventDefault();
              setSelectedIds(profiles.map(({ profile }) => profile.id));
              setIsNew(false);
            } else if (e.key === 'Escape') { setMenu(null); setSelectedIds(selectedId ? [selectedId] : []); }
            else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              const index = visibleProfiles.findIndex(({ profile }) => profile.id === selectedId);
              const next = visibleProfiles[Math.max(0, Math.min(visibleProfiles.length - 1, index + (e.key === 'ArrowDown' ? 1 : -1)))];
              if (next) {
                selectConnection(next.profile.id, e.ctrlKey || e.metaKey, e.shiftKey);
                listRef.current?.querySelector(`[data-connection-id="${CSS.escape(next.profile.id)}"]`)?.scrollIntoView({ block: 'nearest' });
              }
            } else if ((e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) && selectedId) {
              e.preventDefault();
              const rect = listRef.current!.getBoundingClientRect();
              openMenu(selectedId, rect.left + 24, rect.top + 24);
            }
          }}>
          {selectedIds.length > 1 && <div className="conn-selection-count">{selectedIds.length} connections selected</div>}
          {profiles.length === 0 && <div className="tree-msg" style={{ padding: '8px 18px' }}>No saved connections yet.</div>}
          {sections.map(({ group, items }) => (
            <div key={group?.id ?? '__ungrouped'} role="group" aria-label={group?.name ?? 'Ungrouped'}>
              {(group || groups.length > 0) && <button type="button"
                className={`conn-group-header${dragGroup === (group?.id ?? '__ungrouped') ? ' drop-target' : ''}`}
                aria-expanded={group ? !group.collapsed : undefined}
                onClick={() => { if (group) saveGroups(groups.map((item) => item.id === group.id ? { ...item, collapsed: !item.collapsed } : item)); }}
                onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); openMenu(null, e.clientX, e.clientY, group?.id); }}
                onDragOver={(e) => { if (draggingId) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDragGroup(group?.id ?? '__ungrouped'); setDropTarget(null); } }}
                onDragLeave={() => setDragGroup(null)}
                onDrop={(e) => {
                  e.preventDefault(); e.stopPropagation();
                  if (draggingId) {
                    const ids = selectedIds.includes(draggingId) ? selectedIds : [draggingId];
                    const next = assignConnectionGroup(groups, ids, group?.id ?? null);
                    saveGroups(next.map((item) => item.id === group?.id ? { ...item, collapsed: false } : item));
                  }
                  setDraggingId(null); setDropTarget(null); setDragGroup(null);
                }}>
                <span aria-hidden="true">{group ? group.collapsed ? '▸' : '▾' : '·'}</span>
                <span className="grow">{group?.name ?? 'Ungrouped'}</span><span className="muted">{items.length}</span>
              </button>}
              {(!group?.collapsed) && items.map(({ profile }) => (
            <div
              key={profile.id}
              className={`conn-item${selectedIds.includes(profile.id) && !isNew ? ' selected' : ''}${draggingId && (selectedIds.includes(draggingId) ? selectedIds.includes(profile.id) : draggingId === profile.id) ? ' dragging' : ''}${dropTarget?.id === profile.id ? (dropTarget.after ? ' drop-after' : ' drop-before') : ''}`}
              role="option"
              aria-selected={selectedIds.includes(profile.id) && !isNew}
              data-connection-id={profile.id}
              draggable
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                listRef.current?.focus();
                openMenu(profile.id, e.clientX, e.clientY);
              }}
              title="Drag to reorder connections"
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', profile.id);
                if (!selectedIds.includes(profile.id)) selectConnection(profile.id);
                setMenu(null);
                setDraggingId(profile.id);
              }}
              onDragOver={(e) => {
                if (!draggingId) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                const rect = e.currentTarget.getBoundingClientRect();
                setDropTarget(draggingId === profile.id ? null : { id: profile.id, after: e.clientY > rect.top + rect.height / 2 });
                const list = listRef.current;
                if (list) {
                  const bounds = list.getBoundingClientRect();
                  if (e.clientY < bounds.top + 36) list.scrollTop -= 18;
                  else if (e.clientY > bounds.bottom - 36) list.scrollTop += 18;
                }
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropTarget(null);
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (draggingId) {
                  const rect = e.currentTarget.getBoundingClientRect();
                  const ids = selectedIds.includes(draggingId) ? selectedIds : [draggingId];
                  if (!ids.includes(profile.id) && moveToGroup(ids, group?.id ?? null)) {
                    moveProfile(ids, profile.id, e.clientY > rect.top + rect.height / 2);
                  }
                }
                setDraggingId(null);
                setDropTarget(null);
              }}
              onDragEnd={() => {
                setDraggingId(null);
                setDropTarget(null);
                setDragGroup(null);
              }}
              onClick={(e) => {
                listRef.current?.focus();
                setMenu(null);
                selectConnection(profile.id, e.ctrlKey || e.metaKey, e.shiftKey);
              }}
              onDoubleClick={() => void connect(profile.id)}
            >
              <span className="c-logo"><DriverIcon driver={profile.driver} size={40} /></span>
              <div className="c-name">
                <span className="c-title" title={profile.name || '(unnamed)'}>
                  {profile.name || '(unnamed)'}
                </span>
                <EnvBadge env={profile.env} />
                <span className="conn-status">
                  {connectingProfiles.has(profile.id) ? (
                    <span role="status" aria-label="Connecting" title="Connecting…"><Spinner /></span>
                  ) : connectedProfiles.has(profile.id) ? (
                    <span className="dot" style={{ background: 'var(--ok)' }} title="Connected" />
                  ) : null}
                </span>
              </div>
              <span className="c-sub" title={describe(profile)}>{describe(profile)}</span>
            </div>
              ))}
            </div>
          ))}
        </div>
      </div>

      {menu && createPortal(
        <div className={`conn-context-menu${menu.x + 464 > window.innerWidth ? ' submenu-left' : ''}`} role="menu" aria-label="Connection actions" ref={menuRef}
          style={{ left: menu.x, top: menu.y }}
          onContextMenu={(e) => e.preventDefault()}
          onKeyDown={(e) => {
            if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); setMenu(null); listRef.current?.focus(); }
            if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
              e.preventDefault();
              const activeMenu = (e.target as HTMLElement).closest('[role="menu"]') ?? e.currentTarget;
              const buttons = Array.from(activeMenu.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')).filter((button) => button.closest('[role="menu"]') === activeMenu);
              const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
              const next = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : (index + (e.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length;
              buttons[next]?.focus();
            }
          }}>
          {menu.groupId && <>
            <button role="menuitem" onClick={() => { const group = groups.find((item) => item.id === menu.groupId); if (group) editGroup(group); }}>Rename group…</button>
            <button role="menuitem" onClick={() => { saveGroups(groups.filter((item) => item.id !== menu.groupId)); setMenu(null); }}>Remove group (keep connections)</button>
            <div className="conn-menu-separator" role="separator" />
          </>}
          <ConnectionMenuBranch label="New">
            <button role="menuitem" onClick={() => { const groupId = menu.groupId; setMenu(null); startNew(groupId ?? null); }}>Connection</button>
            <button role="menuitem" onClick={() => editGroup()}>Group</button>
          </ConnectionMenuBranch>
          <ConnectionMenuBranch label="Import Connections">
            <button role="menuitem" onClick={() => { setMenu(null); setTransfer('import'); }}>From File…</button>
          </ConnectionMenuBranch>
          <ConnectionMenuBranch label="Export Connections">
            <button role="menuitem" disabled={!exportable} onClick={() => beginExport(null)}>All Connections</button>
            <button role="menuitem" disabled={!profiles.some(({ profile }) => selectedIds.includes(profile.id) && profile.driver !== 'databricks')} onClick={() => beginExport([...selectedIds])}>Selected ({selectedIds.length})</button>
          </ConnectionMenuBranch>
          <div className="conn-menu-separator" role="separator" />
          <button role="menuitem" disabled={selectedIds.length !== 1} onClick={() => { setMenu(null); if (selectedIds[0]) void connect(selectedIds[0]); }}>Connect</button>
          <button role="menuitem" disabled={!selectedIds.some((id) => connectedProfiles.has(id))} onClick={() => {
            setMenu(null);
            void (async () => { try { for (const id of selectedIds) if (connectedProfiles.has(id)) await disconnectProfile(id); } catch (e) { toast('error', errorInfo(e).message); } })();
          }}>Disconnect{selectedIds.length > 1 ? ` (${selectedIds.length})` : ''}</button>
          <button role="menuitem" disabled={selectedIds.length !== 1} onClick={() => {
            setMenu(null);
            const original = profiles.find(({ profile }) => profile.id === selectedIds[0]);
            if (original) { setDraft({ ...original.profile, id: uid(), name: `${original.profile.name} copy` }); setIsNew(true); }
          }}>Duplicate…</button>
          <ConnectionMenuBranch label="Move to Group" disabled={!selectedIds.length}>
            <button role="menuitem" onClick={() => { moveToGroup(selectedIds, null); setMenu(null); }}>Ungrouped</button>
            {groups.map((group) => <button key={group.id} role="menuitem" onClick={() => { moveToGroup(selectedIds, group.id); setMenu(null); }}>{group.name}</button>)}
            <div className="conn-menu-separator" role="separator" />
            <button role="menuitem" onClick={() => editGroup()}>New Group…</button>
          </ConnectionMenuBranch>
          <div className="conn-menu-separator" role="separator" />
          <button role="menuitem" onClick={() => { setMenu(null); setSelectedIds(profiles.map(({ profile }) => profile.id)); listRef.current?.focus(); }}>Select all</button>
          <button role="menuitem" disabled={!selectedIds.length} className="destructive" onClick={() => { setMenu(null); setDeleteIds([...selectedIds]); }}>Delete{selectedIds.length > 1 ? ` ${selectedIds.length} connections` : ' connection'}…</button>
        </div>, document.body)}
      {groupEditor && <Modal narrow title={groupEditor.id ? 'Rename group' : 'New group'} onClose={() => setGroupEditor(null)}>
        <form onSubmit={saveGroup} style={{ display: 'grid', gap: 12 }}>
          <label>Group name<input className="input" style={{ width: '100%', marginTop: 6 }} autoFocus value={groupEditor.name} onChange={(e) => setGroupEditor({ ...groupEditor, name: e.target.value })} /></label>
          {!groupEditor.id && groupEditor.ids.length > 0 && <span className="muted">Move {groupEditor.ids.length} selected connections into this group.</span>}
          {groupError && <span role="alert" style={{ color: 'var(--danger)' }}>{groupError}</span>}
          <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn" type="button" onClick={() => setGroupEditor(null)}>Cancel</button><button className="btn primary" type="submit">{groupEditor.id ? 'Save' : 'Create group'}</button></div>
        </form>
      </Modal>}
      {deleteIds && <Modal title={`Delete ${deleteIds.length} connection${deleteIds.length === 1 ? '' : 's'}?`} onClose={() => { if (!deleting) setDeleteIds(null); }}>
        <p>This deletes the selected profiles, their Keychain secrets, history and saved queries.</p>
        <ul>{profiles.filter(({ profile }) => deleteIds.includes(profile.id)).map(({ profile }) => <li key={profile.id}>{profile.name || '(unnamed)'}</li>)}</ul>
        <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn" disabled={deleting} onClick={() => setDeleteIds(null)}>Keep</button>
          <button className="btn danger" disabled={deleting} onClick={() => void deleteSelected()}>{deleting ? 'Deleting…' : 'Delete'}</button>
        </div>
      </Modal>}
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
              setSelectedIds([p.id]);
              if (newConnectionGroup.current) moveToGroup([p.id], newConnectionGroup.current);
              newConnectionGroup.current = null;
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
            connected={connectedProfiles.has(selected.profile.id)}
            connecting={connectingProfiles.has(selected.profile.id)}
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
            <h2 className="welcome-wordmark" aria-label="EarthQL">
              <span aria-hidden="true">Earth</span>
              <img src="./earthql-q.png" alt="" width={192} height={192} />
              <span aria-hidden="true">L</span>
            </h2>
            <p>Connect to PostgreSQL, MySQL, Databricks or Microsoft SQL Server.</p>
            <button className="btn primary" onClick={() => startNew()}>
              Add a connection
            </button>
          </div>
        )}
      </div>
      {transfer && (
        <ConnectionTransfer
          mode={transfer}
          selectedIds={exportIds}
          onClose={() => setTransfer(null)}
        />
      )}
    </div>
  );
}

function ConnectionTransfer({ mode, selectedIds, onClose }: {
  mode: 'import' | 'export';
  selectedIds: string[] | null;
  onClose: () => void;
}) {
  const isImport = mode === 'import';
  const [password, setPassword] = useState('');
  const [scope, setScope] = useState(selectedIds ? 'selected' : 'all');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorInfo | null>(null);
  const loadProfiles = useApp((state) => state.loadProfiles);
  const toast = useApp((state) => state.toast);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (isImport) {
        const result = await api.profiles.importTablePlus(password);
        if (!result) return;
        if (result.imported || result.passwordsSaved || result.environmentsUpdated) await loadProfiles();
        const details = [
          result.duplicates ? `${result.duplicates} already saved` : '',
          result.skipped ? `${result.skipped} unsupported or incomplete` : '',
        ].filter(Boolean);
        const profiles = `Imported ${result.imported} ${result.imported === 1 ? 'connection' : 'connections'}${details.length ? ` (${details.join(', ')})` : ''}.`;
        const passwords = result.passwordsSaved ? ` Saved ${result.passwordsSaved} database ${result.passwordsSaved === 1 ? 'password' : 'passwords'} in Keychain.` : '';
        const environments = result.environmentsUpdated ? ` Updated ${result.environmentsUpdated} ${result.environmentsUpdated === 1 ? 'environment' : 'environments'}.` : '';
        toast(result.imported || result.passwordsSaved || result.environmentsUpdated ? 'ok' : 'info', profiles + passwords + environments, 'Import');
        if (result.passwordsFailed) toast('error', `Keychain could not save ${result.passwordsFailed} database ${result.passwordsFailed === 1 ? 'password' : 'passwords'}. Try importing the file again.`);
      } else {
        const result = await api.profiles.exportTablePlus(scope === 'selected' ? selectedIds : null, password);
        if (!result) return;
        toast('ok', `Exported ${result.exported} ${result.exported === 1 ? 'connection' : 'connections'}.${result.skipped ? ` ${result.skipped} Databricks ${result.skipped === 1 ? 'profile' : 'profiles'} skipped.` : ''}`, 'Export');
        if (result.reviewTls) toast('info', `Review SSL settings in TablePlus for ${result.reviewTls} ${result.reviewTls === 1 ? 'connection' : 'connections'}.`);
      }
      onClose();
    } catch (e) {
      setError(errorInfo(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal narrow title={isImport ? 'Import from TablePlus' : 'Export to TablePlus'} onClose={() => !busy && onClose()}>
      <form onSubmit={(event) => void submit(event)} style={{ display: 'grid', gap: 12 }}>
        <p className="muted" style={{ margin: 0 }}>
          PostgreSQL, MySQL, and SQL Server profiles. {isImport
            ? 'Database passwords included in encrypted TablePlus files are saved to Keychain. Existing passwords are kept.'
            : 'Enter database passwords separately in TablePlus after transfer.'}
        </p>
        {!isImport && selectedIds && (
          <label>
            Connections
            <select aria-label="Connections to export" style={{ width: '100%' }} value={scope} disabled={busy} onChange={(event) => setScope(event.target.value)}>
              <option value="selected">Selected ({selectedIds.length})</option>
              <option value="all">All supported connections</option>
            </select>
          </label>
        )}
        <label>
          {isImport ? 'File password (if set)' : 'File password'}
          <input autoFocus aria-label="File password" style={{ width: '100%' }} type="password" autoComplete="off" value={password} required={!isImport} disabled={busy} onChange={(event) => setPassword(event.target.value)} />
        </label>
        {error && <ErrorView error={error} compact />}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn" type="button" disabled={busy} onClick={onClose}>Cancel</button>
          <button className="btn primary" type="submit" disabled={busy || (!isImport && !password)}>
            {busy ? <Spinner /> : isImport ? 'Choose File…' : 'Save File…'}
          </button>
        </div>
      </form>
    </Modal>
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
  const sc = useShortcuts();
  const { loadProfiles, connect, disconnectProfile, toast } = useApp();
  const [p, setP] = useState<ConnectionProfile>(initial);
  const [secrets, setSecrets] = useState<Secrets>({});
  const [clearSecret, setClearSecret] = useState<Partial<Record<SecretField, boolean>>>({});
  const [test, setTest] = useState<TestResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const saveButton = useRef<HTMLButtonElement>(null);
  useEffect(() => onMenuCommand((command) => {
    if (command === 'save' && !document.querySelector('[role="dialog"][aria-modal="true"]')) {
      saveButton.current?.click();
    }
  }), []);
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
      if (connected && !(await disconnectProfile(p.id))) return;
      const s = await api.profiles.save({ ...p, name: p.name.trim(), host: p.host.trim() } as ConnectionProfile, secretsToSend());
      await loadProfiles();
      setSecrets({});
      setClearSecret({});
      onSaved(s.profile);
      toast('ok', `Saved “${s.profile.name}”. Secrets are stored in the macOS Keychain.`);
      if (andConnect) await connect(s.profile.id);
    } catch (e) {
      setSaveErr(errorInfo(e).message);
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    try {
      if (!(await disconnectProfile(p.id))) return;
      await api.profiles.remove(p.id);
      await loadProfiles();
      onDeleted?.();
      toast('info', `Deleted “${p.name}” and its Keychain secrets.`);
    } catch (e) { toast('error', errorInfo(e).message); }
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
            {connected && !connecting ? (
              <span className="pill ok">Connected</span>
            ) : (
              <button className="btn primary" onClick={onConnect} disabled={connecting || dirty} aria-busy={connecting}>
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
        <button ref={saveButton} className="btn" aria-keyshortcuts={sc.aria('save')} title={sc.hint('Save connection', 'save')} onClick={() => void save(false)} disabled={saving || (!isNew && !dirty)}>
          Save
        </button>
        <button className="btn primary" onClick={() => void save(true)} disabled={saving} aria-busy={saving}>
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
            <button className="btn small" onClick={() => { void disconnectProfile(p.id).catch((e) => toast('error', errorInfo(e).message)); }}>
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
              Delete connection
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
