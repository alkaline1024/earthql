import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { DRIVER_LABELS, type ErrorInfo, type ObjectPath, type TreeNode } from '@earthql/core';
import { api, errorInfo } from '../api';
import { connectionName, containerKey, noteError, orderedConnectionIds, pinnedTableKey, useApp, type Theme } from '../store';
import { TableGroupMenu, TableTreeContextMenu, TableTreeSelection } from './TableTreeSelection';
import { useTableTreeSelection } from './table-tree-selection-context';
import { treeNodeKey } from '../tree-selection';
import { canDropTableNodes, TABLE_GROUP_DRAG_TYPE, TABLE_NODES_DRAG_TYPE, tableGroupContainer, tableNodesDragData, type TableGroup } from '../table-groups';
import type { TableAction } from '../../../shared/table-actions';
import { TableImportDialog } from './TableImportDialog';
import { ContextSubmenu } from './ContextSubmenu';
import type { TableImportFormat } from '../../../shared/api';
import { objectHasUnsavedChanges } from '../unsaved-changes';
import { DriverIcon, EnvBadge, ErrorView, Modal, Spinner, categoryTitle } from './common';
import { Kbd, useShortcuts } from './Shortcut';
import { effectiveAccelerator, matchesAccelerator } from '../../../shared/keybindings';

import { QueryLibrary } from './QueryLibrary';
import { SidebarResizeHandle } from './SidebarResizeHandle';
import { ObjectIcon } from './ObjectIcon';

function nodePathAsContainer(n: TreeNode): Partial<ObjectPath> {
  if (n.kind === 'catalog') return { catalog: n.name };
  if (n.kind === 'database') return { ...n.path, database: n.name };
  if (n.kind === 'schema') return { ...n.path, schema: n.name };
  return n.path;
}

