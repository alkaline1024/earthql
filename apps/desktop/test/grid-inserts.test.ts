import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { gridRowId, type ColumnInfo, type GridChanges } from '@earthql/core';
import type { GridDraft } from '../src/renderer/src/store';
vi.mock('../src/renderer/src/api', () => ({ api: {}, errorInfo: vi.fn(), uid: () => 'fixture-row' }));
import { DataGrid, type GridEditing } from '../src/renderer/src/components/DataGrid';
import { copyGridRows, gridRowsFromText } from '../src/renderer/src/grid-clipboard';
import { gridChangesForSave, gridDraftRowCount, newGridRow, pastedGridRows, stageGridDeletes } from '../src/renderer/src/grid-inserts';

const column = (name: string, extra: Partial<ColumnInfo> = {}): ColumnInfo => ({
  name, ordinal: 0, type: 'text', kind: 'text', nullable: false, defaultValue: null, isPrimaryKey: false, ...extra,
});
const columns = [
  column('id', { type: 'int', kind: 'number', isPrimaryKey: true, isIdentity: true }),
  column('name'),
  column('note', { nullable: true }),
  column('created_at', { defaultValue: 'CURRENT_TIMESTAMP' }),
];
const names = columns.map(({ name }) => name);

afterEach(() => vi.unstubAllGlobals());

