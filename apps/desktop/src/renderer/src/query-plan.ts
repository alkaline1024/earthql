import { isReadOnlyStatement, leadingKeyword, splitStatements, type DriverId } from '@earthql/core';

export function explainStatement(sql: string, driver: DriverId): string {
  const statements = splitStatements(sql, driver);
  if (statements.length !== 1) throw new Error('Select exactly one query to explain.');
  const statement = statements[0].sql;
  const keyword = leadingKeyword(statement, driver);
  if ((keyword !== 'SELECT' && keyword !== 'WITH') || !isReadOnlyStatement(statement, driver)) {
    throw new Error('Only a read-only SELECT can be explained.');
  }

  if (driver === 'mssql') return statement;
  const prefix = driver === 'postgres' ? 'EXPLAIN (FORMAT JSON)' : driver === 'mysql' ? 'EXPLAIN FORMAT=JSON' : 'EXPLAIN FORMATTED';
  return `${prefix} ${statement}`;
}

export function formatPlanCell(value: string): string {
  if (!/^\s*[\[{]/.test(value)) return value;
  try { return JSON.stringify(JSON.parse(value), null, 2); }
  catch { return value; }
}