export function Sidebar() {
  const sidebarWidth = useApp((s) => s.sidebarWidth);
  const sc = useShortcuts();
  const section = useApp((s) => s.sidebarSection);
  const setSection = useApp((s) => s.setSidebarSection);
  const activeSql = useApp((s) => s.tabs.some((t) => t.id === s.activeTabId && t.kind === 'sql' && t.profileId === s.activeProfileId));
  const { activeProfileId, connections, setActiveProfile, setScreen, newSqlTab, disconnect, connect } = useApp();
  const connecting = useApp((s) => s.connecting);
  const profiles = useApp((s) => s.profiles);
  const connectionOrder = useApp((s) => s.sidebarConnectionOrder);
  const moveConnection = useApp((s) => s.moveConnection);
  const conn = activeProfileId ? connections[activeProfileId] : undefined;
  const summary = profiles.find((p) => p.profile.id === conn?.profileId);
  const openConnections = orderedConnectionIds(connections, connectionOrder).flatMap((id) => {
    const connection = connections[id];
    const profile = profiles.find((p) => p.profile.id === connection.profileId)?.profile;
    return profile ? [{ id, profile, connection }] : [];
  });
  const showSwitcher = openConnections.length > 1;
  const connectionListRef = useRef<HTMLElement>(null);
  const [draggingConnection, setDraggingConnection] = useState<string | null>(null);
  const [connectionDrop, setConnectionDrop] = useState<{ id: string; after: boolean } | null>(null);
  const [filter, setFilter] = useState('');
  const [split, setSplit] = useState<{ sessionId: string; name?: string } | null>(null);
  const [connectionMenu, setConnectionMenu] = useState<{ sessionId: string; x: number; y: number; trigger: HTMLElement; alignRight: boolean; details?: boolean } | null>(null);
  const connectionMenuRef = useRef<HTMLDivElement>(null);
  const menuConnection = connectionMenu ? connections[connectionMenu.sessionId] : undefined;

  const menuProfile = profiles.find(({ profile }) => profile.id === menuConnection?.profileId)?.profile;
  const theme = useApp((s) => s.theme);
  const setTheme = useApp((s) => s.setTheme);

  useLayoutEffect(() => {
    const element = connectionMenuRef.current;
    if (!connectionMenu || !element) return;
    const left = connectionMenu.alignRight ? connectionMenu.x - element.offsetWidth : connectionMenu.x;
    element.style.left = `${Math.max(8, Math.min(left, window.innerWidth - element.offsetWidth - 8))}px`;
    element.style.top = `${Math.max(8, Math.min(connectionMenu.y, window.innerHeight - element.offsetHeight - 8))}px`;
    element.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [connectionMenu]);

  useEffect(() => {
    if (!connectionMenu) return;
    const close = () => setConnectionMenu(null);
    const dismiss = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || connectionMenuRef.current?.contains(event.target)) return;
      if (connectionMenu.trigger.contains(event.target)) return;
      close();
    };
    window.addEventListener('pointerdown', dismiss);
    window.addEventListener('resize', close);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('pointerdown', dismiss);
      window.removeEventListener('resize', close);
      window.removeEventListener('blur', close);
    };
  }, [connectionMenu]);

  function openConnectionMenu(event: MouseEvent<HTMLElement>, sessionId: string, details = false) {
    event.preventDefault();
    const trigger = event.currentTarget;
    const bounds = trigger.getBoundingClientRect();
    const alignRight = event.type === 'click' && !details;
    const anchored = details || alignRight || (event.clientX === 0 && event.clientY === 0);
    setConnectionMenu((current) => {
      if (anchored && current?.trigger === trigger) return null;
      return { sessionId, trigger, alignRight, details, x: alignRight ? bounds.right : anchored ? bounds.left : event.clientX,
        y: anchored ? bounds.bottom + 4 : event.clientY };
    });
  }

  async function reconnectConnection(sessionId: string) {
    setConnectionMenu(null);
    if (!await connect(sessionId)) {
      const state = useApp.getState();
      const error = state.connectErrors[sessionId];
      if (error) state.toast('error', error.message);
    }
  }

  return (
    <aside className={`sidebar${showSwitcher ? ' sidebar-with-switcher' : ''}`} style={{ width: sidebarWidth }}>
      <SidebarResizeHandle />
      <div className="sidebar-top drag">
        <span className="spacer" />
        <button type="button" className="btn small ghost no-drag" title="Connections" onClick={() => setScreen('connections')}>
          <span className="sidebar-chevron left" aria-hidden="true" /> Connections
        </button>
      </div>

      <div className="sidebar-body">
        {showSwitcher && (
          <nav className="connection-switcher" aria-label="Open connections" ref={connectionListRef}
            onDragOver={(event) => {
              if (!draggingConnection) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = 'move';
              const list = connectionListRef.current;
              if (!list) return;
              const bounds = list.getBoundingClientRect();
              if (event.clientY < bounds.top + 36) list.scrollTop -= 18;
              else if (event.clientY > bounds.bottom - 36) list.scrollTop += 18;
            }}>
            {openConnections.map(({ id, profile, connection }) => {
              const name = connectionName(id);
              const lost = connection.status === 'lost';
              return (
                <button
                  key={id}
                  className={`connection-switcher-item${draggingConnection === id ? ' dragging' : ''}${connectionDrop?.id === id ? (connectionDrop.after ? ' drop-after' : ' drop-before') : ''}`}
                  style={{ '--env': profile.env.color || 'var(--accent)' } as CSSProperties}
                  type="button"
                  draggable
                  aria-label={name}
                  aria-pressed={id === activeProfileId}
                  aria-busy={!!connecting[id]}
                  aria-haspopup="menu"
                  title={`${lost ? `${name} (connection lost)` : name} — Drag to reorder connections`}
                  onDragStart={(event) => {
                    event.dataTransfer.effectAllowed = 'move';
                    event.dataTransfer.setData('text/plain', id);
                    setConnectionMenu(null);
                    setDraggingConnection(id);
                  }}
                  onDragOver={(event) => {
                    if (!draggingConnection) return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = 'move';
                    const bounds = event.currentTarget.getBoundingClientRect();
                    setConnectionDrop(draggingConnection === id ? null : { id, after: event.clientY > bounds.top + bounds.height / 2 });
                  }}
                  onDragLeave={(event) => {
                    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setConnectionDrop(null);
                  }}
                  onDrop={(event) => {
                    if (!draggingConnection) return;
                    event.preventDefault();
                    event.stopPropagation();
                    const bounds = event.currentTarget.getBoundingClientRect();
                    moveConnection(draggingConnection, id, event.clientY > bounds.top + bounds.height / 2);
                    setDraggingConnection(null);
                    setConnectionDrop(null);
                  }}
                  onDragEnd={() => {
                    setDraggingConnection(null);
                    setConnectionDrop(null);
                  }}
                  onClick={() => setActiveProfile(id)}
                  onContextMenu={(event) => openConnectionMenu(event, id)}
                >
                  <span aria-hidden="true"><DriverIcon driver={profile.driver} size={22} /></span>
                  <span className="connection-switcher-name">{connection.scope?.name ?? name}</span>
                  {connection.scope && <span className="connection-switcher-source">{profile.name}</span>}
                  {lost && <span className="connection-switcher-status">Connection lost</span>}
                </button>
              );
            })}
          </nav>
        )}

        <div className="sidebar-browser">
          <div className="sidebar-sections" role="tablist" aria-label="Sidebar">
            {(['items', 'queries', 'history'] as const).map((item) => (
              <button type="button" key={item} role="tab" id={`sidebar-tab-${item}`} aria-selected={section === item} aria-controls={`sidebar-panel-${item}`} tabIndex={section === item ? 0 : -1}
                onClick={() => setSection(item)} onKeyDown={(event) => {
                  const items = ['items', 'queries', 'history'] as const;
                  const index = items.indexOf(item);
                  const next = event.key === 'ArrowRight' ? (index + 1) % 3 : event.key === 'ArrowLeft' ? (index + 2) % 3 : event.key === 'Home' ? 0 : event.key === 'End' ? 2 : -1;
                  if (next < 0) return;
                  event.preventDefault();
                  setSection(items[next]);
                  document.getElementById(`sidebar-tab-${items[next]}`)?.focus();
                }}>{item === 'items' ? 'Items' : item === 'queries' ? 'Queries' : 'History'}</button>
            ))}
          </div>
          <div className="sidebar-section-content" role="tabpanel" id={`sidebar-panel-${section}`} aria-labelledby={`sidebar-tab-${section}`}>

          {summary && conn && activeProfileId && (
            <>
              <div className="row" style={{ padding: '2px 12px 6px' }} onContextMenu={(event) => openConnectionMenu(event, activeProfileId)}>
                <button type="button" className="sidebar-connection-trigger grow" aria-haspopup="dialog"
                  aria-expanded={connectionMenu?.details === true} onClick={(event) => openConnectionMenu(event, activeProfileId, true)}>
                  {!showSwitcher && !summary.profile.env.name && connecting[activeProfileId]
                    ? <span className="sidebar-reconnect-spinner" role="status" aria-label="Reconnecting"><Spinner /></span>
                    : <DriverIcon driver={summary.profile.driver} size={20} />}
                  <span className="sidebar-connection-title">
                    <b title={connectionName(activeProfileId)}>{connectionName(activeProfileId)}</b>
                    <EnvBadge env={summary.profile.env} busy={!!connecting[activeProfileId]} />
                  </span>
                  <span className="ctx-connection-chevron" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className="btn icon ghost"
                  aria-label="Connection actions"
                  aria-haspopup="menu"
                  aria-expanded={connectionMenu?.alignRight === true && connectionMenu.sessionId === activeProfileId}
                  onClick={(event) => openConnectionMenu(event, activeProfileId)}
                >
                  <span aria-hidden="true">☰</span>
                </button>
              </div>
              {conn.status === 'lost' && (
                <div className="banner" style={{ margin: '0 8px 6px', borderRadius: 6 }}>
                  <span className="grow">Connection lost.</span>
                  <button className="btn small" onClick={() => void connect(activeProfileId)}>
                    Reconnect
                  </button>
                </div>
              )}
              <div style={{ display: section === 'items' ? 'contents' : 'none' }}>
              <div style={{ padding: '0 10px 6px' }}>
                <input className="input" style={{ width: '100%' }} placeholder="Filter loaded objects" value={filter} onChange={(e) => setFilter(e.target.value)} />
              </div>
              <TableTreeSelection key={activeProfileId} profileId={activeProfileId} filter={filter}>
                <TreeChildren key={activeProfileId} profileId={activeProfileId} parent={null} depth={0} filter={filter.toLowerCase()}
                  onSeparate={conn.status === 'connected' ? (name) => setSplit({ sessionId: activeProfileId, name }) : undefined} />
              </TableTreeSelection>
              </div>
            </>
          )}
          <div id="sidebar-query-library" className="sidebar-library" hidden={section === 'items'}>
            {conn && activeProfileId && section !== 'items' && !activeSql && (
              <QueryLibrary key={activeProfileId} profileId={activeProfileId} mode={section === 'history' ? 'history' : 'saved'} version={0}
                saving={null} onSavingChange={() => {}} getText={() => ''} ctx={conn.defaultContext}
                onOpen={(sql, context) => newSqlTab(activeProfileId, sql, context)} onSaved={() => {}} />
            )}
          </div>
          {!conn && (
            <div className="state">
              <p>No open connection.</p>
              <button className="btn" onClick={() => setScreen('connections')}>
                Open connections
              </button>
            </div>
          )}
          </div>
        </div>
      </div>
      {connectionMenu?.details && menuConnection && menuProfile && (
        <div className="sidebar-connection-details" ref={connectionMenuRef} role="dialog" aria-label="Connection details"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              setConnectionMenu(null);
              connectionMenu.trigger.focus();
            }
          }}>
          <div className="row sidebar-connection-details-title">
            <DriverIcon driver={menuProfile.driver} size={20} />
            <b>{connectionName(connectionMenu.sessionId)}</b>
            <EnvBadge env={menuProfile.env} />
          </div>
          <dl>
            <dt>Host</dt><dd>{menuProfile.host}{'port' in menuProfile ? `:${menuProfile.port}` : ''}</dd>
            <dt>Driver</dt><dd>{DRIVER_LABELS[menuProfile.driver]}</dd>
            <dt>{menuProfile.driver === 'databricks' ? 'Catalog' : 'Database'}</dt>
            <dd>{menuConnection.defaultContext.database ?? menuConnection.defaultContext.catalog ?? '—'}</dd>
            {'user' in menuProfile && <><dt>User</dt><dd>{menuProfile.user}</dd></>}
            {'tls' in menuProfile && <><dt>TLS mode</dt><dd>{menuProfile.tls.mode}</dd></>}
          </dl>
          <label className="row">Theme<select className="select grow" value={theme} onChange={(event) => setTheme(event.target.value as Theme)}>
            {(['system', 'light', 'dark', 'white', 'slate', 'sepia'] as const).map((value) => <option key={value} value={value}>{value === 'system' ? 'Auto' : value[0].toUpperCase() + value.slice(1)}</option>)}
          </select></label>
          <div className="row sidebar-connection-details-actions">
            <button type="button" className="btn" onClick={() => { setConnectionMenu(null); void disconnect(connectionMenu.sessionId); }}>Disconnect</button>
            <span className="spacer" />
            <button type="button" className="btn" disabled={!!connecting[connectionMenu.sessionId]} onClick={() => void reconnectConnection(connectionMenu.sessionId)}>Reconnect</button>
            <button type="button" className="btn" onClick={() => {
              useApp.setState({ editProfileId: menuProfile.id });
              setScreen('connections');
            }}>Edit</button>
          </div>
        </div>
      )}
      {connectionMenu && !connectionMenu.details && menuConnection && (
        <div className="conn-context-menu sidebar-connection-menu" ref={connectionMenuRef} role="menu" aria-label="Open connection actions" onKeyDown={(event) => {
          if (event.key === 'Escape' || event.key === 'Tab') {
            if (event.key === 'Escape') event.preventDefault();
            setConnectionMenu(null);
            connectionMenu.trigger.focus();
          } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
            const index = buttons.findIndex((button) => button === document.activeElement);
            const step = event.key === 'ArrowDown' ? 1 : -1;
            buttons[(index + step + buttons.length) % buttons.length]?.focus();
          }
        }}>
          <button type="button" role="menuitem" aria-keyshortcuts={sc.aria('new-sql-tab')} onClick={() => {
            setConnectionMenu(null);
            newSqlTab(connectionMenu.sessionId);
          }}><span>New SQL Query</span><Kbd id="new-sql-tab" /></button>
          <button type="button" role="menuitem" disabled={menuConnection.status !== 'connected'} onClick={() => {
            setSplit({ sessionId: connectionMenu.sessionId });
            setConnectionMenu(null);
          }}>Open Separate Connection…</button>
          <button type="button" role="menuitem" disabled={!!connecting[connectionMenu.sessionId]}
            onClick={() => void reconnectConnection(connectionMenu.sessionId)}>Reconnect</button>
          <button type="button" role="menuitem" onClick={() => {
            setConnectionMenu(null);
            void disconnect(connectionMenu.sessionId);
          }}>Close Connection</button>
        </div>
      )}
      {split && <SplitConnectionDialog sessionId={split.sessionId} initialName={split.name} onClose={() => setSplit(null)} />}
    </aside>
  );
}

