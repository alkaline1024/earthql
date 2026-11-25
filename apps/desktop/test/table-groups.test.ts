import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { TreeNode } from '@earthql/core';
import { assignTableGroup, canDropTableNodes, exportTableGroups, importTableGroups, parseTableGroups, reorderTableGroups, tableGroupContainer, tableGroupParent, type TableGroup } from '../src/renderer/src/table-groups';
import { MAX_TABLE_GROUP_FILE_BYTES, parseTableGroupFile } from '../src/shared/table-group-transfer';
import { treeNodeKey } from '../src/renderer/src/tree-selection';
import { TableTreeSelectionContext, type SelectionContext } from '../src/renderer/src/components/table-tree-selection-context';
import { TableGroupMenu, TableTreeContextMenu } from '../src/renderer/src/components/TableTreeSelection';
import { TableGroupBranch, TreeItem, UngroupedTableDropArea } from '../src/renderer/src/components/Sidebar';

vi.mock('../src/renderer/src/api', () => ({
  api: {}, uid: () => 'fixture-group', errorInfo: (error: Error) => ({ message: error.message }),
  onMenuCommand: () => () => undefined,
}));
vi.mock('../src/renderer/src/components/ContextSubmenu', () => ({
  ContextSubmenu: ({ label, disabled, children }: { label: string; disabled?: boolean; children: React.ReactNode }) =>
    createElement('div', { 'aria-label': label, 'data-disabled': disabled }, children),
}));

