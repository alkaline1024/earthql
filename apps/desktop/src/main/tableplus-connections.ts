import { randomUUID } from 'node:crypto';
import { makeError, type ConnectionProfile, type EnvironmentTag, type TlsMode } from '@earthql/core';
import { ENV_PRESETS } from '../shared/environments';

type TablePlusDriver = Exclude<ConnectionProfile['driver'], 'databricks'>;
type PortableProfile = Extract<ConnectionProfile, { driver: TablePlusDriver }>;
type Entry = Record<string, unknown>;

const DRIVERS = { postgres: 'PostgreSQL', mysql: 'MySQL', mssql: 'MicrosoftSQLServer' } as const;
const PORTS = { postgres: 5432, mysql: 3306, mssql: 1433 } as const;
const DEFAULT_DATABASE = { postgres: 'postgres', mysql: '', mssql: '' } as const;
const MAX_ENTRIES = 10_000;
const PRESET_ENVIRONMENTS = new Map(ENV_PRESETS.map((env) => [env.name.toLowerCase(), env]));

function environmentKey(name: string): string {
  const key = name.trim().toLowerCase();
  return key === 'product' ? 'production' : key;
}

function asEntry(value: unknown): Entry | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Entry : undefined;
}

function string(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function isOn(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 'true';
}

function integer(value: unknown): number {
  if (typeof value === 'number') return value;
  return typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
}

function importTls(driver: TablePlusDriver, value: unknown): TlsMode | undefined {
  const mode = value === undefined ? 0 : integer(value);
  if (driver === 'mssql') return 'require';
  if (mode === 1) return 'disable';
  if (mode === 0 || mode === 2 || (driver === 'postgres' && mode === 3)) return 'require';
  if (mode === 4 || mode === (driver === 'mysql' ? 3 : 5)) return 'verify';
  return undefined;
}

function importProfile(row: Entry, now: number, environments: ReadonlyMap<string, EnvironmentTag>): PortableProfile | undefined {
  const driverName = string(row.Driver).toLowerCase();
  const driver = (Object.keys(DRIVERS) as TablePlusDriver[]).find((key) => DRIVERS[key].toLowerCase() === driverName);
  if (!driver || isOn(row.isOverSSH) || isOn(row.isUseSocket) || string(row.Authenticator) ||
    string(row.DatabaseType) || string(row.MicrosoftEntraIDTenantID) || string(row.MicrosoftEntraIDApplicationID) ||
    (Array.isArray(row.TlsKeyPaths) && row.TlsKeyPaths.some((item) => string(item).trim()))) return undefined;
  const host = string(row.DatabaseHost).trim();
  const user = string(row.DatabaseUser);
  const rawPort = row.DatabasePort;
  const port = rawPort === undefined || rawPort === '' ? PORTS[driver] : integer(rawPort);
  const mode = importTls(driver, row.tLSMode ?? row.TLSMode);
  if (!host || /[\s\\/\u0000]/u.test(host) || !user.trim() || !Number.isSafeInteger(port) || port < 1 || port > 65535 || !mode) return undefined;

  const tag = string(row.Enviroment ?? row.Environment);
  const color = string(row.statusColor ?? row.StatusColor);
  const environment = environments.get(environmentKey(tag));
  const serverName = string(row.ServerNameIndication);
  return {
    id: randomUUID(),
    name: string(row.ConnectionName).trim() || host,
    env: environment ? { ...environment } : { name: tag, color: /^#[0-9a-f]{6}$/i.test(color) ? color : '#667085' },
    createdAt: now,
    updatedAt: now,
    driver,
    host,
    user,
    port,
    database: string(row.DatabaseName) || DEFAULT_DATABASE[driver],
    tls: { mode, ...(serverName ? { serverName } : {}) },
  };
}

function signature(profile: PortableProfile): string {
  const { driver, host, port, database, user, name, tls } = profile;
  return JSON.stringify([driver, host.toLowerCase(), port, database || DEFAULT_DATABASE[driver], user, name, tls.mode, tls.serverName || '', tls.caCert || '']);
}

export function importTablePlusProfiles(data: unknown, existing: ConnectionProfile[], { encrypted = false, now = Date.now() } = {}) {
  const root = asEntry(data);
  const rows = root && (root.connections ?? root.Connections);
  const groups = root && (root.groups ?? root.Groups);
  const stack: Iterator<unknown>[] = [];
  if (Array.isArray(data)) stack.push(data.values());
  else {
    if (Array.isArray(groups)) stack.push(groups.values());
    if (Array.isArray(rows)) stack.push(rows.values());
  }
  if (!stack.length) throw makeError('config', 'The file does not contain a TablePlus connection list.');

  const environments = new Map(PRESET_ENVIRONMENTS);
  const profilesBySignature = new Map<string, PortableProfile | null>();
  for (const profile of existing) {
    const env = profile.env;
    const name = env && environmentKey(env.name);
    if (name && !environments.has(name)) environments.set(name, env);
    if (profile.driver === 'databricks') continue;
    const key = signature(profile);
    profilesBySignature.set(key, profilesBySignature.has(key) ? null : profile);
  }
  const profiles: PortableProfile[] = [];
  const environmentUpdates = new Map<string, EnvironmentTag>();
  const passwords = new Map<string, string>();
  let entries = 0;
  let duplicates = 0;
  let skipped = 0;
  while (stack.length) {
    const next = stack[stack.length - 1].next();
    if (next.done) {
      stack.pop();
      continue;
    }
    if (++entries > MAX_ENTRIES) throw makeError('config', 'The file contains too many TablePlus entries.');
    const row = asEntry(next.value);
    if (!row) { skipped++; continue; }
    if (!row.Driver && (Array.isArray(row.connections) || Array.isArray(row.groups))) {
      if (Array.isArray(row.groups)) stack.push(row.groups.values());
      if (Array.isArray(row.connections)) stack.push(row.connections.values());
      continue;
    }
    const profile = importProfile(row, now, environments);
    if (!profile) { skipped++; continue; }
    const key = signature(profile);
    const existingProfile = profilesBySignature.get(key);
    if (existingProfile === undefined) {
      profilesBySignature.set(key, profile);
      profiles.push(profile);
    } else {
      duplicates++;
      const importedKey = environmentKey(profile.env.name);
      const preset = PRESET_ENVIRONMENTS.get(importedKey);
      const previous = existingProfile?.env;
      if (existingProfile && previous && preset && environmentKey(previous.name) === importedKey &&
        (previous.name !== preset.name || previous.color !== preset.color)) {
        environmentUpdates.set(existingProfile.id, preset);
      }
    }
    const id = (existingProfile === undefined ? profile : existingProfile)?.id;
    const password = encrypted ? string(row.DatabasePassword) : '';
    if (id && password && !passwords.has(id)) passwords.set(id, password);
  }
  return { profiles, environmentUpdates, passwords, duplicates, skipped };
}

export function exportTablePlusProfiles(profiles: ConnectionProfile[]) {
  const rows = profiles.flatMap((profile) => {
    if (profile.driver === 'databricks') return [];
    const { driver, name, host, port, user, database, env, tls } = profile;
    const mode = tls.mode === 'disable' ? 1 : tls.mode === 'require' ? 2 : driver === 'mysql' ? 4 : 5;
    return [{
      ID: randomUUID().toUpperCase(),
      Driver: DRIVERS[driver],
      DriverVersion: driver === 'mssql' ? 6 : 0,
      ConnectionName: name,
      DatabaseHost: host,
      DatabasePort: String(port),
      DatabaseUser: user,
      DatabaseName: database ?? '',
      DatabaseType: '',
      GroupID: '',
      Enviroment: env.name.toLowerCase(),
      statusColor: env.color,
      statusColorIndex: -1,
      DatabasePasswordMode: 0,
      isOverSSH: false,
      isUseSocket: false,
      tLSMode: driver === 'mssql' ? 0 : mode,
      ServerNameIndication: tls.serverName ?? '',
    }];
  });
  const reviewTls = profiles.filter((p) => p.driver !== 'databricks' && (p.tls.caCert || (p.driver === 'mssql' && p.tls.mode !== 'require'))).length;
  return { rows, skipped: profiles.length - rows.length, reviewTls };
}