describe('staging new grid rows', () => {
  it('starts with defaults, NULL and editable required cells', () => {
    expect(newGridRow(columns)).toEqual({
      id: { kind: 'default' }, name: { kind: 'value', value: '' },
      note: { kind: 'null' }, created_at: { kind: 'default' },
    });
  });

  it('duplicates values but resets generated and primary-key columns', () => {
    const natural = column('code', { isPrimaryKey: true });
    const generated = column('total', { isGenerated: true });
    expect(newGridRow([natural, generated, column('amount')], {
      code: { kind: 'value', value: 'existing' }, total: { kind: 'value', value: '10' },
      amount: { kind: 'value', value: '12345678901234567890.0123' },
    }, true)).toEqual({
      code: { kind: 'value', value: '' }, total: { kind: 'default' },
      amount: { kind: 'value', value: '12345678901234567890.0123' },
    });
  });

  it('maps copied columns by name without overwriting identity values', () => {
    const rows = pastedGridRows(columns, names, {
      columns: ['note', 'name', 'created_at', 'id'], rows: [[null, 'copied', '2026-01-01', 10]],
    });
    expect(rows[0]).toEqual({
      id: { kind: 'default' }, name: { kind: 'value', value: 'copied' },
      note: { kind: 'null' }, created_at: { kind: 'value', value: '2026-01-01' },
    });
    expect(() => pastedGridRows(columns, names, { rows: [['short']] })).toThrow(/exactly 4 columns/);
    expect(() => pastedGridRows(columns, names, { columns: ['other'], rows: [['x']] })).toThrow(/do not match/);
  });

  it('keeps NULL, literal NULL, embedded newlines, precision and DEFAULT through Copy Rows', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
    const value = '12345678901234567890.0123';
    const copiedColumns = ['id', 'name', 'note', 'created_at', 'amount'].map((name) => ({ name, type: 'text', kind: 'text' as const }));
    const copied = [[1, 'line one\nline two\tNULL', null, null, value]];
    await copyGridRows(copiedColumns, copied, [[false, false, false, true, false]]);
    const text = vi.mocked(navigator.clipboard.writeText).mock.calls[0][0];
    const clipboard = gridRowsFromText(text);
    expect(clipboard.rows).toEqual(copied);
    const output = pastedGridRows([...columns, column('amount')], copiedColumns.map(({ name }) => name), clipboard);
    expect(output[0].note).toEqual({ kind: 'null' });
    expect(output[0].name).toEqual({ kind: 'value', value: 'line one\nline two\tNULL' });
    expect(output[0].created_at).toEqual({ kind: 'default' });
    expect(output[0].amount).toEqual({ kind: 'value', value });
  });

  it('parses external TSV without dropping empty columns and rejects an empty clipboard', () => {
    expect(gridRowsFromText('a\t\tb\r\nc\tNULL\td\r\n').rows).toEqual([['a', '', 'b'], ['c', 'NULL', 'd']]);
    expect(() => gridRowsFromText('')).toThrow(/no rows/);
  });

  it('does not retain data from a clipboard write that failed', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('Clipboard denied')) } });
    await expect(copyGridRows([{ name: 'note', type: 'text', kind: 'text' }], [[null]])).rejects.toThrow(/denied/);
    expect(gridRowsFromText('NULL').columns).toBeUndefined();
  });

  it('preserves a staged NOW() expression through Duplicate and Copy/Paste Rows', async () => {
    const dates = [column('created_at', { type: 'timestamp', kind: 'date' })];
    const source = { created_at: { kind: 'now' as const } };
    expect(newGridRow(dates, source, true)).toEqual(source);
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
    await copyGridRows(dates, [[null]], [[false]], [[true]]);
    const text = vi.mocked(navigator.clipboard.writeText).mock.calls[0][0];
    expect(pastedGridRows(dates, ['created_at'], gridRowsFromText(text))).toEqual([source]);
  });

  it('normalizes typed NOW() in existing drafts for Save without mutating drafts or text columns', () => {
    const dates = [...columns, column('updated_at', { type: 'datetime(6)', kind: 'date' })];
    const changes: GridChanges = {
      updates: [{ key: [{ column: 'id', value: '1' }], changes: [{ column: 'updated_at', original: '2026-01-01', value: 'NOW()' }] }],
      inserts: [{ name: { kind: 'value', value: 'NOW()' }, updated_at: { kind: 'value', value: ' now ( ) ' } }],
    };
    const normalized = gridChangesForSave(dates, changes);
    expect(normalized.updates[0].changes[0]).toEqual({ column: 'updated_at', original: '2026-01-01', value: null, expression: 'now' });
    expect(normalized.inserts[0]).toEqual({ name: { kind: 'value', value: 'NOW()' }, updated_at: { kind: 'now' } });
    expect(changes.updates[0].changes[0].value).toBe('NOW()');
    expect(changes.inserts[0].updated_at).toEqual({ kind: 'value', value: ' now ( ) ' });
    expect(pastedGridRows(dates, dates.map(c => c.name), { rows: [[null, 'NOW()', null, null, 'now()']] })[0].updated_at).toEqual({ kind: 'now' });
  });

  it('renders datetime choices with a pending NOW() marker and disables unavailable NULL', () => {
    const editing: GridEditing = {
      canEdit: () => true, nullable: () => false, changed: () => false, change: vi.fn(),
      isNow: () => true, setNow: vi.fn(), setDefault: vi.fn(),
      choices: () => [
        { label: 'DEFAULT', value: null, expression: 'default' },
        { label: 'NULL', value: null, disabled: true },
        { label: 'NOW()', value: null, expression: 'now' },
      ],
    };
    const html = renderToStaticMarkup(createElement(DataGrid, {
      columns: [{ name: 'created_at', type: 'datetime', kind: 'date' }], rows: [[null]], expandRows: true, editing,
    }));
    expect(html).toContain('aria-label="Choose created_at, row 1"');
    expect(html).toMatch(/<select[^>]*tabindex="-1"/);
    expect(html).toMatch(/<option[^>]*>DEFAULT<\/option>/);
    expect(html).toMatch(/<option[^>]*disabled=""[^>]*>NULL<\/option>/);
    expect(html).toMatch(/<option[^>]*selected=""[^>]*>NOW\(\)<\/option>/);
    expect(html).toMatch(/<span class="grid-default">NOW\(\)<\/span>/);
  });

  it('renders a foreign-key arrow with a shaft while keeping the navigation label', () => {
    const html = renderToStaticMarkup(createElement(DataGrid, {
      columns: [{ name: 'owner_id', type: 'int', kind: 'number' }], rows: [[7]], expandRows: true,
      cellLinks: () => [{ label: 'Open owners · id = 7', open: vi.fn() }],
    }));
    expect(html).toContain('aria-label="Open owners · id = 7"');
    expect(html).toMatch(/<button[^>]*class="grid-foreign-link"[^>]*tabindex="-1"/);
    expect(html).toContain('d="M2 6h8m-3-3 3 3-3 3"');
  });

  it('stages persisted deletions, supersedes their edits, and only removes unsaved insert rows', () => {
    const key = [{ column: 'id', value: '1' }];
    const id = gridRowId(key);
    const draft: GridDraft = {
      rows: { [id]: { key, changes: [{ column: 'name', original: 'original', value: 'edited' }] } },
      inserts: [{ id: 'new', values: { name: { kind: 'value', value: 'pending' } } }],
    };
    const next = stageGridDeletes(draft, [key], ['new']);
    expect(next).toEqual({ rows: {}, inserts: [], deletes: { [id]: { key } } });
    expect(gridDraftRowCount(next)).toBe(1);
    expect(gridDraftRowCount(stageGridDeletes(next, [key], []))).toBe(1);
    expect(draft.rows[id].changes[0].value).toBe('edited');
    expect(draft.inserts).toHaveLength(1);
    expect(stageGridDeletes({ rows: {}, inserts: draft.inserts }, [], ['new'])).toBeUndefined();
    expect(gridChangesForSave(columns, { updates: [], inserts: [], deletes: [{ key }] }).deletes).toEqual([{ key }]);
  });

  it('renders a staged deletion in place with a Save tooltip rather than a confirmation dialog', () => {
    const html = renderToStaticMarkup(createElement(DataGrid, {
      columns: [{ name: 'id', type: 'int', kind: 'number' }], rows: [[7]], expandRows: true, isDeletedRow: () => true,
    }));
    expect(html).toContain('class="grid-row pending-delete"');
    expect(html).toContain('Pending deletion — Save to delete this row');
    expect(html).toContain('>7<');
    expect(html).not.toContain('role="dialog"');
  });
});
