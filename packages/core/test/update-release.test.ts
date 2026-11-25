import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { downloadUpdate, isNewerVersion, readUpdateRelease, releaseKey } from '../../../apps/desktop/src/main/update-release';

const keys = generateKeyPairSync('ed25519');
const key = releaseKey(keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'));
const bytes = Buffer.from('test archive');
const release = {
  schema: 1,
  version: '0.10.0',
  file: 'EarthQL-0.10.0-arm64-mac.zip',
  size: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'),
};

function manifest(value: typeof release, signer = keys.privateKey) {
  const payload = Buffer.from(JSON.stringify(value));
  return JSON.stringify({ payload: payload.toString('base64'), signature: sign(null, payload, signer).toString('base64') });
}

afterEach(() => vi.unstubAllGlobals());

it('accepts the release key and compares stable versions numerically', () => {
  expect(readUpdateRelease(manifest(release), key)).toEqual(release);
  expect(isNewerVersion('0.10.0', '0.9.1')).toBe(true);
  expect(isNewerVersion('0.10.0', '0.10.0')).toBe(false);
  expect(isNewerVersion('0.9.1', '0.10.0')).toBe(false);
});

it('rejects a different key, a modified manifest and unsafe signed filenames', () => {
  expect(() => readUpdateRelease(manifest(release, generateKeyPairSync('ed25519').privateKey), key)).toThrow(/signature/);
  const envelope = JSON.parse(manifest(release));
  envelope.payload = Buffer.from(JSON.stringify({ ...release, size: 1 })).toString('base64');
  expect(() => readUpdateRelease(JSON.stringify(envelope), key)).toThrow(/signature/);
  expect(() => readUpdateRelease(manifest({ ...release, file: '../update.zip' }), key)).toThrow(/supported/);
});

it('verifies downloaded bytes and rejects corruption and oversized archives', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'earthql-update-test-'));
  try {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(new Uint8Array(bytes)))
      .mockResolvedValueOnce(new Response('bad archive!'))
      .mockResolvedValueOnce(new Response('longer than test archive'));
    vi.stubGlobal('fetch', fetch);
    const progress = vi.fn();
    await downloadUpdate(release, path.join(directory, 'valid.zip'), progress);
    expect(progress).toHaveBeenLastCalledWith(1);
    expect(fetch.mock.calls[0][0]).toBe('https://github.com/alkaline1024/earthql/releases/download/v0.10.0/EarthQL-0.10.0-arm64-mac.zip');
    await expect(downloadUpdate(release, path.join(directory, 'corrupt.zip'), progress)).rejects.toThrow(/does not match/);
    await expect(downloadUpdate(release, path.join(directory, 'oversize.zip'), progress)).rejects.toThrow(/exceeds/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
