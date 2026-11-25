import { describe, expect, it } from 'vitest';

const databricks = [
  'EARTHQL_IT_DATABRICKS_HOST', 'EARTHQL_IT_DATABRICKS_HTTP_PATH', 'EARTHQL_IT_DATABRICKS_CATALOG',
  'EARTHQL_IT_DATABRICKS_SCHEMA', 'EARTHQL_IT_DATABRICKS_TOKEN',
];
const relational = ['EARTHQL_IT_PG', 'EARTHQL_IT_MYSQL', 'EARTHQL_IT_MSSQL'];

describe('integration test configuration', () => {
  it('rejects a partially configured Databricks workspace', () => {
    const present = databricks.filter((name) => !!process.env[name]);
    if (present.length) expect(databricks.filter((name) => !process.env[name])).toEqual([]);
  });

  it.skipIf(process.env.EARTHQL_IT_REQUIRE_ALL !== '1')('requires every driver when full integration coverage is requested', () => {
    expect([...relational, ...databricks].filter((name) => !process.env[name])).toEqual([]);
  });
});
