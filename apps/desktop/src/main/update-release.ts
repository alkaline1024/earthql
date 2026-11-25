import { createHash, createPublicKey, verify } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const releases = 'https://github.com/alkaline1024/earthql/releases';
export const manifestUrl = releases + '/latest/download/earthql-update.json';
export const manifestLimit = 16384;
const maxArchive = 512 * 1024 * 1024;
const stable = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;

export interface UpdateRelease {
  version: string;
  file: string;
  size: number;
  sha256: string;
}

export function isNewerVersion(candidate: string, current: string): boolean {
  if (!stable.test(candidate) || !stable.test(current)) throw new Error('Expected stable EarthQL versions.');
  const a = candidate.split('.').map(Number);
  const b = current.split('.').map(Number);
  for (let index = 0; index < a.length; index++) {
    if (a[index] !== b[index]) return a[index] > b[index];
  }
  return false;
}

export function releaseKey(encoded: string) {
  const key = createPublicKey({ key: Buffer.from(encoded, 'base64'), format: 'der', type: 'spki' });
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Expected an Ed25519 release key.');
  return key;
}

export function readUpdateRelease(data: string, key: ReturnType<typeof releaseKey>): UpdateRelease {
  const envelope = JSON.parse(data);
  if (typeof envelope?.payload !== 'string' || typeof envelope.signature !== 'string') throw new Error('Invalid update manifest.');
  const payload = Buffer.from(envelope.payload, 'base64');
  if (!verify(null, payload, key, Buffer.from(envelope.signature, 'base64'))) {
    throw new Error('The update manifest signature is invalid.');
  }
  const release = JSON.parse(payload.toString('utf8'));
  if (release?.schema !== 1 || typeof release.version !== 'string' || !stable.test(release.version) ||
    release.file !== `EarthQL-${release.version}-arm64-mac.zip` ||
    !Number.isInteger(release.size) || release.size < 1 || release.size > maxArchive ||
    typeof release.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(release.sha256)) {
    throw new Error('The signed manifest does not describe a supported EarthQL release.');
  }
  return release;
}

export async function getUpdateManifest(): Promise<string> {
  const response = await fetch(manifestUrl, { signal: AbortSignal.timeout(30000) });
  if (!response.ok || !response.body) throw new Error(`The update manifest is unavailable (HTTP ${response.status}).`);
  const buffers: Buffer[] = [];
  let size = 0;
  for await (const chunk of Readable.fromWeb(response.body)) {
    size += chunk.length;
    if (size > manifestLimit) throw new Error('The update manifest is too large.');
    buffers.push(chunk);
  }
  return Buffer.concat(buffers).toString('utf8');
}

export async function downloadUpdate(release: UpdateRelease, file: string, progress: (fraction: number) => void) {
  const url = `${releases}/download/v${release.version}/${release.file}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(15 * 60 * 1000) });
  if (!response.ok || !response.body) throw new Error(`The update archive is unavailable (HTTP ${response.status}).`);
  const hash = createHash('sha256');
  let size = 0;
  await pipeline(Readable.fromWeb(response.body), new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      if (size > release.size) return callback(new Error('The archive exceeds the signed size.'));
      hash.update(chunk);
      progress(size / release.size);
      callback(null, chunk);
    },
  }), createWriteStream(file, { flags: 'wx', mode: 0o600 }));
  if (size !== release.size || hash.digest('hex') !== release.sha256) {
    throw new Error('The archive does not match the signed manifest.');
  }
}
