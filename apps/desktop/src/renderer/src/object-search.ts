import { describePath, type ObjectPath, type TableStructure, type TreeNode } from '@earthql/core';
import type { ConnectionScope } from '../../shared/api';

export type ObjectSearchMatch = { node: TreeNode; columns: string[] };
export interface ObjectSearchProgress { matches: ObjectSearchMatch[]; errors: string[] }

export async function searchObjects(options: {
  term: string;
  mode: 'objects' | 'columns';
  scope?: ConnectionScope;
  children(parent: TreeNode | null): Promise<TreeNode[]>;
  structure(path: ObjectPath): Promise<TableStructure>;
  errorMessage(error: unknown): string;
  cancelled(): boolean;
  progress(result: ObjectSearchProgress): void;
}): Promise<void> {
  const term = options.term.trim().toLowerCase();
  if (!term) return;
  const matches: ObjectSearchMatch[] = [];
  const errors: string[] = [];
  const queue: (TreeNode | null)[] = [null];
  while (queue.length && !options.cancelled()) {
    const parent = queue.shift()!;
    let nodes: TreeNode[];
    try {
      nodes = await options.children(parent);
    } catch (error) {
      if (options.cancelled()) return;
      errors.push(`${parent ? describePath({ ...parent.path, name: parent.name }) : 'Connection'}: ${options.errorMessage(error)}`);
      options.progress({ matches: [...matches], errors: [...errors] });
      continue;
    }
    if (options.cancelled()) return;
    const scope = options.scope;
    if (!parent && scope) nodes = nodes.filter((node) => node.kind === scope.kind && node.name === scope.name);
    for (const node of nodes) {
      if (options.cancelled()) return;
      if (node.hasChildren) { queue.push(node); continue; }
      if ((node.kind !== 'table' && node.kind !== 'view') || !node.path.name) continue;
      if (options.mode === 'objects') {
        if (describePath(node.path).toLowerCase().includes(term)) matches.push({ node, columns: [] });
      } else {
        try {
          const structure = await options.structure({ ...node.path, name: node.path.name });
          if (options.cancelled()) return;
          if (structure.columnsStatus.state === 'denied' || structure.columnsStatus.state === 'unsupported') {
            errors.push(`${describePath(node.path)}: ${structure.columnsStatus.message}`);
            continue;
          }
          const columns = structure.columns.map((column) => column.name).filter((name) => name.toLowerCase().includes(term));
          if (columns.length) matches.push({ node, columns });
        } catch (error) {
          if (options.cancelled()) return;
          errors.push(`${describePath(node.path)}: ${options.errorMessage(error)}`);
        }
      }
    }
    options.progress({ matches: [...matches], errors: [...errors] });
  }
}
