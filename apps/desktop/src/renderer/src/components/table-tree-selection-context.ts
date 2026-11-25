import { createContext, useContext } from 'react';
import type { TreeNode } from '@earthql/core';
import type { TableAction } from '../../../shared/table-actions';

// Keep context identity stable when the provider component is hot-reloaded.
export interface SelectionContext {
  selected: TreeNode[];
  select(node: TreeNode, toggle?: boolean, range?: boolean): void;
  visible(): TreeNode[];
  focus(node: TreeNode): void;
  action(action: TableAction, nodes: TreeNode[]): void;
  export(nodes: TreeNode[]): void;
}
export const TableTreeSelectionContext = createContext<SelectionContext | null>(null);
export function useTableTreeSelection() {
  const selection = useContext(TableTreeSelectionContext);
  if (!selection) throw new Error('Table tree selection is unavailable. Try again or return Home to recover.');
  return selection;
}