const node = (name: string, database = 'demo', kind: 'table' | 'view' = 'table'): TreeNode => ({
  kind, name, path: { database, schema: 'public', name }, hasChildren: false,
});
const orders = node('orders');
const summary = node('summary', 'demo', 'view');
const group = (id: string, nodes: TreeNode[], profileId = 'profile'): TableGroup => ({
  id, profileId, container: tableGroupContainer(orders.path), name: id, color: '#6e56cf',
  nodeKeys: nodes.map(treeNodeKey), collapsed: false,
});
const groups = [group('Sales', [orders]), group('Reports', [summary]), group('Other profile', [orders], 'other')];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('table groups', () => {
  it('exports portable names and restores group order, colors and collapse state into a different database', () => {
    const source = [{ ...groups[1], color: '#123abc', collapsed: true }, groups[0]];
    const file = exportTableGroups(source);
    expect(file.groups.map((group) => group.members)).toEqual([['summary'], ['orders']]);
    const text = JSON.stringify(file);
    expect(text).not.toContain('profileId');
    expect(text).not.toContain('container');
    expect(text).not.toContain('nodeKeys');
    const target = [node('orders', 'target'), node('summary', 'target'), node('summary', 'wrong')];
    let id = 0;
    const result = importTableGroups([], 'new-profile', tableGroupContainer(target[0].path), parseTableGroupFile(text),
      target, true, () => `import-${id++}`);
    expect(result.matched).toBe(2);
    expect(result.missing).toEqual([]);
    expect(result.groups.map((group) => [group.name, group.color, group.collapsed]))
      .toEqual(source.map((group) => [group.name, group.color, group.collapsed]));
    expect(result.groups.map((group) => group.nodeKeys)).toEqual([[treeNodeKey(target[1])], [treeNodeKey(target[0])]]);
    expect(result.groups.every((group) => group.profileId === 'new-profile')).toBe(true);
    expect(parseTableGroups(JSON.stringify(result.groups))).toEqual(result.groups);
  });

  it('matches names exactly, accepts a table/view with the same name and reports unmatched members', () => {
    const file = exportTableGroups(groups.slice(0, 2));
    const target = [{ ...node('orders', 'demo', 'view'), name: 'Orders view label' }, node('Summary')];
    let id = 0;
    const result = importTableGroups([], 'profile', tableGroupContainer(orders.path), file, target, true, () => `import-${id++}`);
    expect(result.matched).toBe(1);
    expect(result.missing).toEqual(['summary']);
    expect(result.groups[0].nodeKeys).toEqual([treeNodeKey(target[0])]);
    expect(result.groups[1].nodeKeys).toEqual([]);
  });

  it('replaces only the target scope or appends groups while moving matching objects out of current groups', () => {
    const archive = { ...group('Archive', []), container: tableGroupContainer(node('orders', 'archive').path) };
    const existing = [...groups, archive];
    const file = exportTableGroups([groups[0]]);
    const scope = tableGroupContainer(orders.path);
    const replaced = importTableGroups(existing, 'profile', scope, file, [orders, summary], true, () => 'imported');
    expect(replaced.groups.map((group) => group.id)).toEqual(['Other profile', 'Archive', 'imported']);
    const appended = importTableGroups(existing, 'profile', scope, file, [orders, summary], false, () => 'imported');
    expect(appended.groups.map((group) => group.id)).toEqual(['Sales', 'Reports', 'Other profile', 'Archive', 'imported']);
    expect(appended.groups[0].nodeKeys).toEqual([]);
    expect(appended.groups[2]).toBe(groups[2]);
    expect(existing[0].nodeKeys).toEqual([treeNodeKey(orders)]);
  });

  it('rejects malformed, incompatible and duplicate-name files and enforces the exact byte ceiling', () => {
    const file = exportTableGroups([groups[0]]);
    const text = JSON.stringify(file);
    const full = text + ' '.repeat(MAX_TABLE_GROUP_FILE_BYTES - new TextEncoder().encode(text).byteLength);
    expect(parseTableGroupFile(full)).toEqual(file);
    expect(() => parseTableGroupFile(full + ' ')).toThrow('1 MiB');
    expect(() => parseTableGroupFile('{')).toThrow();
    expect(() => parseTableGroupFile(JSON.stringify({ ...file, version: 2 }))).toThrow('unsupported');
    expect(() => parseTableGroupFile(JSON.stringify({ ...file, groups: [...file.groups, ...file.groups] }))).toThrow('duplicate');
    expect(() => parseTableGroupFile(JSON.stringify({ ...file, groups: [{ ...file.groups[0], color: 'red' }] }))).toThrow('definition');
  });

  it('resolves the actual metadata parent including default/flat and catalog-schema hierarchies', () => {
    expect(tableGroupParent(tableGroupContainer({}))).toBeNull();
    expect(tableGroupParent(tableGroupContainer({ database: 'demo' }))?.kind).toBe('database');
    const parent = tableGroupParent(tableGroupContainer({ catalog: 'main', schema: 'public' }));
    expect(parent?.kind).toBe('schema');
    expect(parent?.name).toBe('public');
    expect(parent?.path.catalog).toBe('main');
  });

  it('accepts mixed table/view drops only when every selected object belongs to the drop container', () => {
    const containers = new Set([tableGroupContainer(orders.path)]);
    expect(canDropTableNodes([orders, summary], containers)).toBe(true);
    expect(canDropTableNodes([orders, node('orders', 'archive')], containers)).toBe(false);
    expect(canDropTableNodes([{ ...orders, path: { ...orders.path, schema: 'private' } }], containers)).toBe(false);
    expect(canDropTableNodes([{ ...orders, kind: 'database', hasChildren: true }], containers)).toBe(false);
    expect(canDropTableNodes([], containers)).toBe(false);
    expect(canDropTableNodes(null, containers)).toBe(false);
  });

  it('moves a mixed multi-selection into one group and back out without changing other profiles or group settings', () => {
    const source = [{ ...groups[0], collapsed: true }, groups[1], groups[2]];
    const dragged = [orders, summary];
    const moved = assignTableGroup(source, 'profile', dragged, 'Sales');
    expect(moved.map((item) => item.nodeKeys)).toEqual([[treeNodeKey(orders), treeNodeKey(summary)], [], [treeNodeKey(orders)]]);
    const ungrouped = assignTableGroup(moved, 'profile', dragged, null);
    expect(ungrouped.map((item) => item.nodeKeys)).toEqual([[], [], [treeNodeKey(orders)]]);
    expect(ungrouped.map((item) => [item.id, item.name, item.color, item.collapsed]))
      .toEqual(source.map((item) => [item.id, item.name, item.color, item.collapsed]));
    expect(parseTableGroups(JSON.stringify(ungrouped))).toEqual(ungrouped);
    expect(source[0].nodeKeys).toEqual([treeNodeKey(orders)]);
  });

  it('moves tables and views together once, retaining other profiles and the source snapshot', () => {
    const next = assignTableGroup(groups, 'profile', [orders, summary, orders], 'Reports');
    expect(next.map((item) => item.nodeKeys)).toEqual([[], [treeNodeKey(orders), treeNodeKey(summary)], [treeNodeKey(orders)]]);
    expect(groups[0].nodeKeys).toEqual([treeNodeKey(orders)]);
    expect(next[2]).toBe(groups[2]);
    expect(parseTableGroups(JSON.stringify(next))).toEqual(next);
  });

  it('removes membership without removing groups or changing database object paths', () => {
    const before = JSON.stringify(orders);
    const next = assignTableGroup(groups, 'profile', [orders, summary], null);
    expect(next.map((item) => item.nodeKeys)).toEqual([[], [], [treeNodeKey(orders)]]);
    expect(next.map((item) => item.name)).toEqual(groups.map((item) => item.name));
    expect(JSON.stringify(orders)).toBe(before);
  });

  it('rejects foreign profiles, unknown groups and mixed database/schema selections', () => {
    expect(() => assignTableGroup(groups, 'profile', [orders], 'Other profile')).toThrow('same database/schema');
    expect(() => assignTableGroup(groups, 'profile', [orders], 'missing')).toThrow('same database/schema');
    expect(() => assignTableGroup(groups, 'profile', [orders, node('orders', 'archive')], 'Sales')).toThrow('same database/schema');
    expect(() => assignTableGroup(groups, 'profile', [{ ...orders, path: { ...orders.path, schema: 'private' } }], 'Sales')).toThrow('same database/schema');
    expect(() => assignTableGroup(groups, 'profile', [], 'Sales')).toThrow('Select tables or views');
  });

  it('keeps equal table names in different databases and table/view identities distinct', () => {
    const archive = node('orders', 'archive');
    const view = node('orders', 'demo', 'view');
    const next = assignTableGroup([group('Sales', [orders, archive, view])], 'profile', [orders], null);
    expect(next[0].nodeKeys).toEqual([treeNodeKey(archive), treeNodeKey(view)]);
  });

  it('restores names, custom colors, collapse state and unique membership; reports corrupt storage', () => {
    const saved = [{ ...groups[0], name: '  Business  ', color: '#123abc', collapsed: true }, { ...groups[1], nodeKeys: [treeNodeKey(orders), treeNodeKey(summary)] }];
    expect(parseTableGroups(JSON.stringify(saved))).toEqual([
      { ...saved[0], name: 'Business' }, { ...saved[1], nodeKeys: [treeNodeKey(summary)] },
    ]);
    expect(() => parseTableGroups('{')).toThrow();
    expect(() => parseTableGroups('{}')).toThrow('Invalid table groups');
    expect(() => parseTableGroups(JSON.stringify([{ ...groups[0], color: 'bad' }]))).toThrow('Invalid table group');
  });

  it('moves before and after a group without changing membership, metadata or other scopes', () => {
    const third = { ...group('Third', []), collapsed: true };
    const archive = { ...group('Archive', []), container: tableGroupContainer(node('orders', 'archive').path) };
    const original = [groups[0], groups[2], groups[1], archive, third];
    const before = reorderTableGroups(original, 'Third', 'Sales', false);
    expect(before.map((item) => item.id)).toEqual(['Third', 'Sales', 'Other profile', 'Reports', 'Archive']);
    const after = reorderTableGroups(before, 'Third', 'Reports', true);
    expect(after.map((item) => item.id)).toEqual(['Sales', 'Other profile', 'Reports', 'Third', 'Archive']);
    expect(after.find((item) => item.id === 'Third')).toBe(third);
    expect(after.filter((item) => item === groups[2] || item === archive)).toEqual([groups[2], archive]);
    expect(original.map((item) => item.id)).toEqual(['Sales', 'Other profile', 'Reports', 'Archive', 'Third']);
    expect(parseTableGroups(JSON.stringify(after))).toEqual(after);
  });

  it('rejects stale or cross-scope drops and leaves self-drops unchanged', () => {
    const archive = { ...group('Archive', []), container: tableGroupContainer(node('orders', 'archive').path) };
    expect(() => reorderTableGroups(groups, 'missing', 'Sales', false)).toThrow('no longer available');
    expect(() => reorderTableGroups(groups, 'Sales', 'missing', true)).toThrow('no longer available');
    expect(() => reorderTableGroups(groups, 'Sales', 'Other profile', false)).toThrow('same connection');
    expect(() => reorderTableGroups([...groups, archive], 'Sales', 'Archive', true)).toThrow('same connection');
    expect(reorderTableGroups(groups, 'Sales', 'Sales', true)).toBe(groups);
  });

  it('saves and restores group edits without touching active connections or drafts; exposes write failures', async () => {
    const storage = new Map<string, string>();
    const setItem = vi.fn((key: string, value: string) => storage.set(key, value));
    vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem });
    vi.resetModules();
    const { useApp } = await import('../src/renderer/src/store');
    useApp.setState({ activeProfileId: 'profile', gridDrafts: { pending: { rows: {}, inserts: [{ id: 'new', values: {} }] } } });
    const original = useApp.getState();
    const edited = reorderTableGroups([{ ...groups[0], name: 'Business', color: '#123abc', collapsed: true }, groups[1]], 'Reports', 'Sales', false);
    expect(useApp.getState().saveTableGroups(edited)).toBe(true);
    expect(useApp.getState().activeProfileId).toBe(original.activeProfileId);
    expect(useApp.getState().connections).toBe(original.connections);
    expect(useApp.getState().gridDrafts).toBe(original.gridDrafts);
    vi.resetModules();
    const restored = await import('../src/renderer/src/store');
    expect(restored.useApp.getState().tableGroups).toEqual(edited);
    setItem.mockImplementationOnce(() => { throw new Error('Storage unavailable'); });
    expect(restored.useApp.getState().saveTableGroups([])).toBe(false);
    expect(restored.useApp.getState().tableGroups).toEqual(edited);
    expect(restored.useApp.getState().toasts.at(-1)?.text).toBe('Sidebar table groups could not be saved.');
  });
});

