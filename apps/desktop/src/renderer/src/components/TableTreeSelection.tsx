import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { ObjectPath, TreeNode } from '@earthql/core';
import type { TableAction } from '../../../shared/table-actions';
import { useApp } from '../store';
import { selectTreeNodes, treeNodeKey } from '../tree-selection';
import { TableActionDialog } from './TableActionDialog';
import { TableExportDialog } from './TableExportDialog';

interface SelectionContext {
  selected: TreeNode[];
  select(node: TreeNode, toggle?: boolean, range?: boolean): void;
  visible(): TreeNode[];
  focus(node: TreeNode): void;
  action(action: TableAction, nodes: TreeNode[]): void;
  export(nodes: TreeNode[]): void;
}
const Context = createContext<SelectionContext | null>(null);
export function useTableTreeSelection() { return useContext(Context)!; }

export function TableTreeSelection({ profileId, filter, children }: { profileId: string; filter: string; children: ReactNode }) {
  const [selected, setSelected] = useState<TreeNode[]>([]);
  const anchor = useRef<string | null>(null);
  const tree = useRef<HTMLDivElement>(null);
  const [action, setAction] = useState<{ action: TableAction; nodes: TreeNode[] } | null>(null);
  const [exportNodes, setExportNodes] = useState<TreeNode[] | null>(null);
  const activeTabId = useApp((state) => state.activeTabId);
  const visible = () => Array.from(tree.current?.querySelectorAll<HTMLElement>('[data-tree-node]') ?? []).map((row) => JSON.parse(row.dataset.treeNode!) as TreeNode);
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
  return <Context.Provider value={{ selected, select, visible,
    focus: (node) => {
      const row = Array.from(tree.current?.querySelectorAll<HTMLElement>('[data-tree-node]') ?? []).find((row) => treeNodeKey(JSON.parse(row.dataset.treeNode!)) === treeNodeKey(node));
      row?.focus(); row?.scrollIntoView({ block: 'nearest' });
    },
    action: (action, nodes) => setAction({ action, nodes: [...nodes] }),
    export: (nodes) => setExportNodes([...nodes]),
  }}>
    {selected.length > 1 && <div className="tree-selection-count">{selected.length} objects selected</div>}
    <div className="tree" role="tree" aria-label="Tables and views" aria-multiselectable="true" tabIndex={0} ref={tree}
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
    {action && <TableActionDialog profileId={profileId} object={action.nodes[0].path as ObjectPath} objects={action.nodes.map((node) => node.path as ObjectPath)} action={action.action} onClose={() => setAction(null)} />}
    {exportNodes && <TableExportDialog profileId={profileId} object={exportNodes[0].path as ObjectPath} selectedObjects={exportNodes.map((node) => node.path as ObjectPath)} onClose={() => setExportNodes(null)} />}
  </Context.Provider>;
}
