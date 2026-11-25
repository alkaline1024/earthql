export interface ConnectionGroup {
  id: string;
  name: string;
  profileIds: string[];
  collapsed: boolean;
}

export function parseConnectionGroups(raw: string | null): ConnectionGroup[] {
  try {
    const value: unknown = JSON.parse(raw ?? '[]');
    if (!Array.isArray(value)) return [];
    const seenGroups = new Set<string>();
    const seenProfiles = new Set<string>();
    return value.flatMap((group) => {
      if (!group || typeof group.id !== 'string' || !group.id || typeof group.name !== 'string' || !group.name.trim() || !Array.isArray(group.profileIds) || seenGroups.has(group.id)) return [];
      seenGroups.add(group.id);
      const profileIds = group.profileIds.filter((id: unknown): id is string => {
        if (typeof id !== 'string' || seenProfiles.has(id)) return false;
        seenProfiles.add(id);
        return true;
      });
      return [{ id: group.id, name: group.name.trim(), profileIds, collapsed: group.collapsed === true }];
    });
  } catch { return []; }
}

/** A connection belongs to at most one group. Null moves it out of all groups. */
export function assignConnectionGroup(groups: ConnectionGroup[], ids: string[], target: string | null): ConnectionGroup[] {
  if (target !== null && !groups.some((group) => group.id === target)) return groups;
  const moved = new Set(ids);
  return groups.map((group) => ({
    ...group,
    profileIds: [...group.profileIds.filter((id) => !moved.has(id)), ...(group.id === target ? [...moved] : [])],
  }));
}
