import type { ObjectPath } from '@earthql/core';
import type { GridDraft, Tab } from './store';

export function hasUnsavedChanges(draft: GridDraft | undefined): boolean {
  return !!draft && (!!draft.inserts?.length || !!Object.keys(draft.deletes ?? {}).length || Object.values(draft.rows).some((row) => row.changes.length > 0));
}

export function objectHasUnsavedChanges(
  tabs: Tab[], drafts: Record<string, GridDraft>, profileId: string, path: Partial<ObjectPath>, kind: string, structureTabs?: Record<string, true | 'saving'>,
): boolean {
  if (kind !== 'table' && kind !== 'view') return false;
  return tabs.some((tab) => tab.kind === 'table' && tab.profileId === profileId && tab.objectKind === kind
    && tab.object.catalog === path.catalog && tab.object.database === path.database
    && tab.object.schema === path.schema && tab.object.name === path.name
    && (hasUnsavedChanges(drafts[tab.id]) || !!structureTabs?.[tab.id]));
}
