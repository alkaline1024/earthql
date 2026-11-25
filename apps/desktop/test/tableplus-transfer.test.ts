import { describe, expect, it } from 'vitest';
import type { ConnectionProfile } from '@earthql/core';
import { exportTablePlusProfiles, importTablePlusProfiles } from '../src/main/tableplus-connections';
import { decryptTablePlus, encryptTablePlus, isTablePlusEncrypted } from '../src/main/tableplus-crypto';

const mysql = {
  ID: 'FIXTURE', Driver: 'MySQL', ConnectionName: 'MySQL – ทดสอบ', DatabaseHost: 'mysql.example.test',
  DatabasePort: '3307', DatabaseUser: 'reader', DatabaseName: '', DatabasePassword: 'fixture secret',
  tLSMode: 4, Enviroment: 'staging', statusColor: '#d48806',
};
const postgres = { ...mysql, Driver: 'PostgreSQL', ConnectionName: 'Postgres', DatabasePort: 5433, DatabaseName: 'demo', tLSMode: 1 };
const mssql = { ...mysql, Driver: 'MicrosoftSQLServer', ConnectionName: 'SQL Server', DatabasePort: 1433, DatabaseName: 'main', tLSMode: 0 };

describe('TablePlus connection transfer', () => {
  it('reads grouped exports, skips unsupported records, and preserves existing profiles', () => {
    const first = importTablePlusProfiles([mysql], [], { now: 42 }).profiles[0];
    const result = importTablePlusProfiles([{ groups: [{ connections: [mysql, postgres, { ...postgres, isOverSSH: true }] }], connections: [mssql, { Driver: 'SQLite' }] }], [first], { now: 43 });

    expect(result).toMatchObject({ duplicates: 1, skipped: 2 });
    expect(result.profiles).toMatchObject([
      { driver: 'mssql', port: 1433, database: 'main', tls: { mode: 'require' }, updatedAt: 43 },
      { driver: 'postgres', port: 5433, database: 'demo', tls: { mode: 'disable' }, updatedAt: 43 },
    ]);
    expect(new Set([first.id, ...result.profiles.map(({ id }) => id)]).size).toBe(3);
    expect(result.passwords.size).toBe(0);
    expect(JSON.stringify(result)).not.toContain('fixture secret');
  });

  it('matches environments case-insensitively and retains unfamiliar TablePlus tags and colors', () => {
    const existing = importTablePlusProfiles([
      { ...mysql, ConnectionName: 'Existing QA', Enviroment: 'QA East', statusColor: '#2468ac' },
    ], []).profiles;
    const { profiles } = importTablePlusProfiles([
      { ...mysql, Enviroment: 'pRoDuCtIoN', statusColor: '#123456' },
      { ...postgres, Enviroment: undefined, Environment: 'qa east', statusColor: '#abcdef' },
      { ...mssql, Enviroment: 'Partner Sandbox', statusColor: '#000000' },
      { ...mssql, ConnectionName: 'No color', Enviroment: 'Review', statusColor: undefined },
    ], existing);

    expect(profiles.map(({ env }) => env)).toEqual([
      { name: 'Production', color: '#e5484d' },
      { name: 'QA East', color: '#2468ac' },
      { name: 'Partner Sandbox', color: '#000000' },
      { name: 'Review', color: '#667085' },
    ]);
  });

  it('reads passwords only from encrypted transfers and matches them to new and existing profiles', () => {
    const [existing] = importTablePlusProfiles([mysql], []).profiles;
    const rows = [mysql, { ...postgres, DatabasePassword: ' คุณ O\'Brien ' }, { ...mysql, DatabasePassword: 'second copy' }, { ...mssql, DatabasePassword: '' }];
    const result = importTablePlusProfiles(rows, [existing], { encrypted: true });
    const [newPostgres] = result.profiles;

    expect(result.duplicates).toBe(2);
    expect(result.passwords).toEqual(new Map([[existing.id, 'fixture secret'], [newPostgres.id, ' คุณ O\'Brien ']]));
    expect(JSON.stringify(result.profiles)).not.toContain('O\'Brien');
    expect(importTablePlusProfiles(rows, [existing]).passwords.size).toBe(0);
    expect(importTablePlusProfiles([mysql], [existing, { ...existing, id: 'other' }], { encrypted: true }).passwords.size).toBe(0);
  });

  it('preserves an unspecified SQL Server database and distinguishes it from master', () => {
    const [loginDefault] = importTablePlusProfiles([{ ...mssql, DatabaseName: '' }], []).profiles;
    const [master] = importTablePlusProfiles([{ ...mssql, DatabaseName: 'master' }], []).profiles;
    expect(loginDefault.database).toBe('');
    expect(importTablePlusProfiles([{ ...mssql, DatabaseName: '' }], [master])).toMatchObject({ duplicates: 0 });
    const { rows } = exportTablePlusProfiles([loginDefault]);
    expect(rows[0].DatabaseName).toBe('');
    expect(importTablePlusProfiles(rows, [loginDefault])).toMatchObject({ profiles: [], duplicates: 1 });
  });

  it('maps product and updates matching legacy production tags without creating duplicates', () => {
    const rows = [{ ...mysql, Enviroment: ' PRODUCT ', statusColor: '#bdccf4' }, { ...mssql, Enviroment: 'production' }];
    const { profiles } = importTablePlusProfiles(rows, []);
    const preset = { name: 'Production', color: '#e5484d' };
    expect(profiles.map(({ env }) => env)).toEqual([preset, preset]);

    const existing = [
      { ...profiles[0], env: { name: 'production', color: '#bdccf4' } },
      { ...profiles[1], env: { name: 'Staging', color: '#d48806' } },
    ];
    const result = importTablePlusProfiles(rows, existing);
    expect(result.profiles).toEqual([]);
    expect(result.duplicates).toBe(2);
    expect(result.environmentUpdates).toEqual(new Map([[existing[0].id, preset]]));
  });

  it('exports three compatible drivers and keeps database passwords out of the file', async () => {
    const { profiles } = importTablePlusProfiles([mysql, postgres, mssql], []);
    const databricks: ConnectionProfile = {
      id: 'db', name: 'Warehouse', driver: 'databricks', host: 'warehouse.example.test', httpPath: '/sql/test',
      authMode: 'access-token', env: { name: '', color: '#667085' }, createdAt: 0, updatedAt: 0,
    };
    const { rows, skipped } = exportTablePlusProfiles([...profiles, databricks]);
    expect(skipped).toBe(1);
    expect(rows.map(({ Driver, tLSMode }) => [Driver, tLSMode])).toEqual([
      ['MySQL', 4], ['PostgreSQL', 1], ['MicrosoftSQLServer', 0],
    ]);
    const password = 'รหัสผ่านทดสอบ';
    const encrypted = await encryptTablePlus(Buffer.from(JSON.stringify(rows)), password);
    expect(isTablePlusEncrypted(encrypted)).toBe(true);
    expect(encrypted.includes(Buffer.from(mysql.DatabaseHost))).toBe(false);
    const payload = (await decryptTablePlus(encrypted, password)).toString();
    expect(payload).not.toContain('DatabasePassword"');
    expect(payload).not.toContain('fixture secret');
    expect(importTablePlusProfiles(JSON.parse(payload), profiles)).toMatchObject({ profiles: [], duplicates: 3, skipped: 0 });
  });

  it('does not export an SSH profile as a direct TablePlus connection', () => {
    const [pg] = importTablePlusProfiles([postgres], []).profiles;
    const ssh = { host: 'bastion', port: 22, user: 'user', hostKeyFingerprint: `SHA256:${'a'.repeat(43)}` };
    const { rows, skipped } = exportTablePlusProfiles([{ ...pg, ssh }]);
    expect(rows).toEqual([]);
    expect(skipped).toBe(1);
  });

  it('reads the published RNCryptor v3 vector and rejects a wrong password or forged tag', async () => {
    // https://github.com/RNCryptor/RNCryptor-Spec/blob/master/vectors/v3/password (One byte)
    const vector = Buffer.from('03010001 02030405 06070102 03040506 07080203 04050607 08090a0b 0c0d0e0f 0001a1f8 730e0bf4 80eb7b70 f690abf2 1e029514 164ad3c4 74a51b30 c7eaa1ca 545b7de3 de5b010a cbad0a9a 13857df6 96a8'.replaceAll(' ', ''), 'hex');
    await expect(decryptTablePlus(vector, 'thepassword')).resolves.toEqual(Buffer.from([1]));
    await expect(decryptTablePlus(vector, 'incorrect')).rejects.toMatchObject({ category: 'auth' });
    vector[vector.length - 1] ^= 1;
    await expect(decryptTablePlus(vector, 'thepassword')).rejects.toMatchObject({ category: 'auth' });
  });
});
