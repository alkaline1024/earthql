import type { ObjectPath } from '@earthql/core';
export const FILE_NAME_TOKENS = ['connection', 'database', 'schema', 'table', 'tag', 'year', 'month', 'monthPretty', 'day', 'hour', 'minute', 'second'] as const;
export function tableFileName(pattern: string, context: { connection: string; object: ObjectPath; tag: string }, date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  const values: Record<string, string> = {
    connection: context.connection, database: context.object.database ?? context.object.catalog ?? '', schema: context.object.schema ?? '', table: context.object.name,
    tag: context.tag, year: String(date.getFullYear()), month: pad(date.getMonth() + 1), monthPretty: date.toLocaleString('en', { month: 'short' }), day: pad(date.getDate()),
    hour: pad(date.getHours()), minute: pad(date.getMinutes()), second: pad(date.getSeconds()),
  };
  return pattern.replace(/\{([^{}]+)\}/g, (_, key: string) => values[key] ?? '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/^\.+|[. ]+$/g, '').trim() || 'export';
}
