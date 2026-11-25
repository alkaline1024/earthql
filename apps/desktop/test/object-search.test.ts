import { describe, expect, it, vi } from 'vitest';
import type { TableStructure, TreeNode } from '@earthql/core';
import { searchObjects, type ObjectSearchProgress } from '../src/renderer/src/object-search';

const database = (name: string): TreeNode => ({ kind: 'database', name, path: {}, hasChildren: true });
const table = (db: string, name: string): TreeNode => ({ kind: 'table', name, path: { database: db, name }, hasChildren: false });

describe('object search', () => {
  it('searches nested objects only within a scoped connection', async () => {
    let result: ObjectSearchProgress = { matches: [], errors: [] };
    const children = vi.fn(async (parent: TreeNode | null) => parent ? [table(parent.name, 'orders')] : [database('one'), database('two')]);
    await searchObjects({ term: 'orders', mode: 'objects', scope: { kind: 'database', name: 'two' }, children,
      structure: vi.fn(), errorMessage: String, cancelled: () => false, progress: (next) => { result = next; } });
    expect(result.matches.map(({ node }) => node.path.database)).toEqual(['two']);
    expect(children).toHaveBeenCalledTimes(2);
  });

  it('reports inaccessible structures while retaining matches', async () => {
    let result: ObjectSearchProgress = { matches: [], errors: [] };
    await searchObjects({ term: 'customer', mode: 'columns',
      children: async (parent) => parent ? [table(parent.name, 'orders'), table(parent.name, 'secret')] : [database('db')],
      structure: async (path) => path.name === 'secret'
        ? { columns: [], columnsStatus: { state: 'denied', message: 'Permission denied' } } as TableStructure
        : { columns: [{ name: 'customer_id' }], columnsStatus: { state: 'ok' } } as TableStructure,
      errorMessage: String, cancelled: () => false, progress: (next) => { result = next; } });
    expect(result.matches[0].columns).toEqual(['customer_id']);
    expect(result.errors).toEqual(['db.secret: Permission denied']);
  });

  it('stops without publishing results after cancellation', async () => {
    let cancelled = false;
    const progress = vi.fn();
    await searchObjects({ term: 'orders', mode: 'objects',
      children: async () => { cancelled = true; return [table('db', 'orders')]; }, structure: vi.fn(),
      errorMessage: String, cancelled: () => cancelled, progress });
    expect(progress).not.toHaveBeenCalled();
  });
});
