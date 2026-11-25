import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent } from 'react';
import type { ErrorInfo, ObjectPath, TreeNode } from '@earthql/core';
import { api, errorInfo } from '../api';
import { connectionName, containerKey, noteError, useApp } from '../store';
import { TableTreeSelection, useTableTreeSelection } from './TableTreeSelection';
import { treeNodeKey } from '../tree-selection';
import type { TableAction } from '../../../shared/table-actions';
import { TableImportDialog } from './TableImportDialog';
import { ContextSubmenu } from './ContextSubmenu';
import type { TableImportFormat } from '../../../shared/api';
import { objectHasUnsavedChanges } from '../unsaved-changes';
import { DriverIcon, EnvBadge, ErrorView, Modal, Spinner, categoryTitle } from './common';

const ICON: Record<TreeNode['kind'], string> = {
  catalog: '◫',
  database: '⛁',
  schema: '▤',
  table: '▦',
  view: '◇',
};

function nodePathAsContainer(n: TreeNode): Partial<ObjectPath> {
  if (n.kind === 'catalog') return { catalog: n.name };
  if (n.kind === 'database') return { ...n.path, database: n.name };
  if (n.kind === 'schema') return { ...n.path, schema: n.name };
  return n.path;
}

export function Sidebar() {
  const { activeProfileId, connections, setActiveProfile, setScreen, newSqlTab, disconnect, connect } = useApp();
  const profiles = useApp((s) => s.profiles);
  const conn = activeProfileId ? connections[activeProfileId] : undefined;
  const summary = profiles.find((p) => p.profile.id === conn?.profileId);
  const openConnections = Object.entries(connections).flatMap(([id, connection]) => {
    const profile = profiles.find((p) => p.profile.id === connection.profileId)?.profile;
    return profile ? [{ id, profile, connection }] : [];
  });
  const showSwitcher = openConnections.length > 1;
  const [filter, setFilter] = useState('');
  const [split, setSplit] = useState<{ sessionId: string; name?: string } | null>(null);
  const [connectionMenu, setConnectionMenu] = useState<{ sessionId: string; x: number; y: number; trigger: HTMLElement; alignRight: boolean } | null>(null);
  const connectionMenuRef = useRef<HTMLDivElement>(null);
  const menuConnection = connectionMenu ? connections[connectionMenu.sessionId] : undefined;

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
      if (connectionMenu.alignRight && connectionMenu.trigger.contains(event.target)) return;
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

  function openConnectionMenu(event: MouseEvent<HTMLElement>, sessionId: string) {
    event.preventDefault();
    const trigger = event.currentTarget;
    const bounds = trigger.getBoundingClientRect();
    const alignRight = event.type === 'click';
    const anchored = alignRight || (event.clientX === 0 && event.clientY === 0);
    setConnectionMenu((current) => {
      if (alignRight && current?.alignRight && current.trigger === trigger) return null;
      return { sessionId, trigger, alignRight, x: alignRight ? bounds.right : anchored ? bounds.left : event.clientX,
        y: anchored ? bounds.bottom + 4 : event.clientY };
    });
  }

  return (
    <aside className={`sidebar${showSwitcher ? ' sidebar-with-switcher' : ''}`}>
      <div className="sidebar-top drag">
        <span className="spacer" />
        <button type="button" className="btn small ghost no-drag" title="Connections" onClick={() => setScreen('connections')}>
          <span className="sidebar-chevron left" aria-hidden="true" /> Connections
        </button>
      </div>

      <div className="sidebar-body">
        {showSwitcher && (
          <nav className="connection-switcher" aria-label="Open connections">
            {openConnections.map(({ id, profile, connection }) => {
              const name = connectionName(id);
              const lost = connection.status === 'lost';
              return (
                <button
                  key={id}
                  className="connection-switcher-item"
                  style={{ '--env': profile.env.color || 'var(--accent)' } as CSSProperties}
                  type="button"
                  aria-label={name}
                  aria-pressed={id === activeProfileId}
                  aria-haspopup="menu"
                  title={lost ? `${name} (connection lost)` : name}
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
          {summary && conn && activeProfileId && (
            <>
              <div className="row" style={{ padding: '2px 12px 6px' }} onContextMenu={(event) => openConnectionMenu(event, activeProfileId)}>
                <DriverIcon driver={summary.profile.driver} size={20} />
                <div className="grow" style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={connectionName(activeProfileId)}>{connectionName(activeProfileId)}</div>
                  <EnvBadge env={summary.profile.env} />
                </div>
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
              <div style={{ padding: '0 10px 6px' }}>
                <input className="input" style={{ width: '100%' }} placeholder="Filter loaded objects" value={filter} onChange={(e) => setFilter(e.target.value)} />
              </div>
              <TableTreeSelection key={activeProfileId} profileId={activeProfileId} filter={filter}>
                <TreeChildren key={activeProfileId} profileId={activeProfileId} parent={null} depth={0} filter={filter.toLowerCase()}
                  onSeparate={conn.status === 'connected' ? (name) => setSplit({ sessionId: activeProfileId, name }) : undefined} />
              </TableTreeSelection>
            </>
          )}
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
      {connectionMenu && menuConnection && (
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
          <button type="button" role="menuitem" aria-keyshortcuts="Meta+T" onClick={() => {
            setConnectionMenu(null);
            newSqlTab(connectionMenu.sessionId);
          }}><span>New SQL Query</span><kbd>⌘T</kbd></button>
          <button type="button" role="menuitem" disabled={menuConnection.status !== 'connected'} onClick={() => {
            setSplit({ sessionId: connectionMenu.sessionId });
            setConnectionMenu(null);
          }}>Open Separate Connection…</button>
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

function TreeChildren({ profileId, parent, depth, filter, onSeparate }: { profileId: string; parent: TreeNode | null; depth: number; filter: string; onSeparate?: (name: string) => void }) {
  const key = containerKey(profileId, parent ? nodePathAsContainer(parent) : {});
  const refresh = useApp((s) => s.treeRefresh[key] ?? 0);
  const scope = useApp((s) => parent ? undefined : s.connections[profileId]?.scope);
  const [nodes, setNodes] = useState<TreeNode[] | null>(null);
  const [error, setError] = useState<ErrorInfo | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const nodes = await api.meta.children(profileId, parent);
      setNodes(scope ? nodes.filter((node) => node.kind === scope.kind && node.name === scope.name) : nodes);
    } catch (e) {
      const info = errorInfo(e);
      noteError(profileId, info);
      setError(info);
      setNodes([]);
    }
  }, [profileId, parent, scope]);

  useEffect(() => {
    void load();
  }, [load, refresh]);

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
          <button className="btn small" style={{ marginTop: 4 }} onClick={() => void load()}>
            Retry
          </button>
        </div>
      </div>
    );
  if (nodes.length === 0) {
    const hierarchy = useApp.getState().connections[profileId]?.capabilities.hierarchy ?? [];
    const leafParent = parent?.kind === 'schema' || (parent?.kind === 'database' && hierarchy[1] === 'table');
    const what = leafParent ? 'No tables or views (or none visible to this account)' : parent ? 'No schemas visible' : 'Nothing visible to this account';
    return (
      <div className="tree-msg" style={{ paddingLeft: pad + 18 }}>
        {what}
      </div>
    );
  }
  const shown = filter ? nodes.filter((n) => n.hasChildren || n.name.toLowerCase().includes(filter)) : nodes;
  return (
    <>
      {shown.map((n) => (
        <TreeItem key={n.kind + n.name} profileId={profileId} node={n} depth={depth} filter={filter} onSeparate={onSeparate} />
      ))}
    </>
  );
}

function TreeItem({ profileId, node, depth, filter, onSeparate }: { profileId: string; node: TreeNode; depth: number; filter: string; onSeparate?: (name: string) => void }) {
  const selection = useTableTreeSelection();
  const selectedNodes = selection.selected.some((item) => treeNodeKey(item) === treeNodeKey(node)) ? selection.selected : [node];
  const multiple = selectedNodes.length > 1;
  const allTables = selectedNodes.every((item) => item.kind === 'table');
  const [importFormat, setImportFormat] = useState<TableImportFormat | null>(null);
  const [open, setOpen] = useState(node.detail === 'default' && depth === 0);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!menu || !menuRef.current) return;
    const element = menuRef.current;
    element.style.left = `${Math.max(8, Math.min(menu.x, window.innerWidth - element.offsetWidth - 8))}px`;
    element.style.top = `${Math.max(8, Math.min(menu.y, window.innerHeight - element.offsetHeight - 8))}px`;
    element.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [menu]);
  const { openTab, newSqlTab, refreshTree, activeTabId, tabs } = useApp();
  const conn = useApp((s) => s.connections[profileId]);
  const unsaved = useApp((s) => objectHasUnsavedChanges(s.tabs, s.gridDrafts, profileId, node.path, node.kind));
  const isSelected = !node.hasChildren && selection.selected.some((item) => treeNodeKey(item) === treeNodeKey(node));

  const container = nodePathAsContainer(node);
  const canCreateHere = conn?.capabilities.createTable && (node.kind === 'schema' || (node.kind === 'database' && conn.capabilities.hierarchy[1] === 'table'));

  function beginAction(action: TableAction) {
    setMenu(null);
    if (allTables && (action !== 'clone' || !multiple)) selection.action(action, selectedNodes);
  }
  function tableShortcut(event: KeyboardEvent<HTMLElement>) {
    if (node.kind !== 'table' || event.key !== 'Backspace' || event.repeat) return;
    if (event.metaKey && !event.altKey && !event.ctrlKey && !event.shiftKey) { event.preventDefault(); event.stopPropagation(); beginAction('delete'); }
    else if (event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey) { event.preventDefault(); event.stopPropagation(); beginAction('truncate'); }
  }

  const openObject = (view: 'data' | 'structure' = 'data', nodes: TreeNode[] = [node]) => {
    for (const item of nodes) openTab({ kind: 'table', profileId, object: item.path as ObjectPath, objectKind: item.kind === 'view' ? 'view' : 'table', initialView: view });
  };

  const sqlContext = () => ({ catalog: container.catalog, database: container.database, schema: container.schema });

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [menu]);

  return (
    <>
      <div
        ref={rowRef}
        className={`tree-row${isSelected ? ' selected' : ''}${unsaved ? ' unsaved' : ''}`}
        style={{ paddingLeft: 6 + depth * 14 }}
        role="treeitem" aria-level={depth + 1} aria-selected={node.hasChildren ? undefined : isSelected} aria-expanded={node.hasChildren ? open : undefined}
        data-tree-node={node.hasChildren ? undefined : JSON.stringify(node)}
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
        <span className="ico">{ICON[node.kind]}</span>
        <span className="name">{node.name}</span>
        {node.detail && <span className="detail">{node.detail}</span>}
        {unsaved && <span className="unsaved-dot" role="img" aria-label="Unsaved changes" title="Unsaved changes" />}
      </div>
      {menu && (
        <div
          className="conn-context-menu table-tree-context-menu"
          ref={menuRef}
          role="menu" aria-label="Table actions"
          onKeyDown={(event) => {
            tableShortcut(event);
            if (event.key === 'Escape') { setMenu(null); rowRef.current?.focus(); }
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              const root = (event.target as HTMLElement).closest('[role="menu"]') ?? event.currentTarget;
              const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')).filter((button) => button.closest('[role="menu"]') === root);
              const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
              buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
            }
          }}
          style={{ position: 'fixed', left: menu.x, top: menu.y, width: 220, zIndex: 60, padding: 4, borderRadius: 8 }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {!node.hasChildren && (
            <>
              <MenuItem label="Open data" onClick={() => (setMenu(null), openObject('data', selectedNodes))} />
              <MenuItem label="Open structure" onClick={() => (setMenu(null), openObject('structure', selectedNodes))} />
            </>
          )}
          <MenuItem label="New SQL editor here" onClick={() => (setMenu(null), newSqlTab(profileId, '', sqlContext()))} />
          {onSeparate && (node.kind === 'database' || node.kind === 'catalog') && (
            <MenuItem label="Open in Separate Connection…" onClick={() => { setMenu(null); onSeparate(node.name); }} />
          )}
          {canCreateHere && (
            <MenuItem label="Create table…" onClick={() => (setMenu(null), openTab({ kind: 'create', profileId, container }))} />
          )}
          {!node.hasChildren && <>
            <div className="conn-menu-separator" role="separator" />
            {node.kind === 'table' && <ContextSubmenu label="Import" disabled={multiple}>
              <button role="menuitem" onClick={() => { setMenu(null); setImportFormat('csv'); }}>From CSV…</button>
              <button role="menuitem" onClick={() => { setMenu(null); setImportFormat('json'); }}>From JSON…</button>
              <button role="menuitem" onClick={() => { setMenu(null); setImportFormat('sql'); }}>From SQL Dump…</button>
            </ContextSubmenu>}
            <ContextSubmenu label="Export">
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
            <button role="menuitem" disabled={!allTables} className="destructive table-action-menuitem" aria-keyshortcuts="Alt+Backspace" onClick={() => beginAction('truncate')}><span>{multiple ? `Truncate ${selectedNodes.length} Tables…` : 'Truncate…'}</span><kbd>⌥⌫</kbd></button>
            <button role="menuitem" disabled={!allTables} className="destructive table-action-menuitem" aria-keyshortcuts="Meta+Backspace" onClick={() => beginAction('delete')}><span>{multiple ? `Delete ${selectedNodes.length} Tables…` : 'Delete…'}</span><kbd>⌘⌫</kbd></button>
          </>}
          {node.hasChildren && <MenuItem label="Refresh" onClick={() => (setMenu(null), refreshTree(profileId, container), setOpen(true))} />}
        </div>
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
