import { createCipheriv, createDecipheriv, createHmac, pbkdf2, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { makeError } from '@earthql/core';

// TablePlus for macOS uses the password variant of the RNCryptor v3 wire format.
// https://github.com/RNCryptor/RNCryptor-Spec/blob/master/RNCryptor-Spec-v3.md
const derive = promisify(pbkdf2);
const VERSION = 3;
const PASSWORD_OPTION = 1;
const SALT_SIZE = 8;
const BLOCK_SIZE = 16;
const TAG_SIZE = 32;
const HEADER_SIZE = 2 + 2 * SALT_SIZE + BLOCK_SIZE;

export function isTablePlusEncrypted(data: Buffer): boolean {
  return data[0] === VERSION && data[1] === PASSWORD_OPTION;
}

async function keys(password: string, encryptionSalt: Buffer, hmacSalt: Buffer) {
  return Promise.all([derive(password, encryptionSalt, 10_000, 32, 'sha1'), derive(password, hmacSalt, 10_000, 32, 'sha1')]);
}

export async function decryptTablePlus(data: Buffer, password: string): Promise<Buffer> {
  const tagOffset = data.length - TAG_SIZE;
  const size = tagOffset - HEADER_SIZE;
  if (!isTablePlusEncrypted(data) || size < BLOCK_SIZE || size % BLOCK_SIZE !== 0) {
    throw makeError('config', 'The TablePlus connection file is incomplete or uses an unsupported encryption format.');
  }
  const [encryptionKey, hmacKey] = await keys(password, data.subarray(2, 10), data.subarray(10, 18));
  const expected = createHmac('sha256', hmacKey).update(data.subarray(0, tagOffset)).digest();
  if (!timingSafeEqual(expected, data.subarray(tagOffset))) {
    throw makeError('auth', 'The TablePlus file password is incorrect or the file is damaged.');
  }
  const cipher = createDecipheriv('aes-256-cbc', encryptionKey, data.subarray(18, HEADER_SIZE));
  return Buffer.concat([cipher.update(data.subarray(HEADER_SIZE, tagOffset)), cipher.final()]);
}

export async function encryptTablePlus(data: Buffer, password: string): Promise<Buffer> {
  if (!password) throw makeError('config', 'Enter a password to protect the TablePlus export.');
  const encryptionSalt = randomBytes(SALT_SIZE);
  const hmacSalt = randomBytes(SALT_SIZE);
  const iv = randomBytes(BLOCK_SIZE);
  const [encryptionKey, hmacKey] = await keys(password, encryptionSalt, hmacSalt);
  const cipher = createCipheriv('aes-256-cbc', encryptionKey, iv);
  const protectedData = Buffer.concat([Buffer.from([VERSION, PASSWORD_OPTION]), encryptionSalt, hmacSalt, iv, cipher.update(data), cipher.final()]);
  const tag = createHmac('sha256', hmacKey).update(protectedData).digest();
  return Buffer.concat([protectedData, tag]);
}
