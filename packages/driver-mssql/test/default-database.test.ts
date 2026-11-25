import { describe, expect, it, vi } from 'vitest';
import type { MssqlProfile } from '@earthql/core';

const mocks = vi.hoisted(() => ({ configs: [] as Array<{ database?: string }> }));
vi.mock('mssql', () => ({
  default: {
    ConnectionPool: class {
      constructor(config: { database?: string }) { mocks.configs.push(config); }
      on() {}
      async connect() {}
      async close() {}
      request() {
        return { query: async (text: string) => ({
          recordset: text.includes('@@VERSION') ? [{ db: 'login_db', v: 'SQL Server' }] : [{ encrypt_option: 'TRUE' }],
        }) };
      }
    },
  },
}));

import { mssqlDriver } from '../src';

const profile: MssqlProfile = {
  id: 'test', name: 'Test', driver: 'mssql', host: 'localhost', port: 1433, database: '', user: 'user',
  tls: { mode: 'require' }, env: { name: 'Local', color: '#888' }, createdAt: 0, updatedAt: 0,
};

describe('SQL Server default database', () => {
  it('leaves the login database unspecified when empty and preserves an explicit database', async () => {
    for (const database of ['', 'master']) {
      const conn = mssqlDriver.connect({ ...profile, database }, {});
      expect(conn.defaultContext().database).toBe(database || undefined);
      const result = await conn.test();
      expect(result.ok).toBe(true);
      expect(mocks.configs.at(-1)?.database).toBe(database || undefined);
      expect(result.steps[1].name).toContain(database || '(login default)');
      await conn.close();
    }
  });
});
