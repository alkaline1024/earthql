import { describe, expect, it, vi } from 'vitest';
import type { TableStructure, TreeNode } from '@earthql/core';
import { compareSchemas, readSchema, schemaDiagram } from '../src/renderer/src/schema-tools';

const parent: TreeNode = { kind: 'schema', name: 'sales', path: { database: 'db' }, hasChildren: true };
const table = (name: string): TableStructure => ({
  object: { database: 'db', schema: 'sales', name }, kind: 'table',
  columns: [{ name: 'id', ordinal: 1, type: 'integer', nullable: false, defaultValue: null, isPrimaryKey: true, kind: 'number' }],
  columnsStatus: { state: 'ok' }, indexes: [], indexesStatus: { state: 'empty' }, constraints: [], constraintsStatus: { state: 'empty' },
});

describe('schema tools', () => {
  it('compares objects, column changes and indexes without treating inaccessible metadata as equal', () => {
    const orders = table('orders');
    const target = { ...orders, columns: [{ ...orders.columns[0], type: 'bigint' }],
      indexes: [{ name: 'idx', columns: ['id'], unique: true, primary: false }], indexesStatus: { state: 'ok' as const } };
    const differences = compareSchemas({ objects: [orders, table('old')], errors: [] }, { objects: [target, table('new')], errors: [] });
    expect(differences).toEqual(expect.arrayContaining([
      { object: 'old', detail: 'Only in source' }, { object: 'new', detail: 'Only in target' },
      { object: 'orders', detail: 'Column id: changed type' }, { object: 'orders', detail: 'Indexes differ' },
    ]));
    const denied = { ...target, columnsStatus: { state: 'denied' as const, message: 'denied' } };
    expect(compareSchemas({ objects: [orders], errors: [] }, { objects: [denied], errors: ['denied'] }))
      .not.toContainEqual({ object: 'orders', detail: 'Column id: changed type' });
  });

  it('reports inaccessible table metadata and stops a cancelled scan', async () => {
    let cancel = false;
    const progress = vi.fn();
    const result = await readSchema({ parent,
      children: async () => ['orders', 'secret'].map((name) => ({ kind: 'table', name, path: { database: 'db', schema: 'sales', name }, hasChildren: false })),
      structure: async (path) => { if (path.name === 'secret') throw new Error('denied'); return table(path.name); },
      errorMessage: (error) => String(error), cancelled: () => cancel, progress });
    expect(result.objects.map((object) => object.object.name)).toEqual(['orders']);
    expect(result.errors[0]).toContain('denied');
    cancel = true;
    expect((await readSchema({ parent, children: async () => [{ kind: 'table', name: 'orders', path: { name: 'orders' }, hasChildren: false }],
      structure: vi.fn(), errorMessage: String, cancelled: () => cancel, progress })).objects).toEqual([]);
  });

  it('includes external targets and relationship columns in diagrams', () => {
    const orders = table('orders');
    orders.constraints = [{ name: 'fk_customer', type: 'FOREIGN KEY', columns: ['customer_id'],
      foreignTarget: { object: { database: 'db', schema: 'crm', name: 'customers' }, columns: ['id'] } }];
    const result = schemaDiagram({ objects: [orders], errors: [] });
    expect(result.nodes).toHaveLength(2);
    expect(result.nodes[1]).toMatchObject({ external: true, path: { name: 'customers' } });
    expect(result.edges[0].label).toContain('customer_id → id');
  });

  it('detects changes to referenced foreign-key columns', () => {
    const orders = table('orders');
    orders.constraints = [{ name: 'fk_customer', type: 'FOREIGN KEY', columns: ['customer_id'], references: 'sales.customers',
      foreignTarget: { object: { database: 'db', schema: 'sales', name: 'customers' }, columns: ['id'] } }];
    const changed = { ...orders, constraints: [{ ...orders.constraints[0],
      foreignTarget: { ...orders.constraints[0].foreignTarget!, columns: ['legacy_id'] } }] };
    expect(compareSchemas({ objects: [orders], errors: [] }, { objects: [changed], errors: [] }))
      .toContainEqual({ object: 'orders', detail: 'Constraints differ' });
  });
});