function SplitConnectionDialog({ sessionId, initialName, onClose }: { sessionId: string; initialName?: string; onClose: () => void }) {
  const kind = useApp((s) => s.connections[sessionId]?.capabilities.hierarchy[0]);
  const defaultName = useApp((s) => kind === 'catalog' ? s.connections[sessionId]?.defaultContext.catalog : s.connections[sessionId]?.defaultContext.database);
  const openSeparate = useApp((s) => s.openSeparate);
  const [names, setNames] = useState<string[] | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState<ErrorInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const label = kind === 'catalog' ? 'Catalog' : 'Database';

  useEffect(() => {
    let alive = true;
    api.meta.children(sessionId, null).then((nodes) => {
      if (!alive) return;
      const choices = nodes.filter((node) => node.kind === kind).map((node) => node.name);
      setNames(choices);
      setName(initialName && choices.includes(initialName) ? initialName : choices.find((choice) => choice !== defaultName) ?? choices[0] ?? '');
    }).catch((e) => { if (alive) { setNames([]); setError(errorInfo(e)); } });
    return () => { alive = false; };
  }, [sessionId, kind, initialName, defaultName]);

  return (
    <Modal title="Open Separate Connection" narrow onClose={() => { if (!busy) onClose(); }}>
      <form onSubmit={async (event) => {
        event.preventDefault();
        if (!name || busy) return;
        setBusy(true);
        setError(null);
        try { await openSeparate(sessionId, name); onClose(); }
        catch (e) { setError(errorInfo(e)); }
        finally { setBusy(false); }
      }}>
        {!names ? <Spinner /> : names.length ? (
          <label>
            {label}
            <select className="select" style={{ width: '100%', marginTop: 4 }} value={name} disabled={busy} onChange={(event) => setName(event.target.value)}>
              {names.map((choice) => <option key={choice} value={choice}>{choice}</option>)}
            </select>
          </label>
        ) : !error && <p className="muted">No {label.toLowerCase()} is visible to this connection.</p>}
        {error && <ErrorView error={error} compact />}
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
          <button type="button" className="btn" disabled={busy} onClick={onClose}>Cancel</button>
          <button type="submit" className="btn primary" disabled={!name || busy} aria-busy={busy}>{busy ? <Spinner /> : 'Open Connection'}</button>
        </div>
      </form>
    </Modal>
  );
}

