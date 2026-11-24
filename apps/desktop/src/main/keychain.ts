import { Entry } from '@napi-rs/keyring';
import type { SecretField, Secrets } from '@earthql/core';

// Secrets live in the macOS login Keychain as generic passwords:
//   service = "EarthQL", account = "<profileId>:<field>"
const SERVICE = 'EarthQL';
const FIELDS: SecretField[] = ['password', 'clientSecret', 'accessToken'];

function entry(profileId: string, field: SecretField): Entry {
  return new Entry(SERVICE, `${profileId}:${field}`);
}

export function getSecrets(profileId: string): Secrets {
  const out: Secrets = {};
  for (const f of FIELDS) {
    try {
      const v = entry(profileId, f).getPassword();
      if (v) out[f] = v;
    } catch {
      /* not found */
    }
  }
  return out;
}

export function storedFields(profileId: string): SecretField[] {
  return Object.keys(getSecrets(profileId)) as SecretField[];
}

export function setSecret(profileId: string, field: SecretField, value: string): void {
  if (value === '') {
    deleteSecret(profileId, field);
    return;
  }
  entry(profileId, field).setPassword(value);
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
