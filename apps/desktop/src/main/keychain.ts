import { Entry } from '@napi-rs/keyring';
import type { SecretField, Secrets } from '@earthql/core';

// Secrets live in the macOS login Keychain as generic passwords:
//   service = "EarthQL", account = "<profileId>:<field>"
const SERVICE = 'EarthQL';
const FIELDS: SecretField[] = ['password', 'clientSecret', 'accessToken'];

function entry(profileId: string, field: SecretField): Entry {
  return new Entry(SERVICE, `${profileId}:${field}`);
}

export function getSecrets(profileId: string, fields: SecretField[] = FIELDS): Secrets {
  const out: Secrets = {};
  for (const f of fields) {
    const v = entry(profileId, f).getPassword();
    if (v) out[f] = v;
  }
  return out;
}

export function setSecret(profileId: string, field: SecretField, value: string): void {
  if (value === '') {
    deleteSecret(profileId, field);
    return;
  }
  entry(profileId, field).setPassword(value);
}

export function saveImportedPassword(profileId: string, password: string): boolean {
  const credential = entry(profileId, 'password');
  if (credential.getPassword() !== null) return false;
  credential.setPassword(password);
  return true;
}

export function deleteSecret(profileId: string, field: SecretField): void {
  try {
    entry(profileId, field).deletePassword();
  } catch {
    /* already gone */
  }
}

export function deleteAllSecrets(profileId: string): void {
  for (const f of FIELDS) deleteSecret(profileId, f);
}