// Each reconnect replaces the session object, so metadata from the old session is discarded.
const treeCache = new WeakMap<object, Map<string, {
  revision: number;
  request: Promise<TreeNode[]>;
  nodes?: TreeNode[];
}>>();

function TreeChildren({ profileId, parent, depth, filter, onSeparate }: { profileId: string; parent: TreeNode | null; depth: number; filter: string; onSeparate?: (name: string) => void }) {
  const selection = useTableTreeSelection();
  const key = containerKey(profileId, parent ? nodePathAsContainer(parent) : {});
  const refresh = useApp((s) => s.treeRefresh[key] ?? 0);
  const connection = useApp((s) => s.connections[profileId]);
  const scope = parent ? undefined : connection?.scope;
  const pinProfileId = useApp((s) => s.connections[profileId]?.profileId ?? profileId);
  const pinnedTables = useApp((s) => s.pinnedTables);
  const defaultDatabase = useApp((s) => s.connections[profileId]?.defaultContext.database);
  const [showOtherDatabases, setShowOtherDatabases] = useState(false);
  const cached = connection && treeCache.get(connection)?.get(key);
  const [nodes, setNodes] = useState<TreeNode[] | null>(() => cached?.revision === refresh ? cached.nodes ?? null : null);
  const [error, setError] = useState<ErrorInfo | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    if (!connection) return;
    let entries = treeCache.get(connection);
    if (!entries) {
      entries = new Map();
      treeCache.set(connection, entries);
    }
    let entry = entries.get(key);
    if (!entry || entry.revision !== refresh) {
      const request = api.meta.children(profileId, parent).then((children) =>
        scope ? children.filter((node) => node.kind === scope.kind && node.name === scope.name) : children,
      );
      const pending = { revision: refresh, request, nodes: undefined as TreeNode[] | undefined };
      const cache = entries;
      cache.set(key, pending);
      void request.then((children) => { pending.nodes = children; }, () => {
        if (cache.get(key) === pending) cache.delete(key);
      });
      entry = pending;
    }
    let current = true;
    setError(null);
    if (entry.nodes) setNodes(entry.nodes);
    else void entry.request.then(
      (children) => { if (current) setNodes(children); },
      (failure) => {
        if (!current) return;
        const info = errorInfo(failure);
        noteError(profileId, info);
        setError(info);
        setNodes([]);
      },
    );
    return () => { current = false; };
  }, [connection, key, refresh, profileId, parent, scope, retry]);

  const pad = 6 + depth * 14;
  if (nodes === null)
    return (
      <div className="tree-msg row" style={{ paddingLeft: pad + 18 }}>
        <Spinner /> Loading…
      </div>
    );
  if (error)
    return (
      <div className="tree-msg err" style={{ paddingLeft: pad + 18 }} title={error.message}>
        {categoryTitle(error.category)}: {error.message.split('\n')[0]}
        <div>
          <button className="btn small" style={{ marginTop: 4 }} onClick={() => setRetry((value) => value + 1)}>
            Retry
          </button>
        </div>
      </div>
    );
  const hierarchy = connection?.capabilities.hierarchy ?? [];
  const leafParent = parent?.kind === 'schema' || (parent?.kind === 'database' && hierarchy[1] === 'table');
  const containers = new Set(nodes.filter((node) => !node.hasChildren).map((node) => tableGroupContainer(node.path)));
  if (leafParent || (!parent && hierarchy[0] === 'table')) {
    containers.add(tableGroupContainer(parent ? nodePathAsContainer(parent) : connection?.defaultContext ?? {}));
  }
  const scopedGroups = selection.groups.filter((group) => containers.has(group.container));
  if (nodes.length === 0 && scopedGroups.length === 0) {
    const what = leafParent ? 'No tables or views (or none visible to this account)' : parent ? 'No schemas visible' : 'Nothing visible to this account';
    return (
      <div className="tree-msg" style={{ paddingLeft: pad + 18 }}>
        {what}
      </div>
    );
  }
  const hasOtherDatabases = !parent && !!defaultDatabase
    && nodes.some((node) => node.kind === 'database' && node.name === defaultDatabase)
    && nodes.some((node) => node.kind === 'database' && node.name !== defaultDatabase);
  const visible = hasOtherDatabases && !showOtherDatabases
    ? nodes.filter((node) => node.kind !== 'database' || node.name === defaultDatabase)
    : nodes;
  const shown = filter ? visible.filter((node) => node.hasChildren || node.name.toLowerCase().includes(filter)) : visible;
  const ordered = pinnedTables.length
    ? [...shown].sort((a, b) => Number(!pinnedTables.includes(pinnedTableKey(pinProfileId, a))) - Number(!pinnedTables.includes(pinnedTableKey(pinProfileId, b))))
    : shown;
  const groups = scopedGroups.filter((group) => !filter || ordered.some((node) => group.nodeKeys.includes(treeNodeKey(node))));
  const grouped = new Set(groups.flatMap((group) => group.nodeKeys));
  return (
    <>
      {groups.map((group) => <TableGroupBranch key={group.id} group={group} depth={depth} filter={filter}>
        {ordered.filter((node) => !node.hasChildren && group.nodeKeys.includes(treeNodeKey(node))).map((node) =>
          <TreeItem key={treeNodeKey(node)} profileId={profileId} node={node} depth={depth + 1} filter={filter} onSeparate={onSeparate} />)}
      </TableGroupBranch>)}
      <UngroupedTableDropArea containers={containers} depth={depth}>
        {ordered.filter((node) => node.hasChildren || !grouped.has(treeNodeKey(node))).map((n) => (
          <TreeItem key={n.kind + n.name} profileId={profileId} node={n} depth={depth} filter={filter} onSeparate={onSeparate} />
        ))}
      </UngroupedTableDropArea>
      {hasOtherDatabases && (
        <button type="button" className="btn small ghost" style={{ margin: '6px 10px' }}
          aria-expanded={showOtherDatabases} onClick={() => setShowOtherDatabases((show) => !show)}>
          {showOtherDatabases ? 'Hide other databases' : 'Show other databases'}
        </button>
      )}
    </>
  );
}

