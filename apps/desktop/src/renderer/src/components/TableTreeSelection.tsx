import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { ObjectPath, TreeNode } from '@earthql/core';
import type { TableAction } from '../../../shared/table-actions';
import { api, errorInfo, uid } from '../api';
import { useApp } from '../store';
import { selectTreeNodes, treeNodeKey } from '../tree-selection';
import { assignTableGroup, exportTableGroups, importTableGroups, reorderTableGroups, TABLE_GROUP_DRAG_TYPE, TABLE_NODES_DRAG_TYPE, tableGroupContainer, tableGroupParent, type TableGroup } from '../table-groups';
import { parseTableGroupFile, type TableGroupFile } from '../../../shared/table-group-transfer';
import { TAB_GROUP_COLORS } from '../tab-groups';
import { TableActionDialog } from './TableActionDialog';
import { TableExportDialog } from './TableExportDialog';
import { TableTreeSelectionContext as Context, useTableTreeSelection } from './table-tree-selection-context';
import { ContextSubmenu } from './ContextSubmenu';
import { Modal, Spinner } from './common';


export function TableTreeSelection({ profileId, filter, children, renderFooter }: {
  profileId: string; filter: string; children: ReactNode; renderFooter?: (draggedNodes: TreeNode[] | null, reveal: (node: TreeNode) => void) => ReactNode;
}) {
  const [selected, setSelected] = useState<TreeNode[]>([]);
  const anchor = useRef<string | null>(null);
  const tree = useRef<HTMLDivElement>(null);
  const [reveal, setReveal] = useState<{ node: TreeNode } | null>(null);
  const [action, setAction] = useState<{ action: TableAction; nodes: TreeNode[] } | null>(null);
  const [exportNodes, setExportNodes] = useState<TreeNode[] | null>(null);
  const activeTabId = useApp((state) => state.activeTabId);
  const groupProfileId = useApp((state) => state.connections[profileId]?.profileId ?? profileId);
  const allGroups = useApp((state) => state.tableGroups);
  const groups = allGroups.filter((group) => group.profileId === groupProfileId);
  const [draggedGroup, setDraggedGroup] = useState<string | null>(null);
  const [draggedNodes, setDraggedNodes] = useState<TreeNode[] | null>(null);
  const [groupEditor, setGroupEditor] = useState<{ id?: string; name: string; color: string; nodes: TreeNode[] } | null>(null);
  const [groupError, setGroupError] = useState<string | null>(null);
  const importRequest = useRef(0);
  const [importState, setImportState] = useState<{
    container: string; busy: boolean; replace: boolean; file?: TableGroupFile; nodes: TreeNode[];
    matched: number; missing: string[]; error: string | null;
  } | null>(null);
  const closeImport = () => { importRequest.current += 1; setImportState(null); };
  const exportGroups = async (container: string, groupId?: string) => {
    const state = useApp.getState();
    try {
      const file = exportTableGroups(state.tableGroups.filter((group) =>
        group.profileId === groupProfileId && group.container === container && (!groupId || group.id === groupId)));
      const result = await api.groupFiles.save(JSON.stringify(file, null, 2));
      if (result.status === 'ok') state.toast('ok', 'Groups exported.');
    } catch (error) { state.toast('error', errorInfo(error).message); }
  };
  const importGroups = async (container: string) => {
    const request = ++importRequest.current;
    setImportState({ container, busy: true, replace: true, nodes: [], matched: 0, missing: [], error: null });
    try {
      const text = await api.groupFiles.read();
      if (request !== importRequest.current) return;
      if (text === null) { closeImport(); return; }
      const file = parseTableGroupFile(text);
      const nodes = await api.meta.children(profileId, tableGroupParent(container));
      if (request !== importRequest.current) return;
      const preview = importTableGroups([], groupProfileId, container, file, nodes, true, uid);
      setImportState({ container, busy: false, replace: true, file, nodes, matched: preview.matched, missing: preview.missing, error: null });
    } catch (error) {
      if (request === importRequest.current) setImportState((current) =>
        current && { ...current, busy: false, error: errorInfo(error).message });
    }
  };
  const editGroup = (group: TableGroup | null, nodes: TreeNode[] = []) => {
    setGroupError(null);
    setGroupEditor({ id: group?.id, name: group?.name ?? '', color: group?.color ?? TAB_GROUP_COLORS[0], nodes });
  };
  const assignGroup = (nodes: TreeNode[], target: string | null) => {
    const state = useApp.getState();
    try { state.saveTableGroups(assignTableGroup(state.tableGroups, groupProfileId, nodes, target)); }
    catch (error) { state.toast('error', errorInfo(error).message); }
  };
  const collapseGroups = (collapsed: boolean, id?: string) => {
    const state = useApp.getState();
    return state.saveTableGroups(state.tableGroups.map((group) =>
      group.profileId === groupProfileId && (!id || group.id === id) ? { ...group, collapsed } : group));
  };
  const moveGroup = (sourceId: string, targetId: string, after: boolean) => {
    const state = useApp.getState();
    try {
      const next = reorderTableGroups(state.tableGroups, sourceId, targetId, after);
      if (next !== state.tableGroups) state.saveTableGroups(next);
    } catch (error) { state.toast('error', errorInfo(error).message); }
  };
  const visible = () => Array.from(tree.current?.querySelectorAll<HTMLElement>('[data-tree-node]') ?? []).map((row) => JSON.parse(row.dataset.treeNode!) as TreeNode);
  useEffect(() => {
    if (!draggedGroup && !draggedNodes) return;
    const finish = () => { setDraggedGroup(null); setDraggedNodes(null); };
    window.addEventListener('dragend', finish, true);
    window.addEventListener('blur', finish);
    return () => {
      window.removeEventListener('dragend', finish, true);
      window.removeEventListener('blur', finish);
    };
  }, [draggedGroup, draggedNodes]);
  useEffect(() => {
    const tab = useApp.getState().tabs.find((item) => item.id === activeTabId);
    if (tab?.kind === 'table' && tab.profileId === profileId && !tree.current?.contains(document.activeElement)) {
      const node: TreeNode = { kind: tab.objectKind === 'view' ? 'view' : 'table', name: tab.object.name, path: tab.object, hasChildren: false };
      setSelected((current) => current.length > 1 && current.some((item) => treeNodeKey(item) === treeNodeKey(node)) ? current : [node]);
      anchor.current = treeNodeKey(node);
    }
  }, [activeTabId, profileId]);
  useEffect(() => {
    setSelected((items) => items.filter((node) => node.name.toLowerCase().includes(filter.toLowerCase())));
    anchor.current = null;
  }, [filter]);
  useEffect(() => {
    const element = tree.current;
    if (!element) return;
    let previous = new Set(visible().map(treeNodeKey));
    const observer = new MutationObserver(() => {
      const next = new Set(visible().map(treeNodeKey));
      const hidden = new Set([...previous].filter((key) => !next.has(key)));
      previous = next;
      if (hidden.size) setSelected((items) => items.filter((node) => !hidden.has(treeNodeKey(node))));
    });
    observer.observe(element, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);
  const select = (node: TreeNode, toggle = false, range = false) => {
    const ordered = visible();
    setSelected((current) => {
      const next = selectTreeNodes(current, node, ordered, anchor.current, toggle, range);
      anchor.current = next.anchor;
      return next.selected;
    });
  };
  return <Context.Provider value={{ selected, select, visible, groups, editGroup, assignGroup, collapseGroups,
    reveal,
    finishReveal: (node, element, error) => {
      if (node && element) {
        setSelected([node]);
        anchor.current = treeNodeKey(node);
        element.focus({ preventScroll: true });
        element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      } else {
        useApp.getState().toast('error', error ? `Could not locate bookmark: ${error}` : 'Bookmark could not be located in the object tree.');
      }
      setReveal(null);
    },
    exportGroups: (container, id) => { void exportGroups(container, id); },
    importGroups: (container) => { void importGroups(container); },
    draggedGroup, moveGroup, draggedNodes,
    setDraggedGroup: (id) => { setDraggedGroup(id); if (id !== null) setDraggedNodes(null); },
    setDraggedNodes: (nodes) => { setDraggedNodes(nodes); if (nodes !== null) setDraggedGroup(null); },
    focus: (node) => {
      const row = Array.from(tree.current?.querySelectorAll<HTMLElement>('[data-tree-node]') ?? []).find((row) => treeNodeKey(JSON.parse(row.dataset.treeNode!)) === treeNodeKey(node));
      row?.focus(); row?.scrollIntoView({ block: 'nearest' });
    },
    action: (action, nodes) => setAction({ action, nodes: [...nodes] }),
    export: (nodes) => setExportNodes([...nodes]),
  }}>
    {selected.length > 1 && <div className="tree-selection-count">{selected.length} objects selected</div>}
    <div className="tree" role="tree" aria-label="Tables and views" aria-multiselectable="true" tabIndex={0} ref={tree}
      onDragOver={(event) => {
        const dragging = draggedGroup && event.dataTransfer.types.includes(TABLE_GROUP_DRAG_TYPE)
          || draggedNodes && event.dataTransfer.types.includes(TABLE_NODES_DRAG_TYPE);
        if (!dragging) return;
        const element = event.currentTarget;
        const bounds = element.getBoundingClientRect();
        if (event.clientY < bounds.top + 36) element.scrollTop -= 18;
        else if (event.clientY > bounds.bottom - 36) element.scrollTop += 18;
      }}
      onKeyDown={(event) => {
        if ((event.target as HTMLElement).closest('input, textarea, select, [contenteditable="true"], .modal, .conn-context-menu')) return;
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
          event.preventDefault(); event.stopPropagation();
          const nodes = visible(); setSelected(nodes);
          if (!anchor.current && nodes[0]) anchor.current = treeNodeKey(nodes[0]);
        } else if (event.key === 'Escape') { setSelected([]); anchor.current = null; }
      }}>
      {children}
    </div>
    {renderFooter?.(draggedNodes, (node) => setReveal({ node }))}
    {action && <TableActionDialog profileId={profileId} object={action.nodes[0].path as ObjectPath} objects={action.nodes.map((node) => node.path as ObjectPath)} action={action.action} onClose={() => setAction(null)} />}
    {exportNodes && <TableExportDialog profileId={profileId} object={exportNodes[0].path as ObjectPath} selectedObjects={exportNodes.map((node) => node.path as ObjectPath)} views={exportNodes.filter((node) => node.kind === 'view').map((node) => node.path as ObjectPath)} onClose={() => setExportNodes(null)} />}
    {groupEditor && <Modal title={groupEditor.id ? 'Edit Group' : 'New Group'} narrow onClose={() => setGroupEditor(null)}>
      <form onSubmit={(event) => {
        event.preventDefault();
        const state = useApp.getState();
        const name = groupEditor.name.trim();
        if (!name) { setGroupError('Enter a group name.'); return; }
        try {
          let next: TableGroup[];
          if (groupEditor.id) {
            if (!state.tableGroups.some((group) => group.id === groupEditor.id && group.profileId === groupProfileId)) {
              throw new Error('This group is no longer available.');
            }
            next = state.tableGroups.map((group) => group.id === groupEditor.id ? { ...group, name, color: groupEditor.color } : group);
          } else {
            const id = uid();
            const container = tableGroupContainer(groupEditor.nodes[0]?.path ?? {});
            next = assignTableGroup([...state.tableGroups, {
              id, profileId: groupProfileId, container, name, color: groupEditor.color, nodeKeys: [], collapsed: false,
            }], groupProfileId, groupEditor.nodes, id);
          }
          if (state.saveTableGroups(next)) setGroupEditor(null);
          else setGroupError('Sidebar table groups could not be saved.');
        } catch (error) { setGroupError(errorInfo(error).message); }
      }}>
        <label>Group name<input className="input" style={{ width: '100%', marginTop: 6 }} autoFocus value={groupEditor.name}
          onChange={(event) => setGroupEditor({ ...groupEditor, name: event.target.value })} /></label>
        <div className="row" role="radiogroup" aria-label="Group color" style={{ gap: 6, marginTop: 12 }}>
          {TAB_GROUP_COLORS.map((color) => <button key={color} type="button" role="radio" aria-label={color}
            aria-checked={groupEditor.color === color} className="tab-group-swatch" style={{ background: color }}
            onClick={() => setGroupEditor({ ...groupEditor, color })} />)}
          <input type="color" aria-label="Custom group color" value={groupEditor.color}
            onChange={(event) => setGroupEditor({ ...groupEditor, color: event.target.value })} />
        </div>
        {groupError && <p role="alert" className="err">{groupError}</p>}
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
          <button type="button" className="btn" onClick={() => setGroupEditor(null)}>Cancel</button>
          <button type="submit" className="btn primary">Save</button>
        </div>
      </form>
    </Modal>}
    {importState && <Modal title="Import Groups" narrow onClose={closeImport}>
      {importState.busy ? <div className="row"><Spinner /> Reading groups and table/view names…</div> : <>
        {importState.file && <>
          <p>{importState.file.groups.length} groups · {importState.matched} matching tables/views</p>
          <div style={{ maxHeight: 180, overflow: 'auto' }}>
            {importState.file.groups.map((group, index) => <div className="row" key={index}>
              <span className="sidebar-table-group-dot" style={{ background: group.color }} />{group.name}
            </div>)}
          </div>
          {importState.missing.length > 0 && <p role="status" style={{ maxHeight: 120, overflow: 'auto', overflowWrap: 'anywhere' }}>
            Unmatched names (skipped): {importState.missing.join(', ')}
          </p>}
          {!importState.matched && <p role="alert">No names matched. Imported groups will be empty.</p>}
          <label className="row">
            <input type="checkbox" checked={importState.replace}
              onChange={(event) => setImportState({ ...importState, replace: event.target.checked })} />
            Replace existing groups in this database/schema
          </label>
          <p className="muted">{importState.replace ? 'Other databases/schemas are unchanged.' : 'Groups are appended; matching objects move out of existing groups.'} Database objects are never changed.</p>
        </>}
        {importState.error && <p role="alert" className="err">{importState.error}</p>}
      </>}
      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
        <button type="button" className="btn" onClick={closeImport}>Cancel</button>
        {!importState.busy && <button type="button" className="btn" onClick={() => { void importGroups(importState.container); }}>Choose File…</button>}
        <button type="button" className="btn primary" disabled={importState.busy || !importState.file}
          onClick={() => {
            if (!importState.file) return;
            try {
              const state = useApp.getState();
              const result = importTableGroups(state.tableGroups, groupProfileId, importState.container,
                importState.file, importState.nodes, importState.replace, uid);
              if (!state.saveTableGroups(result.groups)) {
                setImportState({ ...importState, error: 'Sidebar table groups could not be saved.' });
                return;
              }
              state.refreshTree(profileId, tableGroupParent(importState.container)?.path ?? {});
              state.toast('ok', `${importState.file.groups.length} groups imported; ${result.matched} tables/views matched, ${result.missing.length} names skipped.`);
              closeImport();
            } catch (error) { setImportState({ ...importState, error: errorInfo(error).message }); }
          }}>Import</button>
      </div>
    </Modal>}
  </Context.Provider>;
}

export function TableGroupMenu({ nodes = [], node, group, scope, onClose }: {
  nodes?: TreeNode[]; node?: TreeNode; group?: TableGroup; scope?: string; onClose(): void;
}) {
  const selection = useTableTreeSelection();
  const target = node ?? nodes[0];
  const container = group?.container ?? scope ?? tableGroupContainer(target?.path ?? {});
  const available = selection.groups.filter((group) => group.container === container);
  const current = group ?? (target && selection.groups.find((group) => group.nodeKeys.includes(treeNodeKey(target))));
  const compatible = nodes.every((node) => tableGroupContainer(node.path) === container);
  return <>
    <div className="conn-menu-separator" role="separator" />
    {group && <button type="button" role="menuitem" onClick={() => { onClose(); selection.editGroup(group); }}>Edit Group…</button>}
    {!group && nodes.some((node) => selection.groups.some((group) => group.nodeKeys.includes(treeNodeKey(node)))) &&
      <button type="button" role="menuitem" onClick={() => { onClose(); selection.assignGroup(nodes, null); }}>Remove from Group</button>}
    {!group && nodes.length > 0 && <ContextSubmenu label="Add to Group" disabled={!compatible}>
      {available.map((group) => <button type="button" role="menuitem" key={group.id}
        onClick={() => { onClose(); selection.assignGroup(nodes, group.id); }}>
        <span className="sidebar-table-group-dot" style={{ background: group.color }} />{group.name}
      </button>)}
      {available.length > 0 && <div className="conn-menu-separator" role="separator" />}
      <button type="button" role="menuitem" onClick={() => { onClose(); selection.editGroup(null, nodes); }}>New Group…</button>
    </ContextSubmenu>}
    {current && <button type="button" role="menuitem"
      onClick={() => { onClose(); selection.collapseGroups(!current.collapsed, current.id); }}>
      {current.collapsed ? 'Expand Group' : 'Collapse Group'}
    </button>}
    <button type="button" role="menuitem" disabled={!selection.groups.length}
      onClick={() => { onClose(); selection.collapseGroups(true); }}>Collapse All Group</button>
    <button type="button" role="menuitem" disabled={!selection.groups.length}
      onClick={() => { onClose(); selection.collapseGroups(false); }}>Expand All Group</button>
    {group && <button type="button" role="menuitem"
      onClick={() => { onClose(); selection.exportGroups(container, group.id); }}>Export Group…</button>}
    <button type="button" role="menuitem" disabled={!available.length}
      onClick={() => { onClose(); selection.exportGroups(container); }}>Export Groups…</button>
    <button type="button" role="menuitem" onClick={() => { onClose(); selection.importGroups(container); }}>Import Groups…</button>
    <div className="conn-menu-separator" role="separator" />
  </>;
}

export function TableTreeContextMenu({ position, onClose, onEscape, onKeyDown, width = 270, label = 'Table actions', children }: {
  position: { x: number; y: number }; onClose(): void; onEscape?(): void;
  onKeyDown?(event: KeyboardEvent<HTMLElement>): void; width?: number; label?: string; children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.style.left = `${Math.max(8, Math.min(position.x, window.innerWidth - element.offsetWidth - 8))}px`;
    element.style.top = `${Math.max(8, Math.min(position.y, window.innerHeight - element.offsetHeight - 8))}px`;
    element.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [position]);
  useEffect(() => {
    window.addEventListener('mousedown', onClose);
    return () => window.removeEventListener('mousedown', onClose);
  }, [onClose]);
  return <div className="conn-context-menu table-tree-context-menu" ref={ref} role="menu" aria-label={label}
    style={{ position: 'fixed', left: position.x, top: position.y, width, zIndex: 60, padding: 4, borderRadius: 8, maxHeight: 'calc(100vh - 16px)', overflowY: 'auto' }}
    onMouseDown={(event) => event.stopPropagation()} onKeyDown={(event) => {
      onKeyDown?.(event);
      if (event.key === 'Escape') { onClose(); onEscape?.(); }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const root = (event.target as HTMLElement).closest('[role="menu"]') ?? event.currentTarget;
        const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'))
          .filter((button) => button.closest('[role="menu"]') === root);
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
      }
    }}>{children}</div>;
}
