import { describe, expect, it } from 'vitest';
import type { DriverId } from '@earthql/core';
import { formatSql, uglifySql } from '../src/renderer/src/sql-format';

const DRIVERS: DriverId[] = ['postgres', 'mysql', 'mssql', 'databricks'];

describe('formatSql', () => {
  it.each(DRIVERS)('formats a simple query for %s without throwing', (driver) => {
    const out = formatSql('select a,b from t where a=1 and b=2', driver);
    expect(out).toContain('SELECT');
    expect(out).toContain('FROM');
    expect(out.split('\n').length).toBeGreaterThan(1);
  });

  it('throws on genuinely malformed SQL so callers can show an error', () => {
    expect(() => formatSql('select from where (((', 'postgres')).toThrow();
  });
});

describe('uglifySql', () => {
  it('collapses whitespace and newlines to single spaces', () => {
    expect(uglifySql('select  a,\n  b\nfrom   t')).toBe('select a, b from t');
  });

  it('trims the ends', () => {
    expect(uglifySql('\n  select 1  \n')).toBe('select 1');
  });

  it('drops comments so a line comment cannot swallow the rest of the query', () => {
    expect(uglifySql('select 1 -- why\nfrom t')).toBe('select 1 from t');
    expect(uglifySql('select /* x */ 1 from/* y */t')).toBe('select 1 from t');
    expect(uglifySql('select 1 -- trailing')).toBe('select 1');
  });

  it('keeps optimizer hints and MySQL conditional comments', () => {
    expect(uglifySql('select /*+ INDEX(t i) */  1')).toBe('select /*+ INDEX(t i) */ 1');
    expect(uglifySql('select /*! STRAIGHT_JOIN */  1')).toBe('select /*! STRAIGHT_JOIN */ 1');
  });

  it('leaves strings and quoted identifiers alone', () => {
    expect(uglifySql("select 'a   b\n c',  \"x  y\", `p  q` from t")).toBe("select 'a   b\n c', \"x  y\", `p  q` from t");
    expect(uglifySql("select 'it''s  ok'  as  v")).toBe("select 'it''s  ok' as v");
    expect(uglifySql("select '-- not a comment'  from t")).toBe("select '-- not a comment' from t");
  });

  it('leaves dollar-quoted bodies alone', () => {
    expect(uglifySql('select $$a   b$$,   $tag$c\n d$tag$')).toBe('select $$a   b$$, $tag$c\n d$tag$');
  });

  it('never throws on malformed SQL', () => {
    for (const bad of ["select 'unterminated", 'select /* open', 'select $', 'select (((', '']) {
      expect(() => uglifySql(bad)).not.toThrow();
    }
  });
});
