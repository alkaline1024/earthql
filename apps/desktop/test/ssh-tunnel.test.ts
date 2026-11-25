import { afterEach, describe, expect, it } from 'vitest';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createConnection, createServer, type Server as TcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { Server, utils } from 'ssh2';
import type { PostgresProfile } from '@earthql/core';
import { openSshTunnel } from '../src/main/ssh-tunnel';

const toolsAvailable = ['/usr/bin/ssh-agent', '/usr/bin/ssh-add', '/usr/bin/ssh-keygen'].every(existsSync);
const originalAgent = process.env.SSH_AUTH_SOCK;
afterEach(() => {
  if (originalAgent === undefined) delete process.env.SSH_AUTH_SOCK;
  else process.env.SSH_AUTH_SOCK = originalAgent;
});

describe('SSH tunnel', () => {
  it('rejects when the SSH server closes before authentication', async () => {
    const server = createServer((socket) => socket.destroy());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('No SSH port.');
      process.env.SSH_AUTH_SOCK = '/unused-agent';
      const profile: PostgresProfile = { id: 'p', name: 'p', driver: 'postgres', host: 'db', port: 5432, database: 'db', user: 'db',
        tls: { mode: 'disable' }, env: { name: 'Local', color: '#888' }, createdAt: 0, updatedAt: 0,
        ssh: { host: '127.0.0.1', port: address.port, user: 'user', hostKeyFingerprint: `SHA256:${'a'.repeat(43)}` } };
      await expect(openSshTunnel(profile)).rejects.toMatchObject({ category: 'network' });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }, 5000);

  it('rejects invalid fingerprints and unsupported MySQL verification before connecting', async () => {
    const profile: PostgresProfile = { id: 'p', name: 'p', driver: 'postgres', host: 'db', port: 5432, database: 'db', user: 'db',
      tls: { mode: 'disable' }, env: { name: 'Local', color: '#888' }, createdAt: 0, updatedAt: 0,
      ssh: { host: 'localhost', port: 22, user: 'user', hostKeyFingerprint: 'bad' } };
    await expect(openSshTunnel(profile)).rejects.toMatchObject({ category: 'config' });
    await expect(openSshTunnel({ ...profile, driver: 'mysql', tls: { mode: 'verify' },
      ssh: { ...profile.ssh!, hostKeyFingerprint: `SHA256:${'a'.repeat(43)}` } })).rejects.toMatchObject({ category: 'unsupported' });
  });

  it.skipIf(!toolsAvailable)('forwards a connection with an agent and rejects a different host key', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'earthql-ssh-test-'));
    const socketPath = join(dir, 'agent.sock');
    let agent: ChildProcess | undefined;
    let sshServer: Server | undefined;
    let database: TcpServer | undefined;
    try {
      execFileSync('/usr/bin/ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(dir, 'identity')]);
      agent = spawn('/usr/bin/ssh-agent', ['-D', '-a', socketPath], { stdio: 'ignore' });
      for (let i = 0; i < 100 && !existsSync(socketPath); i++) await new Promise((resolve) => setTimeout(resolve, 20));
      if (!existsSync(socketPath)) throw new Error('Test SSH agent did not start.');
      process.env.SSH_AUTH_SOCK = socketPath;
      execFileSync('/usr/bin/ssh-add', [join(dir, 'identity')], { env: process.env, stdio: 'ignore' });
      database = createServer((socket) => socket.pipe(socket));
      await new Promise<void>((resolve) => database!.listen(0, '127.0.0.1', resolve));
      const databaseAddress = database.address();
      if (!databaseAddress || typeof databaseAddress === 'string') throw new Error('No database port.');
      const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
      const parsed = utils.parseKey(privateKey);
      if (parsed instanceof Error || Array.isArray(parsed)) throw new Error('Invalid test host key.');
      const fingerprint = `SHA256:${createHash('sha256').update(parsed.getPublicSSH()).digest('base64').replace(/=+$/, '')}`;
      sshServer = new Server({ hostKeys: [privateKey] }, (client) => {
        client.on('error', () => undefined);
        client.on('authentication', (context) => context.method === 'publickey' ? context.accept() : context.reject());
        client.on('ready', () => client.on('tcpip', (accept, reject, info) => {
          if (info.destPort !== databaseAddress.port) { reject(); return; }
          const stream = accept();
          const target = createConnection({ host: '127.0.0.1', port: databaseAddress.port });
          target.on('error', () => stream.destroy());
          stream.on('error', () => target.destroy());
          stream.pipe(target).pipe(stream);
        }));
      });
      await new Promise<void>((resolve) => sshServer!.listen(0, '127.0.0.1', resolve));
      const address = sshServer.address();
      if (!address || typeof address === 'string') throw new Error('No SSH port.');
      const profile: PostgresProfile = { id: 'p', name: 'p', driver: 'postgres', host: '127.0.0.1', port: databaseAddress.port,
        database: 'db', user: 'db', tls: { mode: 'disable' }, env: { name: 'Local', color: '#888' }, createdAt: 0, updatedAt: 0,
        ssh: { host: '127.0.0.1', port: address.port, user: 'tester', hostKeyFingerprint: fingerprint } };
      const tunnel = await openSshTunnel(profile);
      const data = await new Promise<string>((resolve, reject) => {
        const client = createConnection({ host: '127.0.0.1', port: tunnel.port }, () => client.write('hello'));
        client.on('data', (chunk) => { resolve(chunk.toString()); client.destroy(); });
        client.on('error', reject);
      });
      expect(data).toBe('hello');
      await tunnel.close();
      await expect(openSshTunnel({ ...profile, ssh: { ...profile.ssh!, hostKeyFingerprint: `SHA256:${'a'.repeat(43)}` } })).rejects.toMatchObject({ category: 'network' });
    } finally {
      sshServer?.close();
      database?.close();
      if (agent?.pid) agent.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});
