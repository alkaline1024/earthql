import { useCallback, useEffect, useState } from 'react';
import type { ErrorInfo, ObjectPath, TreeNode } from '@earthql/core';
import { api, errorInfo } from '../api';
import { containerKey, noteError, profileOf, useApp } from '../store';
import { DriverIcon, EnvBadge, Spinner, categoryTitle } from './common';

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
  const summary = activeProfileId ? profiles.find((p) => p.profile.id === activeProfileId) : undefined;
  const openIds = Object.keys(connections);
  const [filter, setFilter] = useState('');

  return (
    <aside className="sidebar">
      <div className="sidebar-top drag">
        <span className="spacer" />
        <button className="btn small ghost no-drag" title="Connections" onClick={() => setScreen('connections')}>
          Connections
        </button>
      </div>

      {openIds.length > 1 && (
        <div style={{ padding: '0 10px 6px' }}>
          <select className="select" style={{ width: '100%' }} value={activeProfileId ?? ''} onChange={(e) => setActiveProfile(e.target.value)}>
            {openIds.map((id) => (
              <option key={id} value={id}>
                {profileOf(id)?.profile.name ?? id}
              </option>
            ))}
          </select>
        </div>
      )}

      {summary && conn && (
        <>
          <div className="row" style={{ padding: '2px 12px 6px' }}>
            <DriverIcon driver={summary.profile.driver} size={20} />
            <div className="grow" style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{summary.profile.name}</div>
              <EnvBadge env={summary.profile.env} />
            </div>
            <button className="btn icon ghost" title="New SQL editor (⌘T)" onClick={() => newSqlTab(summary.profile.id)}>
              ⌨︎
            </button>
            <button className="btn icon ghost" title="Disconnect" onClick={() => void disconnect(summary.profile.id)}>
              ⏏︎
            </button>
          </div>
          {conn.status === 'lost' && (
            <div className="banner" style={{ margin: '0 8px 6px', borderRadius: 6 }}>
              <span className="grow">Connection lost.</span>
              <button className="btn small" onClick={() => void connect(summary.profile.id)}>
                Reconnect
              </button>
            </div>
          )}
          <div style={{ padding: '0 10px 6px' }}>
            <input className="input" style={{ width: '100%' }} placeholder="Filter loaded objects" value={filter} onChange={(e) => setFilter(e.target.value)} />
          </div>
          <div className="tree">
            <TreeChildren key={summary.profile.id} profileId={summary.profile.id} parent={null} depth={0} filter={filter.toLowerCase()} />
          </div>
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
    </aside>
  );
}

function TreeChildren({ profileId, parent, depth, filter }: { profileId: string; parent: TreeNode | null; depth: number; filter: string }) {
  const key = containerKey(profileId, parent ? nodePathAsContainer(parent) : {});
  const refresh = useApp((s) => s.treeRefresh[key] ?? 0);
  const [nodes, setNodes] = useState<TreeNode[] | null>(null);
  const [error, setError] = useState<ErrorInfo | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setNodes(await api.meta.children(profileId, parent));
    } catch (e) {
      const info = errorInfo(e);
      noteError(profileId, info);
      setError(info);
      setNodes([]);
    }
  }, [profileId, parent]);

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
        <TreeItem key={n.kind + n.name} profileId={profileId} node={n} depth={depth} filter={filter} />
      ))}
    </>
  );
}

function TreeItem({ profileId, node, depth, filter }: { profileId: string; node: TreeNode; depth: number; filter: string }) {
  const [open, setOpen] = useState(node.detail === 'default' && depth === 0);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const { openTab, newSqlTab, refreshTree, activeTabId, tabs } = useApp();
  const conn = useApp((s) => s.connections[profileId]);
  const active = tabs.find((t) => t.id === activeTabId);
  const isSelected =
    active?.kind === 'table' &&
    !node.hasChildren &&
    active.profileId === profileId &&
    JSON.stringify(active.object) === JSON.stringify(node.path);

  const container = nodePathAsContainer(node);
  const canCreateHere = conn?.capabilities.createTable && (node.kind === 'schema' || (node.kind === 'database' && conn.capabilities.hierarchy[1] === 'table'));

  const openObject = (view: 'data' | 'structure' = 'data') =>
    openTab({ kind: 'table', profileId, object: node.path as ObjectPath, objectKind: node.kind === 'view' ? 'view' : 'table', initialView: view });

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
        className={`tree-row${isSelected ? ' selected' : ''}`}
        style={{ paddingLeft: 6 + depth * 14 }}
        onClick={() => (node.hasChildren ? setOpen((o) => !o) : openObject())}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
        title={node.hasChildren ? node.name : `${node.name} (${node.kind})`}
      >
        <span className={`chev${open ? ' open' : ''}`}>{node.hasChildren ? '▶' : ''}</span>
        <span className="ico">{ICON[node.kind]}</span>
        <span className="name">{node.name}</span>
        {node.detail && <span className="detail">{node.detail}</span>}
      </div>
      {menu && (
        <div
          className="modal"
          style={{ position: 'fixed', left: menu.x, top: menu.y, width: 220, zIndex: 60, padding: 4, borderRadius: 8 }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {!node.hasChildren && (
            <>
              <MenuItem label="Open data" onClick={() => (setMenu(null), openObject('data'))} />
              <MenuItem label="Open structure" onClick={() => (setMenu(null), openObject('structure'))} />
            </>
          )}
          <MenuItem label="New SQL editor here" onClick={() => (setMenu(null), newSqlTab(profileId, '', sqlContext()))} />
          {canCreateHere && (
            <MenuItem label="Create table…" onClick={() => (setMenu(null), openTab({ kind: 'create', profileId, container }))} />
          )}
          {node.hasChildren && <MenuItem label="Refresh" onClick={() => (setMenu(null), refreshTree(profileId, container), setOpen(true))} />}
        </div>
      )}
      {open && node.hasChildren && <TreeChildren profileId={profileId} parent={node} depth={depth + 1} filter={filter} />}
    </>
  );
}

function MenuItem({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <div className="tree-row" style={{ padding: '0 10px' }} onClick={onClick}>
      {label}
    </div>
  );
}
