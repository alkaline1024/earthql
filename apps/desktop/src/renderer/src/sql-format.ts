import { format, type SqlLanguage } from 'sql-formatter';
import type { DriverId } from '@earthql/core';

const DIALECT: Record<DriverId, SqlLanguage> = {
  postgres: 'postgresql',
  mysql: 'mysql',
  mssql: 'tsql',
  databricks: 'spark',
};

/** Pretty-prints SQL for a given driver's dialect. Throws on unparsable input — callers should catch it. */
export function formatSql(sql: string, driver: DriverId, uppercaseKeywords = true): string {
  return format(sql, { language: DIALECT[driver], keywordCase: uppercaseKeywords ? 'upper' : 'preserve' });
}

/**
 * Collapses SQL onto one line: whitespace runs become a single space and comments are dropped
 * (a `--` comment would otherwise swallow the rest of the line once newlines are gone).
 * String literals, quoted identifiers, dollar-quoted bodies and `/*+ hint *\/` comments are left untouched.
 * Dialect-agnostic and never throws.
 */
export function uglifySql(sql: string): string {
  let out = '';
  let gap = false;
  const emit = (text: string) => {
    if (gap && out) out += ' ';
    gap = false;
    out += text;
  };
  const closing = (from: number, terminator: string) => {
    const end = sql.indexOf(terminator, from);
    return end < 0 ? sql.length : end + terminator.length;
  };
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (/\s/.test(ch)) {
      gap = true;
      i++;
    } else if (ch === '-' && sql[i + 1] === '-') {
      i = closing(i, '\n');
      gap = true;
    } else if (ch === '/' && sql[i + 1] === '*') {
      const end = closing(i + 2, '*/');
      const comment = sql.slice(i, end);
      if (comment.startsWith('/*+') || comment.startsWith('/*!')) emit(comment);
      else gap = true;
      i = end;
    } else if (ch === "'" || ch === '"' || ch === '`') {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] !== ch) j++;
        else if (sql[j + 1] === ch) j += 2;
        else break;
      }
      const end = Math.min(j + 1, sql.length);
      emit(sql.slice(i, end));
      i = end;
    } else if (ch === '$') {
      const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(i, i + 64))?.[0];
      const end = tag ? closing(i + tag.length, tag) : i + 1;
      emit(sql.slice(i, end));
      i = end;
    } else {
      emit(ch);
      i++;
    }
  }
  return out;
}
