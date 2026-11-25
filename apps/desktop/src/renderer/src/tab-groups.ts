export interface TabGroup {
  id: string;
  name: string;
  color: string;
  tabIds: string[];
  collapsed: boolean;
}

/** A neutral palette; swap for brand colors if needed. Independent of the connection env colors. */
export const TAB_GROUP_COLORS: string[] = [
  '#e5484d',
  '#d48806',
  '#2f9e5b',
  '#1f8aad',
  '#6e56cf',
  '#c2298a',
];

/** A tab belongs to at most one group. Null moves it out of all groups. */
export function assignTabGroup(groups: TabGroup[], ids: string[], target: string | null): TabGroup[] {
  if (target !== null && !groups.some((group) => group.id === target)) return groups;
  const moved = new Set(ids);
  return groups.map((group) => ({
    ...group,
    tabIds: [...group.tabIds.filter((id) => !moved.has(id)), ...(group.id === target ? [...moved] : [])],
  }));
}
