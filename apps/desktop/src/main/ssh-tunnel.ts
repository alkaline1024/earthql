import { createHash } from 'node:crypto';
import { createServer, type Socket } from 'node:net';
import { Client } from 'ssh2';
import { makeError, type ConnectionProfile } from '@earthql/core';

export interface SshTunnel {
  port: number;
  close(): Promise<void>;
}

export async function openSshTunnel(profile: ConnectionProfile): Promise<SshTunnel> {
  if (profile.driver === 'databricks' || !profile.ssh) throw makeError('config', 'SSH tunneling is unavailable for this connection.');
  const { host, port, user, hostKeyFingerprint } = profile.ssh;
  if (!host.trim() || !user.trim() || !Number.isInteger(port) || port < 1 || port > 65535 ||
      !/^SHA256:[A-Za-z0-9+/]{43}=?$/.test(hostKeyFingerprint)) {
    throw makeError('config', 'Enter a valid SSH host, port, user and SHA256 host-key fingerprint.');
  }
  if (profile.driver === 'mysql' && profile.tls.mode === 'verify') {
    throw makeError('unsupported', 'MySQL certificate verification through an SSH tunnel is not supported. Use a direct connection or another TLS mode.');
  }
  const agent = process.env.SSH_AUTH_SOCK;
  if (!agent) throw makeError('config', 'SSH_AUTH_SOCK is not available. Start an SSH agent and add your key before starting EarthQL.');
  const ssh = new Client();
  const databasePort = profile.port || (profile.driver === 'postgres' ? 5432 : profile.driver === 'mysql' ? 3306 : 1433);
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => { socket.destroy(); });
    socket.on('close', () => sockets.delete(socket));
    ssh.forwardOut('127.0.0.1', socket.remotePort ?? 0, profile.host, databasePort, (error, stream) => {
      if (error) { socket.destroy(error); return; }
      stream.on('error', (failure: Error) => socket.destroy(failure));
      socket.pipe(stream).pipe(socket);
      socket.on('close', () => stream.destroy());
    });
  });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    for (const socket of sockets) socket.destroy();
    ssh.end();
    if (server.listening) await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  };
  ssh.on('error', (error) => { console.error('SSH tunnel error.', error); });
  ssh.on('close', () => { void close().catch((error) => console.error('SSH tunnel cleanup failed.', error)); });
  try {
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        ssh.off('ready', ready);
        ssh.off('error', failed);
        ssh.off('close', closedEarly);
      };
      const ready = () => { cleanup(); resolve(); };
      const failed = (error: Error) => { cleanup(); reject(error); };
      const closedEarly = () => { cleanup(); reject(makeError('network', 'SSH connection closed before the tunnel was ready.')); };
      ssh.once('ready', ready);
      ssh.once('error', failed);
      ssh.once('close', closedEarly);
      ssh.connect({
        host: host.trim(), port, username: user.trim(), agent, readyTimeout: 20000,
        hostVerifier: (key: Buffer) => `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}` === hostKeyFingerprint.replace(/=+$/, ''),
      });
      if (closed) throw makeError('network', 'SSH connection closed before the tunnel was ready.');
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
    server.on('error', (error) => { console.error('SSH tunnel listener failed.', error); void close().catch((failure) => console.error('SSH tunnel cleanup failed.', failure)); });
    if (closed) {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      throw makeError('network', 'SSH connection closed before the tunnel was ready.');
    }
    const address = server.address();
    if (!address || typeof address === 'string') throw makeError('network', 'SSH tunnel could not open a local listener.');
    return { port: address.port, close };
  } catch (error) {
    await close();
    throw makeError('network', `SSH tunnel failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
