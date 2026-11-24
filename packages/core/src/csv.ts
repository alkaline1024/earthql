import type { Cell, ResultColumn } from './types';
import { cellToText } from './values';

export interface CsvOptions {
  /** Text written for SQL NULL. Default: empty field. */
  nullText?: string;
  delimiter?: string;
  /** Write a UTF-8 BOM so Excel opens Unicode correctly. */
  bom?: boolean;
}

/** Quote a field when needed. An empty string is written as "" so it stays distinct from NULL (an empty field). */
export function csvField(text: string, delimiter = ','): string {
  if (text === '') return '""';
  if (text.includes('"') || text.includes(delimiter) || text.includes('\n') || text.includes('\r') || /^\s|\s$/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

export function csvHeader(columns: ResultColumn[], opts: CsvOptions = {}): string {
  const d = opts.delimiter ?? ',';
  return (opts.bom ? '﻿' : '') + columns.map((c) => csvField(c.name, d)).join(d) + '\r\n';
}

export function csvRows(rows: Cell[][], opts: CsvOptions = {}): string {
  const d = opts.delimiter ?? ',';
  const nullText = opts.nullText ?? '';
  let out = '';
  for (const r of rows) {
    out += r.map((c) => (c === null ? (nullText === '' ? '' : csvField(nullText, d)) : csvField(cellToText(c), d))).join(d) + '\r\n';
  }
  return out;
}

export function toCsv(columns: ResultColumn[], rows: Cell[][], opts: CsvOptions = {}): string {
  return csvHeader(columns, opts) + csvRows(rows, opts);
}
