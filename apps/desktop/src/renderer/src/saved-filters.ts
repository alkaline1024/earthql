import type { Filter, FilterOp, ObjectPath, Sort } from '@earthql/core';

export interface SavedFilter {
  id: string;
  name: string;
  filters: Filter[];
  sort?: Sort;
}

const ops: FilterOp[] = ['=', '!=', '<', '>', '<=', '>=', 'in', 'not_in', 'is_null', 'is_not_null',
  'between', 'not_between', 'like', 'contains', 'not_contains', 'contains_cs', 'not_contains_cs',
  'starts_with', 'ends_with', 'starts_with_cs', 'ends_with_cs', 'raw'];

export function savedFiltersKey(profileId: string, object: ObjectPath): string {
  return `earthql.savedFilters.${JSON.stringify([profileId, object.catalog ?? null, object.database ?? null, object.schema ?? null, object.name])}`;
}

export function parseSavedFilters(raw: string | null): SavedFilter[] {
  if (raw === null) return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('Invalid saved filters.');
  return parsed.map((item: unknown) => {
    if (!item || typeof item !== 'object') throw new Error('Invalid saved filters.');
    const value = item as Record<string, unknown>;
    if (typeof value.id !== 'string' || typeof value.name !== 'string' || !Array.isArray(value.filters)) throw new Error('Invalid saved filters.');
    const filters = value.filters.map((entry: unknown): Filter => {
      if (!entry || typeof entry !== 'object') throw new Error('Invalid saved filter.');
      const filter = entry as Record<string, unknown>;
      const op = ops.find((candidate) => candidate === filter.op);
      if (typeof filter.column !== 'string' || !op
        || (filter.value !== undefined && typeof filter.value !== 'string')
        || (filter.value2 !== undefined && typeof filter.value2 !== 'string')
        || (filter.join !== undefined && filter.join !== 'and' && filter.join !== 'or')) throw new Error('Invalid saved filter.');
      return { column: filter.column, op, value: filter.value, value2: filter.value2, join: filter.join };
    });
    let sort: Sort | undefined;
    if (value.sort !== undefined) {
      if (!value.sort || typeof value.sort !== 'object') throw new Error('Invalid saved sort.');
      const candidate = value.sort as Record<string, unknown>;
      if (typeof candidate.column !== 'string' || (candidate.dir !== 'asc' && candidate.dir !== 'desc')) throw new Error('Invalid saved sort.');
      sort = { column: candidate.column, dir: candidate.dir };
    }
    return { id: value.id, name: value.name, filters, sort };
  });
}
