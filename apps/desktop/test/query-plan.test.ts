import { describe, expect, it } from 'vitest';
import { explainStatement, formatPlanCell } from '../src/renderer/src/query-plan';

describe('query plan', () => {
  it('builds estimated plans without executing the query', () => {
    expect(explainStatement('SELECT * FROM orders', 'postgres')).toBe('EXPLAIN (FORMAT JSON) SELECT * FROM orders');
    expect(explainStatement('SELECT 1', 'mysql')).toBe('EXPLAIN FORMAT=JSON SELECT 1');
    expect(explainStatement('SELECT 1', 'databricks')).toBe('EXPLAIN FORMATTED SELECT 1');
    expect(explainStatement('SELECT 1', 'mssql')).toBe('SELECT 1');
  });
  it('rejects multiple statements and writes', () => {
    expect(() => explainStatement('SELECT 1; DELETE FROM orders', 'postgres')).toThrow();
    expect(() => explainStatement('DELETE FROM orders', 'postgres')).toThrow();
    expect(() => explainStatement('SELECT 1; DELETE FROM orders', 'mssql')).toThrow();
  });
  it('formats JSON plans while preserving plain text plans', () => {
    expect(formatPlanCell('{"Plan":{"Node Type":"Seq Scan"}}')).toContain('\n  "Plan": {');
    expect(formatPlanCell('== Physical Plan ==')).toBe('== Physical Plan ==');
  });
});
