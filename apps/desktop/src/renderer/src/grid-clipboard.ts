import { toTsv, type Cell, type ResultColumn } from '@earthql/core';

export interface GridRowsClipboard {
  columns?: string[];
  rows: Cell[][];
  defaults?: boolean[][];
  now?: boolean[][];
}

let copiedRows: { text: string; data: GridRowsClipboard } | undefined;

export async function copyGridRows(columns: ResultColumn[], rows: Cell[][], defaults?: boolean[][], now?: boolean[][]): Promise<void> {
  const text = toTsv(columns, rows);
  const data = structuredClone({ columns: columns.map((column) => column.name), rows, defaults, now });
  await navigator.clipboard.writeText(text);
  copiedRows = { text, data };
}

export function gridRowsFromText(text: string): GridRowsClipboard {
  if (copiedRows?.text === text) return structuredClone(copiedRows.data);
  if (!text) throw new Error('The clipboard contains no rows.');
  return { rows: text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n').map((line) => line.split('\t')) };
}
