import type { DriverId } from './types';

export interface SplitStatement {
  sql: string;
  /** Offset of the first character of the statement in the original text. */
  start: number;
  end: number;
}

/**
 * The statement the cursor is positioned in (inclusive of its edges), for "run the current
 * statement" semantics. Falls back to the next statement after the cursor, then the last one.
 */
export function statementAt(statements: SplitStatement[], cursor: number): SplitStatement | undefined {
  return statements.find((s) => cursor >= s.start && cursor <= s.end)
    ?? statements.find((s) => s.start >= cursor)
    ?? statements.at(-1);
}

/**
 * Split SQL text into statements on `;` (and on lines containing only `GO` for SQL Server),
 * ignoring separators inside quotes, identifiers, comments and PostgreSQL dollar-quoted bodies.
 * Comment-only fragments are dropped.
 */
export function splitStatements(text: string, driver: DriverId): SplitStatement[] {
  const out: SplitStatement[] = [];
  let i = 0;
  let stmtStart = 0;
  const n = text.length;
  // Track BEGIN...END nesting for T-SQL / MySQL compound statements loosely: we do not try;
  // users can run such blocks by selecting them (we then send the selection as-is when it contains no top-level ';').

  const push = (end: number) => {
    const raw = text.slice(stmtStart, end);
    if (!isBlank(raw, driver)) {
      const lead = raw.length - raw.trimStart().length;
      const trimmed = raw.trim();
      out.push({ sql: trimmed, start: stmtStart + lead, end: stmtStart + lead + trimmed.length });
    }
  };

  while (i < n) {
    const c = text[i];
    const next = text[i + 1];

    // line comment
    if ((c === '-' && next === '-') || (c === '#' && driver === 'mysql')) {
      const nl = text.indexOf('\n', i);
      i = nl === -1 ? n : nl + 1;
      continue;
    }
    // block comment (PostgreSQL allows nesting)
    if (c === '/' && next === '*') {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (driver === 'postgres' && text[i] === '/' && text[i + 1] === '*') {
          depth++;
          i += 2;
        } else if (text[i] === '*' && text[i + 1] === '/') {
          depth--;
          i += 2;
        } else i++;
      }
      continue;
    }
    // quoted strings / identifiers
    if (c === "'" || c === '"' || (c === '`' && driver !== 'mssql')) {
      i = skipQuoted(text, i, c, driver);
      continue;
    }
    if (c === '[' && driver === 'mssql') {
      i = skipUntil(text, i + 1, ']', true);
      continue;
    }
    // PostgreSQL E'' strings are covered by the quote rule; dollar quotes:
    if (c === '$' && driver === 'postgres') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(i, i + 64));
      if (m && !isIdentChar(text[i - 1])) {
        const tag = m[0];
        const close = text.indexOf(tag, i + tag.length);
        i = close === -1 ? n : close + tag.length;
        continue;
      }
    }
    if (c === ';') {
      push(i);
      i++;
      stmtStart = i;
      continue;
    }
    // GO batch separator: a line consisting only of GO (case-insensitive)
    if (driver === 'mssql' && (c === 'G' || c === 'g') && atLineStart(text, i)) {
      const m = /^go[ \t]*(?:\r?\n|$)/i.exec(text.slice(i, i + 8));
      if (m) {
        push(i);
        i += m[0].length;
        stmtStart = i;
        continue;
      }
    }
    i++;
  }
  push(n);
  return out;
}

function isIdentChar(ch: string | undefined): boolean {
  return !!ch && /[A-Za-z0-9_]/.test(ch);
}

function atLineStart(text: string, i: number): boolean {
  let j = i - 1;
  while (j >= 0 && (text[j] === ' ' || text[j] === '\t')) j--;
  return j < 0 || text[j] === '\n';
}

function skipQuoted(text: string, i: number, q: string, driver: DriverId): number {
  const n = text.length;
  let j = i + 1;
  // MySQL and Databricks allow backslash escapes inside string literals.
  const backslash = (driver === 'mysql' || driver === 'databricks') && q !== '`';
  // PostgreSQL E'...' strings allow backslash escapes too.
  const eString = driver === 'postgres' && q === "'" && (text[i - 1] === 'E' || text[i - 1] === 'e') && !isIdentChar(text[i - 2]);
  while (j < n) {
    const ch = text[j];
    if ((backslash || eString) && ch === '\\') {
      j += 2;
      continue;
    }
    if (ch === q) {
      if (text[j + 1] === q) {
        j += 2; // doubled quote escape
        continue;
      }
      return j + 1;
    }
    j++;
  }
  return n;
}

function skipUntil(text: string, i: number, close: string, doubledEscape: boolean): number {
  const n = text.length;
  let j = i;
  while (j < n) {
    if (text[j] === close) {
      if (doubledEscape && text[j + 1] === close) {
        j += 2;
        continue;
      }
      return j + 1;
    }
    j++;
  }
  return n;
}

/** True when the fragment contains nothing but whitespace and comments. */
function isBlank(fragment: string, driver: DriverId): boolean {
  return stripComments(fragment, driver).trim() === '';
}

export function stripComments(sql: string, driver: DriverId): string {
  let out = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];
    if ((c === '-' && next === '-') || (c === '#' && driver === 'mysql')) {
      const nl = sql.indexOf('\n', i);
      i = nl === -1 ? n : nl + 1;
      out += ' ';
      continue;
    }
    if (c === '/' && next === '*') {
      const close = sql.indexOf('*/', i + 2);
      i = close === -1 ? n : close + 2;
      out += ' ';
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const j = skipQuoted(sql, i, c, driver);
      out += sql.slice(i, j);
      i = j;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** First keyword of a statement, uppercased (comments skipped). */
export function leadingKeyword(sql: string, driver: DriverId): string {
  const m = /^[\s(]*([A-Za-z]+)/.exec(stripComments(sql, driver));
  return m ? m[1].toUpperCase() : '';
}

const READ_KEYWORDS = new Set(['SELECT', 'WITH', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN', 'VALUES', 'TABLE', 'LIST', 'PRAGMA']);

/**
 * Heuristic: does this statement only read? Used to decide whether a lost connection
 * leaves the outcome unknown (writes) and whether re-running for export is safe.
 * `WITH ... INSERT/UPDATE/DELETE` (PostgreSQL data-modifying CTEs) count as writes.
 */
export function isReadOnlyStatement(sql: string, driver: DriverId): boolean {
  const kw = leadingKeyword(sql, driver);
  if (!READ_KEYWORDS.has(kw)) return false;
  if (kw === 'WITH' || kw === 'EXPLAIN') {
    const body = stripComments(sql, driver).toUpperCase();
    if (/\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|DROP|ALTER|CREATE)\b/.test(body.replace(/'[^']*'/g, "''"))) return false;
  }
  if (kw === 'SELECT' && /\bINTO\b/i.test(stripComments(sql, driver).replace(/'[^']*'/g, "''"))) {
    // SELECT ... INTO creates tables in SQL Server / PostgreSQL
    return false;
  }
  return true;
}
