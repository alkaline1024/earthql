import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

const [version, archive] = process.argv.slice(2);
if (!/^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/.test(version) ||
  !archive || basename(archive) !== `EarthQL-${version}-arm64-mac.zip`) {
  throw new Error('Pass the stable version and its EarthQL arm64 update ZIP.');
}
const privateKey = createPrivateKey({
  key: Buffer.from(process.env.EARTHQL_UPDATE_PRIVATE_KEY ?? '', 'base64'),
  format: 'der',
  type: 'pkcs8',
});
const expected = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).toString('base64');
if (privateKey.asymmetricKeyType !== 'ed25519' || expected !== process.env.EARTHQL_UPDATE_PUBLIC_KEY) {
  throw new Error('The Ed25519 public and private release keys do not match.');
}
const { size } = await stat(archive);
if (size < 1 || size > 512 * 1024 * 1024) throw new Error('The update ZIP has an unsupported size.');
const hash = createHash('sha256');
for await (const chunk of createReadStream(archive)) hash.update(chunk);
const payload = Buffer.from(JSON.stringify({ schema: 1, version, file: basename(archive), size, sha256: hash.digest('hex') }));
await writeFile(join(dirname(archive), 'earthql-update.json'), JSON.stringify({
  payload: payload.toString('base64'),
  signature: sign(null, payload, privateKey).toString('base64'),
}) + '\n');
