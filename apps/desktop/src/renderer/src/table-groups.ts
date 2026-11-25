import type { ObjectPath, TreeNode } from '@earthql/core';
import { treeNodeKey } from './tree-selection';
import { parseTableGroupFile, type TableGroupFile } from '../../shared/table-group-transfer';

export const TABLE_GROUP_DRAG_TYPE = 'application/x-earthql-table-group';
export const TABLE_NODES_DRAG_TYPE = 'application/x-earthql-table-nodes';

export interface TableGroup {
  id: string;
  profileId: string;
  container: string;
  name: string;
  color: string;
  nodeKeys: string[];
  collapsed: boolean;
}

export function tableGroupContainer(path: Partial<ObjectPath>): string {
  return JSON.stringify([path.catalog ?? '', path.database ?? '', path.schema ?? '']);
}

export function canDropTableNodes(nodes: TreeNode[] | null, containers: ReadonlySet<string>): boolean {
  return !!nodes?.length && nodes.every((node) =>
    (node.kind === 'table' || node.kind === 'view') && containers.has(tableGroupContainer(node.path)));
}

export function tableNodesDragData(nodes: TreeNode[]): string {
  return JSON.stringify(nodes.map(treeNodeKey));
}

export function tableGroupParent(container: string): TreeNode | null {
  const scope: unknown = JSON.parse(container);
  if (!Array.isArray(scope) || scope.length !== 3 || !scope.every((value: unknown) => typeof value === 'string')) {
    throw new Error('Invalid group location.');
  }
  const [catalog, database, schema] = scope;
  const path = { catalog: catalog || undefined, database: database || undefined, schema: schema || undefined };
  if (schema) return { kind: 'schema', name: schema, path, hasChildren: true };
  if (database) return { kind: 'database', name: database, path, hasChildren: true };
  if (catalog) return { kind: 'catalog', name: catalog, path, hasChildren: true };
  return null;
}

export function exportTableGroups(groups: TableGroup[]): TableGroupFile {
  const file: TableGroupFile = {
    format: 'earthql-table-groups', version: 1,
    groups: groups.map((group) => ({
      name: group.name, color: group.color, collapsed: group.collapsed,
      members: [...new Set(group.nodeKeys.map((key) => {
        const node: unknown = JSON.parse(key);
        if (!Array.isArray(node) || node.length !== 5 || !node.every((value: unknown) => typeof value === 'string')
          || (node[0] !== 'table' && node[0] !== 'view') || !node[4]) throw new Error('Invalid stored group member.');
        return node[4];
      }))],
    })),
  };
  return parseTableGroupFile(JSON.stringify(file));
}

export function importTableGroups(existing: TableGroup[], profileId: string, container: string, file: TableGroupFile,
  nodes: TreeNode[], replace: boolean, createId: () => string): { groups: TableGroup[]; matched: number; missing: string[] } {
  const available = nodes.filter((node) => (node.kind === 'table' || node.kind === 'view') && tableGroupContainer(node.path) === container);
  const byName = new Map<string, TreeNode[]>();
  for (const node of available) {
    const name = node.path.name ?? node.name;
    const matches = byName.get(name);
    if (matches) matches.push(node);
    else byName.set(name, [node]);
  }
  const matched = new Set<string>();
  const missing: string[] = [];
  const ids = new Set(existing.map((group) => group.id));
  const imported = file.groups.map((group): TableGroup => {
    const nodeKeys = group.members.flatMap((name) => {
      const found = byName.get(name) ?? [];
      if (!found.length) missing.push(name);
      return found.map((node) => { const key = treeNodeKey(node); matched.add(key); return key; });
    });
    const id = createId();
    if (!id || ids.has(id)) throw new Error('Could not create a unique group ID.');
    ids.add(id);
    return { id, profileId, container, name: group.name, color: group.color, collapsed: group.collapsed, nodeKeys: [...new Set(nodeKeys)] };
  });
  const retained = existing.filter((group) => !replace || group.profileId !== profileId || group.container !== container)
    .map((group) => group.profileId !== profileId ? group : { ...group, nodeKeys: group.nodeKeys.filter((key) => !matched.has(key)) });
  return { groups: [...retained, ...imported], matched: matched.size, missing };
}

export function parseTableGroups(raw: string | null): TableGroup[] {
  const value: unknown = JSON.parse(raw ?? '[]');
  if (!Array.isArray(value)) throw new Error('Invalid table groups.');
  const ids = new Set<string>();
  const members = new Set<string>();
  return value.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object' || !('id' in entry) || typeof entry.id !== 'string' || !entry.id || ids.has(entry.id)
      || !('profileId' in entry) || typeof entry.profileId !== 'string' || !entry.profileId
      || !('container' in entry) || typeof entry.container !== 'string'
      || !('name' in entry) || typeof entry.name !== 'string' || !entry.name.trim()
      || !('color' in entry) || typeof entry.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(entry.color)
      || !('nodeKeys' in entry) || !Array.isArray(entry.nodeKeys) || !entry.nodeKeys.every((key: unknown) => typeof key === 'string')) {
      throw new Error('Invalid table group.');
    }
    ids.add(entry.id);
    const profileId = entry.profileId;
    const nodeKeys = entry.nodeKeys.filter((key: string) => {
      const member = JSON.stringify([profileId, key]);
      if (members.has(member)) return false;
      members.add(member);
      return true;
    });
    return {
      id: entry.id, profileId, container: entry.container, name: entry.name.trim(), color: entry.color,
      nodeKeys, collapsed: 'collapsed' in entry && entry.collapsed === true,
    };
  });
}

export function assignTableGroup(groups: TableGroup[], profileId: string, nodes: TreeNode[], target: string | null): TableGroup[] {
  if (!nodes.length || nodes.some((node) => node.kind !== 'table' && node.kind !== 'view')) {
    throw new Error('Select tables or views to group.');
  }

  const group = groups.find((entry) => entry.id === target && entry.profileId === profileId);
  if (target !== null && (!group || nodes.some((node) => tableGroupContainer(node.path) !== group.container))) {
    throw new Error('Select tables and views in the same database/schema as the group.');
  }
  const moved = new Set(nodes.map(treeNodeKey));
  return groups.map((entry) => entry.profileId !== profileId ? entry : {
    ...entry,
    nodeKeys: [...entry.nodeKeys.filter((key) => !moved.has(key)), ...(entry.id === target ? [...moved] : [])],
  });
}

export function reorderTableGroups(groups: TableGroup[], sourceId: string, targetId: string, after: boolean): TableGroup[] {
  const source = groups.find((group) => group.id === sourceId);
  const target = groups.find((group) => group.id === targetId);
  if (!source || !target) throw new Error('The group is no longer available.');
  if (source.profileId !== target.profileId || source.container !== target.container) {
    throw new Error('Groups can only be reordered within the same connection and database/schema.');
  }
  if (sourceId === targetId) return groups;
  const next = groups.filter((group) => group.id !== sourceId);
  next.splice(next.findIndex((group) => group.id === targetId) + (after ? 1 : 0), 0, source);
  return next;
}
