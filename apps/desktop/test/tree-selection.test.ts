import { describe, expect, it } from 'vitest';
import type { TreeNode } from '@earthql/core';
import { selectTreeNodes, treeNodeIsAncestor, treeNodeKey } from '../src/renderer/src/tree-selection';
const nodes: TreeNode[] = ['a', 'b', 'c', 'd'].map((name) => ({ kind: 'table', name, path: { database: 'demo', name }, hasChildren: false }));
const names = (items: TreeNode[]) => items.map((node) => node.name);
describe('table tree multi selection', () => {
  it('replaces on click and toggles membership with Ctrl/Command', () => {
    expect(names(selectTreeNodes(nodes, nodes[1], nodes, null, false, false).selected)).toEqual(['b']);
    expect(names(selectTreeNodes([nodes[0]], nodes[2], nodes, null, true, false).selected)).toEqual(['a', 'c']);
    expect(names(selectTreeNodes([nodes[0]], nodes[0], nodes, null, true, false).selected)).toEqual([]);
  });
  it('extends and shrinks a contiguous range from the original anchor', () => {
    const anchor = treeNodeKey(nodes[1]);
    const first = selectTreeNodes([nodes[1]], nodes[3], nodes, anchor, false, true);
    expect(names(first.selected)).toEqual(['b', 'c', 'd']); expect(first.anchor).toBe(anchor);
    expect(names(selectTreeNodes(first.selected, nodes[0], nodes, first.anchor, false, true).selected)).toEqual(['a', 'b']);
  });
  it('adds ranges with Ctrl/Command+Shift, using only visible nodes', () => {
    expect(names(selectTreeNodes([nodes[0]], nodes[3], [nodes[1], nodes[3]], treeNodeKey(nodes[1]), true, true).selected)).toEqual(['a', 'b', 'd']);
    expect(names(selectTreeNodes([], nodes[3], [nodes[3]], 'hidden', false, true).selected)).toEqual(['d']);
  });
  it('distinguishes duplicate table names in different schemas and views', () => {
    expect(treeNodeKey({ kind: 'table', path: { schema: 'a', name: 'same' } })).not.toBe(treeNodeKey({ kind: 'table', path: { schema: 'b', name: 'same' } }));
    expect(treeNodeKey(nodes[0])).not.toBe(treeNodeKey({ ...nodes[0], kind: 'view' }));
  });
  it('identifies only the catalog, database and schema ancestors of the requested object', () => {
    const target = { catalog: 'main', database: 'demo', schema: 'sales', name: 'orders' };
    expect(treeNodeIsAncestor({ kind: 'catalog', name: 'main', path: {}, hasChildren: true }, target)).toBe(true);
    expect(treeNodeIsAncestor({ kind: 'database', name: 'demo', path: { catalog: 'main' }, hasChildren: true }, target)).toBe(true);
    expect(treeNodeIsAncestor({ kind: 'schema', name: 'sales', path: { catalog: 'main', database: 'demo' }, hasChildren: true }, target)).toBe(true);
    expect(treeNodeIsAncestor({ kind: 'schema', name: 'sales', path: { catalog: 'other', database: 'demo' }, hasChildren: true }, target)).toBe(false);
    expect(treeNodeIsAncestor({ kind: 'table', name: 'orders', path: target, hasChildren: false }, target)).toBe(false);
  });
});
