import { createContext, useContext } from 'react';
import type { TreeNode } from '@earthql/core';
import type { TableAction } from '../../../shared/table-actions';
import type { TableGroup } from '../table-groups';

// Keep context identity stable when the provider component is hot-reloaded.
export interface SelectionContext {
  selected: TreeNode[];
  select(node: TreeNode, toggle?: boolean, range?: boolean): void;
  visible(): TreeNode[];
  focus(node: TreeNode): void;
  action(action: TableAction, nodes: TreeNode[]): void;
  export(nodes: TreeNode[]): void;
  groups: TableGroup[];
  editGroup(group: TableGroup | null, nodes?: TreeNode[]): void;
  assignGroup(nodes: TreeNode[], target: string | null): void;
  collapseGroups(collapsed: boolean, id?: string): void;
  draggedGroup: string | null;
  setDraggedGroup(id: string | null): void;
  moveGroup(sourceId: string, targetId: string, after: boolean): void;
  draggedNodes: TreeNode[] | null;
  setDraggedNodes(nodes: TreeNode[] | null): void;
  exportGroups(container: string, groupId?: string): void;
  importGroups(container: string): void;
}
export const TableTreeSelectionContext = createContext<SelectionContext | null>(null);
export function useTableTreeSelection() {
  const selection = useContext(TableTreeSelectionContext);
  if (!selection) throw new Error('Table tree selection is unavailable. Try again or return Home to recover.');
  return selection;
}

