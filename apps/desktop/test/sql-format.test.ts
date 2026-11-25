import { describe, expect, it } from 'vitest';
import type { DriverId } from '@earthql/core';
import { formatSql } from '../src/renderer/src/sql-format';

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
