import type { BinaryCell, Cell, ValueKind } from './types';

const MAX_BINARY_PREVIEW = 64;

export function binaryCell(buf: Uint8Array): BinaryCell {
  const bytes = buf.length;
  const slice = buf.subarray(0, MAX_BINARY_PREVIEW);
  let hex = '';
  for (const b of slice) hex += b.toString(16).padStart(2, '0');
  return { $binary: hex, bytes, truncated: bytes > MAX_BINARY_PREVIEW };
}

export function isBinaryCell(v: unknown): v is BinaryCell {
  return typeof v === 'object' && v !== null && '$binary' in v;
}

function pad(n: number, w = 2): string {
  return String(n).padStart(w, '0');
}

/** Format a Date as `YYYY-MM-DD HH:mm:ss.SSS` in UTC (no offset). */
export function formatUtcDateTime(d: Date, withMs = true): string {
  if (Number.isNaN(d.getTime())) return String(d);
  const base = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(
    d.getUTCMinutes(),
  )}:${pad(d.getUTCSeconds())}`;
  return withMs ? `${base}.${pad(d.getUTCMilliseconds(), 3)}` : base;
}

export function formatUtcDate(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function formatUtcTime(d: Date): string {
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}`;
}

/**
 * Convert a driver value into a Cell. Adapters that know the column type should
 * format dates themselves before calling this; Date objects reaching here are rendered as UTC ISO-like text.
 */
export function normalizeCell(v: unknown): Cell {
  if (v === null || v === undefined) return null;
  switch (typeof v) {
    case 'string':
      return v;
    case 'boolean':
      return v;
    case 'number':
      return Number.isFinite(v) ? v : String(v);
    case 'bigint':
      return v.toString();
    case 'object':
      if (v instanceof Date) return formatUtcDateTime(v);
      if (v instanceof Uint8Array) return binaryCell(v);
      if (Array.isArray(v) || isPlainObject(v)) {
        try {
          return JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));
        } catch {
          return String(v);
        }
      }
      return String(v);
    default:
      return String(v);
  }
}

function isPlainObject(v: object): boolean {
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null || typeof (v as any).toJSON !== 'function';
}

/** Map a database type name to a coarse kind for alignment / formatting in the UI. */
export function kindFromTypeName(typeName: string): ValueKind {
  const t = typeName.toLowerCase();
  if (/^(bool|boolean|bit)\b/.test(t)) return 'bool';
  if (/(int|serial|numeric|decimal|real|double|float|money|number|long|short|byte)/.test(t) && !/interval|point/.test(t))
    return 'number';
  if (/(timestamp|datetime|date|time|interval|year)/.test(t)) return 'date';
  if (/(binary|blob|bytea|image|varbinary)/.test(t)) return 'binary';
  if (/json/.test(t)) return 'json';
  if (/(char|text|string|uuid|xml|enum|set|name|citext|uniqueidentifier|clob)/.test(t)) return 'text';
  return 'other';
}

/** Render a cell as plain text for CSV / clipboard. NULL becomes the given marker (default empty). */
export function cellToText(c: Cell, nullText = ''): string {
  if (c === null) return nullText;
  if (typeof c === 'object') return `0x${c.$binary}${c.truncated ? '…' : ''}`;
  return String(c);
}
