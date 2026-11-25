import type { HistoryEntry } from '../../shared/api';

export function filterHistory(entries: HistoryEntry[], search: string, status: HistoryEntry['status'] | 'all', from: string, through: string): HistoryEntry[] {
  const query = search.trim().toLowerCase();
  const start = from ? new Date(`${from}T00:00:00`).getTime() : -Infinity;
  const end = through ? new Date(`${through}T00:00:00`).getTime() : Infinity;
  const exclusiveEnd = Number.isFinite(end) ? new Date(new Date(end).getFullYear(), new Date(end).getMonth(), new Date(end).getDate() + 1).getTime() : end;
  return entries.filter((entry) => (!query || entry.sql.toLowerCase().includes(query))
    && (status === 'all' || entry.status === status) && entry.ranAt >= start && entry.ranAt < exclusiveEnd);
}