export function TableGroupBranch({ group, depth, filter, children }: {
  group: TableGroup; depth: number; filter: string; children: ReactNode;
}) {
  const selection = useTableTreeSelection();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const header = useRef<HTMLDivElement>(null);
  const [dropAfter, setDropAfter] = useState<boolean | null>(null);
  const [dropNodes, setDropNodes] = useState(false);
  const source = selection.groups.find((item) => item.id === selection.draggedGroup);
  const canDrop = !!source && source.id !== group.id && source.profileId === group.profileId && source.container === group.container;
  const canDropNodes = canDropTableNodes(selection.draggedNodes, new Set([group.container]));
  useEffect(() => { setDropAfter(null); setDropNodes(false); }, [selection.draggedGroup, selection.draggedNodes]);
  const expanded = !group.collapsed || !!filter;
  return <div role="treeitem" aria-level={depth + 1} aria-expanded={expanded} aria-label={group.name}
    style={{
      opacity: selection.draggedGroup === group.id ? 0.45 : undefined,
      boxShadow: canDropNodes && dropNodes ? 'inset 0 0 0 2px var(--accent)'
        : canDrop && dropAfter !== null ? `inset 0 ${dropAfter ? '-2' : '2'}px 0 var(--accent)` : undefined,
    }}
    onDragOver={(event) => {
      if (canDropNodes && event.dataTransfer.types.includes(TABLE_NODES_DRAG_TYPE)) {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        setDropNodes(true);
        return;
      }
      if (!canDrop || !header.current || !event.dataTransfer.types.includes(TABLE_GROUP_DRAG_TYPE)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      const bounds = header.current.getBoundingClientRect();
      setDropAfter(event.clientY > bounds.top + bounds.height / 2);
    }}
    onDragLeave={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) { setDropAfter(null); setDropNodes(false); }
    }}
    onDrop={(event) => {
      if (canDropNodes && selection.draggedNodes
        && event.dataTransfer.getData(TABLE_NODES_DRAG_TYPE) === tableNodesDragData(selection.draggedNodes)) {
        event.preventDefault();
        event.stopPropagation();
        selection.assignGroup(selection.draggedNodes, group.id);
        selection.setDraggedNodes(null);
        setDropNodes(false);
        return;
      }
      if (!canDrop || !source || !header.current || event.dataTransfer.getData(TABLE_GROUP_DRAG_TYPE) !== source.id) return;
      event.preventDefault();
      event.stopPropagation();
      const bounds = header.current.getBoundingClientRect();
      selection.moveGroup(source.id, group.id, event.clientY > bounds.top + bounds.height / 2);
      selection.setDraggedGroup(null);
      setDropAfter(null);
    }}>
    <div className="sidebar-table-group-row" ref={header} style={{ paddingLeft: 6 + depth * 14, color: group.color }}
      onContextMenu={(event) => { event.preventDefault(); setMenu({ x: event.clientX, y: event.clientY }); }}>
      <button type="button" ref={toggle} className="sidebar-table-group-toggle" aria-expanded={expanded} draggable
        title="Drag to reorder groups" style={{ cursor: selection.draggedGroup === group.id ? 'grabbing' : 'grab' }}
        onDragStart={(event) => {
          event.stopPropagation();
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData(TABLE_GROUP_DRAG_TYPE, group.id);
          setMenu(null);
          selection.setDraggedGroup(group.id);
        }}
        onDragEnd={() => { selection.setDraggedGroup(null); setDropAfter(null); }}
        onClick={() => selection.collapseGroups(expanded, group.id)}>
        <span className={`chev${expanded ? ' open' : ''}`} aria-hidden="true">▶</span>
        <span className="sidebar-table-group-dot" style={{ background: group.color }} />
        <span className="name">{group.name}</span>
      </button>
      <button type="button" className="sidebar-table-group-edit" title="Edit Group"
        aria-label={`Edit group ${group.name}`} onClick={() => selection.editGroup(group)}>…</button>
    </div>
    {expanded && <div role="group">{children}</div>}
    {menu && <TableTreeContextMenu position={menu} onClose={() => setMenu(null)} onEscape={() => toggle.current?.focus()}>
      <TableGroupMenu group={group} onClose={() => setMenu(null)} />
    </TableTreeContextMenu>}
  </div>;
}