describe('rendered table group controls', () => {
  const selection = (): SelectionContext => ({
    selected: [orders], groups: groups.filter((item) => item.profileId === 'profile'),
    select: vi.fn(), visible: () => [orders, summary], focus: vi.fn(), action: vi.fn(), export: vi.fn(),
    editGroup: vi.fn(), assignGroup: vi.fn(), collapseGroups: vi.fn(),
    draggedGroup: null, setDraggedGroup: vi.fn(), moveGroup: vi.fn(),
    draggedNodes: null, setDraggedNodes: vi.fn(),
    exportGroups: vi.fn(), importGroups: vi.fn(),
  });
  const render = (context: SelectionContext, child: React.ReactNode) =>
    renderToStaticMarkup(createElement(TableTreeSelectionContext.Provider, { value: context }, child));

  it('hides collapsed members and reveals filter matches without altering saved collapse state', () => {
    const collapsed = { ...groups[0], collapsed: true };
    const child = createElement('span', null, 'orders member');
    const hidden = render(selection(), createElement(TableGroupBranch, { group: collapsed, depth: 1, filter: '', children: child }));
    expect(hidden).not.toContain('orders member');
    expect(hidden).toContain('aria-expanded="false"');
    expect(hidden).toContain('color:#6e56cf');
    expect(hidden).toContain('draggable="true"');
    const shown = render(selection(), createElement(TableGroupBranch, { group: collapsed, depth: 1, filter: 'orders', children: child }));
    expect(shown).toContain('orders member');
    expect(shown).toContain('aria-expanded="true"');
    expect(collapsed.collapsed).toBe(true);
  });

  it('marks the entire dragged group without changing its expanded state or hiding members', () => {
    const context = selection();
    context.draggedGroup = 'Sales';
    const html = render(context, createElement(TableGroupBranch, {
      group: groups[0], depth: 1, filter: '', children: createElement('span', null, 'orders member'),
    }));
    expect(html).toContain('opacity:0.45');
    expect(html).toContain('cursor:grabbing');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('orders member');
  });

  it('makes selected tables and views draggable and marks every dragged row', () => {
    const context = selection();
    context.selected = [orders, summary];
    context.draggedNodes = [...context.selected];
    for (const node of [orders, summary]) {
      const html = render(context, createElement(TreeItem, { profileId: 'profile', node, depth: 2, filter: '' }));
      expect(html).toContain('draggable="true"');
      expect(html).toContain('tree-row selected');
      expect(html).toContain('opacity:0.45');
    }
    expect(context.selected).toEqual([orders, summary]);
  });

  it('provides an empty ungrouped drop target when all dragged objects are grouped', () => {
    const context = selection();
    context.draggedNodes = [orders, summary];
    const html = render(context, createElement(UngroupedTableDropArea, {
      containers: new Set([tableGroupContainer(orders.path)]), depth: 1,
    }));
    expect(html).toContain('Drop here to remove from Group');
    expect(html).toContain('Ungrouped tables and views');
  });

  it('hides the remove-from-group target for incompatible or already ungrouped selections', () => {
    const context = selection();
    context.draggedNodes = [orders, node('other', 'archive')];
    const props = {
      containers: new Set([tableGroupContainer(orders.path)]), depth: 1,
      children: createElement('span', null, 'Existing ungrouped table'),
    };
    const incompatible = render(context, createElement(UngroupedTableDropArea, props));
    expect(incompatible).not.toContain('Drop here to remove from Group');
    expect(incompatible).toContain('Existing ungrouped table');
    context.draggedNodes = [node('ungrouped')];
    expect(render(context, createElement(UngroupedTableDropArea, props))).not.toContain('Drop here to remove from Group');
  });

  it('offers scoped group choices, creation, removal and collapse actions for tables and views', () => {
    const context = selection();
    context.groups.push({ ...group('Archive', []), container: tableGroupContainer(node('orders', 'archive').path) });
    const html = render(context, createElement(TableGroupMenu, { nodes: [orders, summary], onClose: vi.fn() }));
    expect(html).toContain('Remove from Group');
    expect(html).toContain('Add to Group');
    expect(html).toContain('Reports');
    expect(html).toContain('New Group…');
    expect(html).not.toContain('Archive');
    expect(html).not.toContain('Other profile');
    expect(html).toContain('>Collapse Group<');
    expect(html).toContain('Collapse All Group');
    expect(html).toContain('Expand All Group');
  });

  it('makes Expand Group and editing accessible from a collapsed group header menu', () => {
    const html = render(selection(), createElement(TableGroupMenu, { group: { ...groups[0], collapsed: true }, onClose: vi.fn() }));
    expect(html).toContain('Edit Group…');
    expect(html).toContain('>Expand Group<');
    expect(html).not.toContain('>Collapse Group<');
    expect(html).not.toContain('Add to Group');
    expect(html).toContain('Export Group…');
    expect(html).toContain('Import Groups…');
  });

  it('offers import in an empty table container without offering object membership actions', () => {
    const context = selection();
    context.groups = [];
    const html = render(context, createElement(TableGroupMenu, { scope: tableGroupContainer(orders.path), onClose: vi.fn() }));
    expect(html).toContain('Import Groups…');
    expect(html).not.toContain('Add to Group');
    expect(html).toContain('disabled=""');
  });

  it('uses the clicked object group rather than the first item of a multi-selection', () => {
    const context = selection();
    context.groups[1] = { ...context.groups[1], collapsed: true };
    const html = render(context, createElement(TableGroupMenu, { nodes: [orders, summary], node: summary, onClose: vi.fn() }));
    expect(html).toContain('>Expand Group<');
    expect(html).not.toContain('>Collapse Group<');
  });

  it('uses the wider menu for both group and object actions', () => {
    const html = render(selection(), createElement(TableTreeContextMenu, {
      position: { x: 10, y: 20 }, onClose: vi.fn(), children: createElement(TableGroupMenu, { nodes: [summary], onClose: vi.fn() }),
    }));
    expect(html).toContain('width:270px');
    expect(html).toContain('New Group…');
  });
});
