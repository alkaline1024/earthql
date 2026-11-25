import { describe, expect, it } from 'vitest';
import type { HistoryEntry } from '../src/shared/api';
import { filterHistory } from '../src/renderer/src/history-filter';

describe('history filters', () => {
  it('combines SQL, status and inclusive local dates', () => {
    const entry = (id: string, status: HistoryEntry['status'], day: number): HistoryEntry => ({
      id, status, sql: 'SELECT orders', ranAt: new Date(2026, 2, day, 23, 59).getTime(), durationMs: 1, context: {}, statements: 1,
    });
    const entries = [entry('a', 'ok', 1), entry('b', 'error', 2), entry('c', 'error', 3)];
    expect(filterHistory(entries, 'ORDERS', 'error', '2026-03-02', '2026-03-02').map((item) => item.id)).toEqual(['b']);
    expect(filterHistory(entries, 'missing', 'all', '', '')).toEqual([]);
    expect(filterHistory(entries, '', 'all', '', '')).toEqual(entries);
  });
});