export function UngroupedTableDropArea({ containers, depth, children }: {
  containers: ReadonlySet<string>; depth: number; children?: ReactNode;
}) {
  const selection = useTableTreeSelection();
  const [hover, setHover] = useState(false);
  const nodes = selection.draggedNodes;
  const keys = new Set(nodes?.map(treeNodeKey));
  const canDrop = canDropTableNodes(nodes, containers)
    && selection.groups.some((group) => group.nodeKeys.some((key) => keys.has(key)));
  useEffect(() => { setHover(false); }, [nodes]);
  return <div role={containers.size ? 'group' : undefined} aria-label={containers.size ? 'Ungrouped tables and views' : undefined}
    style={{ boxShadow: canDrop && hover ? 'inset 0 0 0 2px var(--accent)' : undefined }}
    onDragOver={(event) => {
      if (!canDrop || !event.dataTransfer.types.includes(TABLE_NODES_DRAG_TYPE)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      setHover(true);
    }}
    onDragLeave={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setHover(false);
    }}
    onDrop={(event) => {
      if (!canDrop || !nodes || event.dataTransfer.getData(TABLE_NODES_DRAG_TYPE) !== tableNodesDragData(nodes)) return;
      event.preventDefault();
      event.stopPropagation();
      selection.assignGroup(nodes, null);
      selection.setDraggedNodes(null);
      setHover(false);
    }}>
    {canDrop && <div className="tree-msg" style={{ paddingLeft: 6 + depth * 14, paddingTop: 10, paddingBottom: 10 }}>
      Drop here to remove from Group
    </div>}
    {children}
  </div>;
}

