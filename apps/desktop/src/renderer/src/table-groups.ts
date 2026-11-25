import type { ObjectPath, TreeNode } from '@earthql/core';
import { treeNodeKey } from './tree-selection';

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
