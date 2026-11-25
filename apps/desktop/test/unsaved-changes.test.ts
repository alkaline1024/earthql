import { describe, expect, it } from 'vitest';
import type { GridDraft, Tab } from '../src/renderer/src/store';
import { hasUnsavedChanges, objectHasUnsavedChanges } from '../src/renderer/src/unsaved-changes';

const object = { database: 'demo', schema: 'public', name: 'users' };
const tab: Tab = { id: 't1', kind: 'table', profileId: 'local', object, objectKind: 'table' };
const draft: GridDraft = { rows: { one: { key: [{ column: 'id', value: '1' }], changes: [{ column: 'name', value: 'Edited' }] } } };

describe('unsaved indicators', () => {
  it('ignores absent drafts and rows without changed cells', () => {
    expect(hasUnsavedChanges(undefined)).toBe(false);
    expect(hasUnsavedChanges({ rows: {} })).toBe(false);
    expect(hasUnsavedChanges({ rows: { one: { key: [], changes: [] } } })).toBe(false);
  });
  it('retains the marker while saving and after a save error', () => {
    expect(hasUnsavedChanges(draft)).toBe(true);
    expect(hasUnsavedChanges({ ...draft, saving: true })).toBe(true);
    expect(hasUnsavedChanges({ ...draft, error: { category: 'unknown', message: 'Failed' } })).toBe(true);
  });
  it('marks insert-only drafts as unsaved, including blank new rows and failed saves', () => {
    const inserted: GridDraft = { rows: {}, inserts: [{ id: 'new', values: { id: { kind: 'default' } } }] };
    expect(hasUnsavedChanges(inserted)).toBe(true);
    expect(hasUnsavedChanges({ ...inserted, saving: true })).toBe(true);
    expect(hasUnsavedChanges({ ...inserted, error: { category: 'constraint', message: 'Duplicate key' } })).toBe(true);
    expect(objectHasUnsavedChanges([tab], { t1: inserted }, 'local', object, 'table')).toBe(true);
    expect(hasUnsavedChanges({ rows: {}, inserts: [] })).toBe(false);
  });
  it('keeps deletion-only drafts marked through saving and errors', () => {
    const removed: GridDraft = { rows: {}, deletes: { one: { key: [{ column: 'id', value: '1' }] } } };
    expect(hasUnsavedChanges(removed)).toBe(true);
    expect(hasUnsavedChanges({ ...removed, saving: true })).toBe(true);
    expect(hasUnsavedChanges({ ...removed, error: { category: 'constraint', message: 'Delete rejected' } })).toBe(true);
    expect(objectHasUnsavedChanges([tab], { t1: removed }, 'local', object, 'table')).toBe(true);
    expect(hasUnsavedChanges({ rows: {}, deletes: {} })).toBe(false);
  });
  it('matches full object identity and connection, regardless of path key order', () => {
    const check = (profile = 'local', path = object, kind = 'table') => objectHasUnsavedChanges([tab], { t1: draft }, profile, path, kind);
    expect(check('local', { name: 'users', schema: 'public', database: 'demo' })).toBe(true);
    expect(check('remote')).toBe(false);
    expect(check('local', { ...object, schema: 'other' })).toBe(false);
    expect(check('local', { ...object, database: 'other' })).toBe(false);
    expect(check('local', object, 'view')).toBe(false);
    expect(check('local', object, 'schema')).toBe(false);
  });
  it('works for views and clears when drafts or tabs are removed', () => {
    const view: Tab = { ...tab, objectKind: 'view' };
    expect(objectHasUnsavedChanges([view], { t1: draft }, 'local', object, 'view')).toBe(true);
    expect(objectHasUnsavedChanges([tab], {}, 'local', object, 'table')).toBe(false);
    expect(objectHasUnsavedChanges([], { t1: draft }, 'local', object, 'table')).toBe(false);
  });
});