export function TreeItem({ profileId, node, depth, filter, onSeparate }: { profileId: string; node: TreeNode; depth: number; filter: string; onSeparate?: (name: string) => void }) {
  const sc = useShortcuts();
  const selection = useTableTreeSelection();
  const selectedNodes = selection.selected.some((item) => treeNodeKey(item) === treeNodeKey(node)) ? selection.selected : [node];
  const multiple = selectedNodes.length > 1;
  const allTables = selectedNodes.every((item) => item.kind === 'table');
  const [importFormat, setImportFormat] = useState<TableImportFormat | null>(null);
  const [open, setOpen] = useState(() => depth === 0 && (node.kind === 'database'
    ? useApp.getState().connections[profileId]?.defaultContext.database === node.name
    : node.detail === 'default'));
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const { openTab, newSqlTab, refreshTree, setTablePinned, activeTabId, tabs } = useApp();
  const conn = useApp((s) => s.connections[profileId]);
  const unsaved = useApp((s) => objectHasUnsavedChanges(s.tabs, s.gridDrafts, profileId, node.path, node.kind, s.unsavedStructureTabs));
  const pinnedTables = useApp((s) => s.pinnedTables);
  const pinProfileId = conn?.profileId ?? profileId;
  const isSelected = !node.hasChildren && selection.selected.some((item) => treeNodeKey(item) === treeNodeKey(node));
  const draggable = node.kind === 'table' || node.kind === 'view';
  const dragging = selection.draggedNodes?.some((item) => treeNodeKey(item) === treeNodeKey(node));
  const isPinned = !node.hasChildren && pinnedTables.includes(pinnedTableKey(pinProfileId, node));
  const allSelectedPinned = !node.hasChildren && selectedNodes.every((item) => pinnedTables.includes(pinnedTableKey(pinProfileId, item)));

  const container = nodePathAsContainer(node);
  const tableContainer = node.kind === 'schema' || (node.kind === 'database' && conn?.capabilities.hierarchy[1] === 'table');
  const canCreateHere = conn?.capabilities.createTable && (node.kind === 'schema' || (node.kind === 'database' && conn.capabilities.hierarchy[1] === 'table'));

  const isDefaultDatabase = node.kind === 'database' && conn?.defaultContext.database === node.name;
  const detail = node.kind === 'database' && conn
    ? node.detail?.startsWith('Database list limited:') ? node.detail : isDefaultDatabase ? 'default' : node.detail === 'default' ? undefined : node.detail
    : node.detail;

  async function setDefaultDatabase() {
    if (!conn || conn.scope || conn.status !== 'connected') return;
    try {
      const saved = await api.profiles.setDefaultDatabase(conn.profileId, node.name);
      useApp.setState((state) => ({
        profiles: state.profiles.map((entry) => entry.profile.id === saved.profile.id ? saved : entry),
        connections: Object.fromEntries(Object.entries(state.connections).map(([id, connection]) => [
          id,
          connection.profileId === saved.profile.id && !connection.scope
            ? { ...connection, defaultContext: { database: node.name } }
            : connection,
        ])),
      }));
      useApp.getState().toast('ok', `Default database set to ${node.name}.`);
    } catch (error) {
      useApp.getState().toast('error', errorInfo(error).message);
    }
  }

  function beginAction(action: TableAction) {
    setMenu(null);
    if (allTables && (action !== 'clone' || !multiple)) selection.action(action, selectedNodes);
  }
  function tableShortcut(event: KeyboardEvent<HTMLElement>) {
    if (node.kind !== 'table' || event.repeat) return;
    const action = matchesAccelerator(event, effectiveAccelerator('table-delete', sc.overrides)) ? 'delete'
      : matchesAccelerator(event, effectiveAccelerator('table-truncate', sc.overrides)) ? 'truncate' : null;
    if (!action) return;
    event.preventDefault();
    event.stopPropagation();
    beginAction(action);
  }

  const openObject = (view: 'data' | 'structure' = 'data', nodes: TreeNode[] = [node]) => {
    for (const item of nodes) openTab({ kind: 'table', profileId, object: item.path as ObjectPath, objectKind: item.kind === 'view' ? 'view' : 'table', initialView: view });
  };

  const sqlContext = () => ({ catalog: container.catalog, database: container.database, schema: container.schema });

  return (
    <>
      <div
        ref={rowRef}
        className={`tree-row${isSelected ? ' selected' : ''}${unsaved ? ' unsaved' : ''}`}
        style={{ paddingLeft: 6 + depth * 14, opacity: dragging ? 0.45 : undefined, cursor: draggable ? dragging ? 'grabbing' : 'grab' : undefined }}
        role="treeitem" aria-level={depth + 1} aria-selected={node.hasChildren ? undefined : isSelected} aria-expanded={node.hasChildren ? open : undefined}
        data-tree-node={node.hasChildren ? undefined : JSON.stringify(node)}
        draggable={draggable}
        onDragStart={(event) => {
          if (!draggable) { event.preventDefault(); return; }
          event.stopPropagation();
          event.dataTransfer.effectAllowed = 'move';
          event.dataTransfer.setData(TABLE_NODES_DRAG_TYPE, tableNodesDragData(selectedNodes));
          setMenu(null);
          if (!isSelected) selection.select(node);
          selection.setDraggedNodes([...selectedNodes]);
        }}
        onDragEnd={() => selection.setDraggedNodes(null)}
        tabIndex={0}
        onKeyDown={(event) => {
          tableShortcut(event);
          if (event.key === 'Enter') { event.preventDefault(); if (node.hasChildren) setOpen((current) => !current); else openObject('data', selectedNodes); }
          if (!node.hasChildren && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
            event.preventDefault(); event.stopPropagation();
            const nodes = selection.visible();
            const index = nodes.findIndex((item) => treeNodeKey(item) === treeNodeKey(node));
            const next = nodes[event.key === 'Home' ? 0 : event.key === 'End' ? nodes.length - 1 : Math.max(0, Math.min(nodes.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))];
            if (next) { if (!event.ctrlKey && !event.metaKey || event.shiftKey) selection.select(next, event.ctrlKey || event.metaKey, event.shiftKey); selection.focus(next); }
          }
          if (!node.hasChildren && event.key === ' ') { event.preventDefault(); selection.select(node, event.ctrlKey || event.metaKey, event.shiftKey); }
        }}
        onClick={(event) => {
          event.currentTarget.focus();
          if (node.hasChildren) setOpen((current) => !current);
          else { selection.select(node, event.ctrlKey || event.metaKey, event.shiftKey); if (!event.ctrlKey && !event.metaKey && !event.shiftKey) openObject(); }
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.currentTarget.focus();
          if (!node.hasChildren && !isSelected) selection.select(node);
          setMenu({ x: Math.max(8, Math.min(e.clientX, window.innerWidth - 240)), y: Math.max(8, Math.min(e.clientY, window.innerHeight - 300)) });
        }}
        title={node.hasChildren ? node.name : `${node.name} (${node.kind})${unsaved ? " — Unsaved changes" : ""}`}
      >
        <span className={`chev${open ? ' open' : ''}`}>{node.hasChildren ? '▶' : ''}</span>
        <span className="ico"><ObjectIcon kind={node.kind} /></span>
        <span className="name">{node.name}</span>
        {isPinned && <span className="pin-ico" role="img" aria-label="Pinned" title="Pinned to top">📌</span>}
        {detail && <span className="detail">{detail}</span>}
        {unsaved && <span className="unsaved-dot" role="img" aria-label="Unsaved changes" title="Unsaved changes" />}
      </div>
      {menu && (
        <TableTreeContextMenu position={menu} width={node.hasChildren ? 220 : 270}
          onClose={() => setMenu(null)} onEscape={() => rowRef.current?.focus()} onKeyDown={tableShortcut}>
          {!node.hasChildren && (
            <>
              <MenuItem label="Open data" onClick={() => (setMenu(null), openObject('data', selectedNodes))} />
              <MenuItem label="Open structure" onClick={() => (setMenu(null), openObject('structure', selectedNodes))} />
            </>
          )}
          {(!node.hasChildren || tableContainer) && <TableGroupMenu nodes={node.hasChildren ? [] : selectedNodes}
            node={node.hasChildren ? undefined : node} scope={tableGroupContainer(container)} onClose={() => setMenu(null)} />}
          <MenuItem label="New SQL editor here" onClick={() => (setMenu(null), newSqlTab(profileId, '', sqlContext()))} />
          {!node.hasChildren && (
            <MenuItem
              label={allSelectedPinned ? 'Unpin' : 'Pin to top'}
              onClick={() => (setMenu(null), setTablePinned(pinProfileId, selectedNodes, !allSelectedPinned))}
            />
          )}
          {node.kind === 'database' && conn?.status === 'connected' && !conn.scope && (
            <button type="button" role="menuitem" disabled={isDefaultDatabase} onClick={() => { setMenu(null); void setDefaultDatabase(); }}>
              Set as default
            </button>
          )}
          {onSeparate && (node.kind === 'database' || node.kind === 'catalog') && (
            <MenuItem label="Open in Separate Connection…" onClick={() => { setMenu(null); onSeparate(node.name); }} />
          )}
          {canCreateHere && (
            <MenuItem label="Create table…" onClick={() => (setMenu(null), openTab({ kind: 'create', profileId, container }))} />
          )}
          {!node.hasChildren && <>
            <div className="conn-menu-separator" role="separator" />
            {node.kind === 'table' && <ContextSubmenu label="Import Table" disabled={multiple}>
              <button role="menuitem" onClick={() => { setMenu(null); setImportFormat('csv'); }}>From CSV…</button>
              <button role="menuitem" onClick={() => { setMenu(null); setImportFormat('json'); }}>From JSON…</button>
              <button role="menuitem" onClick={() => { setMenu(null); setImportFormat('sql'); }}>From SQL Dump…</button>
            </ContextSubmenu>}
            <ContextSubmenu label="Export Table">
              <button role="menuitem" onClick={() => { setMenu(null); selection.export(selectedNodes); }}>{multiple ? `Export ${selectedNodes.length} Tables…` : 'Export Table…'}</button>
            </ContextSubmenu>
          </>}
          {node.kind === 'table' && <>
            <div className="conn-menu-separator" role="separator" />
            <MenuItem label={multiple ? 'Copy names' : 'Copy name'} onClick={() => {
              setMenu(null);
              void navigator.clipboard.writeText(selectedNodes.map((item) => item.name).join('\n')).catch((error) => useApp.getState().toast('error', errorInfo(error).message));
            }} />
            <button role="menuitem" disabled={multiple} onClick={() => beginAction('clone')}>Clone…</button>
            <button role="menuitem" disabled={!allTables} className="destructive table-action-menuitem" aria-keyshortcuts={sc.aria('table-truncate')} onClick={() => beginAction('truncate')}><span>{multiple ? `Truncate ${selectedNodes.length} Tables…` : 'Truncate…'}</span><Kbd id="table-truncate" /></button>
            <button role="menuitem" disabled={!allTables} className="destructive table-action-menuitem" aria-keyshortcuts={sc.aria('table-delete')} onClick={() => beginAction('delete')}><span>{multiple ? `Delete ${selectedNodes.length} Tables…` : 'Delete…'}</span><Kbd id="table-delete" /></button>
          </>}
          {node.hasChildren && <MenuItem label="Refresh" onClick={() => (setMenu(null), refreshTree(profileId, container), setOpen(true))} />}
        </TableTreeContextMenu>
      )}
      {importFormat && <TableImportDialog profileId={profileId} object={node.path as ObjectPath} format={importFormat} onClose={() => setImportFormat(null)} />}
      {open && node.hasChildren && <TreeChildren profileId={profileId} parent={node} depth={depth + 1} filter={filter} />}
    </>
  );
}

function MenuItem({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" role="menuitem" onClick={onClick}>{label}</button>
  );
}
