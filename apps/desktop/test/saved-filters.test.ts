import { describe, expect, it } from 'vitest';
import { parseSavedFilters, savedFiltersKey } from '../src/renderer/src/saved-filters';

describe('saved filters', () => {
  it('keeps profiles and full paths separate and restores filters and sorting', () => {
    const object = { database: 'db', schema: 'sales', name: 'orders' };
    expect(savedFiltersKey('one', object)).not.toBe(savedFiltersKey('two', object));
    expect(savedFiltersKey('one', object)).not.toBe(savedFiltersKey('one', { ...object, schema: 'archive' }));
    const saved = [{ id: '1', name: 'Recent', filters: [{ column: 'id', op: 'in', value: '1,2', join: 'or' }], sort: { column: 'id', dir: 'desc' } }];
    expect(parseSavedFilters(JSON.stringify(saved))).toEqual(saved);
    expect(parseSavedFilters(null)).toEqual([]);
  });

  it('rejects malformed entries rather than applying invalid filters', () => {
    expect(() => parseSavedFilters('{')).toThrow();
    expect(() => parseSavedFilters(JSON.stringify([{ id: '1', name: 'Bad', filters: [{ column: 'id', op: 'invalid' }] }]))).toThrow();
    expect(() => parseSavedFilters(JSON.stringify([{ id: '1', name: 'Bad', filters: [], sort: { column: 'id', dir: 'sideways' } }]))).toThrow();
  });
});
