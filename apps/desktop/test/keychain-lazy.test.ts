import { beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ reads: [] as string[], failure: null as Error | null }));
vi.mock('@napi-rs/keyring', () => ({
  Entry: class {
    constructor(_service: string, private account: string) {}
    getPassword() {
      mock.reads.push(this.account);
      if (mock.failure) throw mock.failure;
      return this.account.endsWith(':password') ? 'saved' : null;
    }
  },
}));

import { getSecrets } from '../src/main/keychain';

beforeEach(() => { mock.reads = []; mock.failure = null; });

describe('Keychain secret retrieval', () => {
  it('reads only requested fields and preserves missing values', () => {
    expect(getSecrets('a', ['password'])).toEqual({ password: 'saved' });
    expect(mock.reads).toEqual(['a:password']);
    expect(getSecrets('a', ['accessToken'])).toEqual({});
    expect(mock.reads).toEqual(['a:password', 'a:accessToken']);
  });

  it('surfaces Keychain access errors instead of treating them as missing secrets', () => {
    mock.failure = new Error('Keychain access denied');
    expect(() => getSecrets('a', ['password'])).toThrow('Keychain access denied');
  });
});
