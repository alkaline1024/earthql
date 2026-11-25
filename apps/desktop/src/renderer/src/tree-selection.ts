import type { ObjectPath, TreeNode } from '@earthql/core';
export function treeNodeKey(node: Pick<TreeNode, 'kind' | 'path'>): string {
  return JSON.stringify([node.kind, node.path.catalog ?? '', node.path.database ?? '', node.path.schema ?? '', node.path.name ?? '']);
}
export function treeNodeIsAncestor(node: TreeNode, target: ObjectPath): boolean {
  if (!node.hasChildren || (node.kind !== 'catalog' && node.kind !== 'database' && node.kind !== 'schema')) return false;
  return target[node.kind] === node.name
    && (['catalog', 'database', 'schema'] as const).every((part) => node.path[part] === undefined || node.path[part] === target[part]);
}
export function selectTreeNodes(current: TreeNode[], node: TreeNode, visible: TreeNode[], anchor: string | null, toggle: boolean, range: boolean): { selected: TreeNode[]; anchor: string } {
  const key = treeNodeKey(node);
  if (range) {
    const end = visible.findIndex((item) => treeNodeKey(item) === key);
    const start = visible.findIndex((item) => treeNodeKey(item) === anchor);
    const span = start < 0 || end < 0 ? [node] : visible.slice(Math.min(start, end), Math.max(start, end) + 1);
    return { selected: toggle ? [...new Map([...current, ...span].map((item) => [treeNodeKey(item), item])).values()] : span, anchor: start < 0 ? key : anchor! };
  }
  return { selected: toggle ? current.some((item) => treeNodeKey(item) === key) ? current.filter((item) => treeNodeKey(item) !== key) : [...current, node] : [node], anchor: key };
}
