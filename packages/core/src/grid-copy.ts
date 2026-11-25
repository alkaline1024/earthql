import type { Cell, ResultColumn } from './types';
import { cellToText } from './values';

/** Tab-separated, newline-joined — what every spreadsheet/text app understands on paste. */
export function toTsv(columns: ResultColumn[], rows: Cell[][]): string {
  return rows.map((row) => row.map((c) => cellToText(c, 'NULL')).join('\t')).join('\n');
}

export function toJsonRows(columns: ResultColumn[], rows: Cell[][]): string {
  const objects = rows.map((row) => Object.fromEntries(columns.map((col, i) => [col.name, row[i] ?? null])));
  return JSON.stringify(objects, null, 2);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function toHtmlTable(columns: ResultColumn[], rows: Cell[][]): string {
  const thead = `<tr>${columns.map((c) => `<th>${escapeHtml(c.name)}</th>`).join('')}</tr>`;
  const tbody = rows
    .map((row) => `<tr>${row.map((c) => `<td>${escapeHtml(cellToText(c, 'NULL'))}</td>`).join('')}</tr>`)
    .join('');
  return `<table><thead>${thead}</thead><tbody>${tbody}</tbody></table>`;
}

function escapeMarkdownCell(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}

export function toMarkdownTable(columns: ResultColumn[], rows: Cell[][]): string {
  const header = `| ${columns.map((c) => escapeMarkdownCell(c.name)).join(' | ')} |`;
  const divider = `| ${columns.map(() => '---').join(' | ')} |`;
  const body = rows.map((row) => `| ${row.map((c) => escapeMarkdownCell(cellToText(c, 'NULL'))).join(' | ')} |`);
  return [header, divider, ...body].join('\n');
}
