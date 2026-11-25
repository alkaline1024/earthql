import { format, type SqlLanguage } from 'sql-formatter';
import type { DriverId } from '@earthql/core';

const DIALECT: Record<DriverId, SqlLanguage> = {
  postgres: 'postgresql',
  mysql: 'mysql',
  mssql: 'tsql',
  databricks: 'spark',
};

/** Pretty-prints SQL for a given driver's dialect. Throws on unparsable input — callers should catch it. */
export function formatSql(sql: string, driver: DriverId): string {
  return format(sql, { language: DIALECT[driver], keywordCase: 'upper' });
}
