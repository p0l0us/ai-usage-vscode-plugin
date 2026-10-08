import * as os from 'os';
import * as path from 'path';
import * as net from 'net';
import { createHash } from 'crypto';
import { acquireAccountLock } from './accountProbe';
export type ProxyLease = { release(): void };
/** Independent of HOME/CODEX_HOME/AI_USAGE_HOME overrides on platforms with OS-owned leases. */
export function proxyLeaseNamespace(): string {
  return process.platform === 'linux' || process.platform === 'win32'
    ? `os-user:${process.getuid?.() ?? os.userInfo().username}` : path.join(os.homedir(), '.ai-usage-codex-proxy.lock');
}
/** Linux abstract sockets and Windows pipes are released by the OS on process exit, including crashes. */
export async function acquireProxyLease(namespace: string): Promise<ProxyLease | undefined> {
  if (process.platform !== 'linux' && process.platform !== 'win32') return acquireAccountLock(namespace, Infinity);
  const name = 'ai-usage-codex-proxy-' + createHash('sha256').update(namespace).digest('hex').slice(0, 32);
  const endpoint = process.platform === 'linux' ? '\0' + name : '\\\\.\\pipe\\' + name;
  return new Promise((resolve, reject) => {
    const server = net.createServer(socket => socket.destroy());
    server.once('error', error => { server.close(); if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') resolve(undefined); else reject(error); });
    server.listen(endpoint, () => { server.unref(); resolve({ release: () => server.close() }); });
  });
}
