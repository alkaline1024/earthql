import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { TreeNode } from '@earthql/core';
import { assignTableGroup, parseTableGroups, tableGroupContainer, type TableGroup } from '../src/renderer/src/table-groups';
import { treeNodeKey } from '../src/renderer/src/tree-selection';
import { TableTreeSelectionContext, type SelectionContext } from '../src/renderer/src/components/table-tree-selection-context';
import { TableGroupMenu, TableTreeContextMenu } from '../src/renderer/src/components/TableTreeSelection';
import { TableGroupBranch } from '../src/renderer/src/components/Sidebar';

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

  it('saves and restores group edits without touching active connections or drafts; exposes write failures', async () => {
    const storage = new Map<string, string>();
    const setItem = vi.fn((key: string, value: string) => storage.set(key, value));
    vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem });
    vi.resetModules();
    const { useApp } = await import('../src/renderer/src/store');
    useApp.setState({ activeProfileId: 'profile', gridDrafts: { pending: { rows: {}, inserts: [{ id: 'new', values: {} }] } } });
    const original = useApp.getState();
    const edited = [{ ...groups[0], name: 'Business', color: '#123abc', collapsed: true }];
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
    const shown = render(selection(), createElement(TableGroupBranch, { group: collapsed, depth: 1, filter: 'orders', children: child }));
    expect(shown).toContain('orders member');
    expect(shown).toContain('aria-expanded="true"');
    expect(collapsed.collapsed).toBe(true);
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
