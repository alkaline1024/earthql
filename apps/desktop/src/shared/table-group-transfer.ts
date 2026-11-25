export const MAX_TABLE_GROUP_FILE_BYTES = 1024 * 1024;

export interface TableGroupFile {
  format: 'earthql-table-groups';
  version: 1;
  groups: { name: string; color: string; collapsed: boolean; members: string[] }[];
}

export type SaveTableGroupFileResult = { status: 'ok'; path: string } | { status: 'dialog-cancelled' };

export function parseTableGroupFile(text: string): TableGroupFile {
  if (new TextEncoder().encode(text).byteLength > MAX_TABLE_GROUP_FILE_BYTES) {
    throw new Error('Group files must not exceed 1 MiB.');
  }
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object' || !('format' in value) || value.format !== 'earthql-table-groups'
    || !('version' in value) || value.version !== 1 || !('groups' in value) || !Array.isArray(value.groups)
    || !value.groups.length || value.groups.length > 1000) {
    throw new Error('Invalid or unsupported EarthQL group file.');
  }
  const members = new Set<string>();
  const groups = value.groups.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object'
      || !('name' in entry) || typeof entry.name !== 'string' || !entry.name.trim()
      || !('color' in entry) || typeof entry.color !== 'string' || !/^#[0-9a-f]{6}$/i.test(entry.color)
      || !('collapsed' in entry) || typeof entry.collapsed !== 'boolean'
      || !('members' in entry) || !Array.isArray(entry.members)) throw new Error('Invalid group definition.');
    const names = entry.members.map((name: unknown) => {
      if (typeof name !== 'string' || !name || members.has(name)) throw new Error('Invalid or duplicate table/view name in group file.');
      members.add(name);
      return name;
    });
    return { name: entry.name.trim(), color: entry.color, collapsed: entry.collapsed, members: names };
  });
  return { format: 'earthql-table-groups', version: 1, groups };
}
