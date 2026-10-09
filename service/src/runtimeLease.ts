import { createHash, randomUUID } from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

/**
 * Ownership of a service home: exactly one engine (background daemon or VS Code-hosted) runs per home. The lease is
 * taken before the engine touches anything in the home and released last, after the engine stopped writing.
 *
 * Linux uses an abstract Unix socket and Windows a named pipe, both released by the OS when the owner exits, crashes
 * included. Other platforms use an exclusive deterministic loopback TCP listener, also released on crash. Another
 * local user squatting the endpoint only keeps the engine from starting; it never yields a second engine.
 */

export type LeaseKind = 'os' | 'tcp';

export type EngineLease = {
  readonly kind: LeaseKind;
  /** Random per acquisition; written to the info file so clients can tell one engine run from the next. */
  readonly instanceId: string;
  /** The home's real path the lease is named after. */
  readonly home: string;
  /** False once released or lost. */
  held(): boolean;
  /** Throws when the lease is no longer held; called before every write that only the owner may make. */
  assertHeld(): void;
  release(): void;
  /** Called once if the OS listener closes unexpectedly while this process still runs. */
  onLost(listener: () => void): void;
};

export class LeaseLostError extends Error {
  readonly code = 'lease-lost';
  constructor(home: string) { super(`this process no longer owns the account service home ${home}`); }
}

/** Default kind on this platform. */
export function defaultLeaseKind(): LeaseKind {
  return process.platform === 'linux' || process.platform === 'win32' ? 'os' : 'tcp';
}

/**
 * The home's real path, so two spellings of one directory share one lease. A home that does not exist yet is
 * resolved through its nearest existing ancestor (which may be a symlink) with the missing part appended; any
 * other resolution error throws rather than naming a lease that another spelling would not find.
 */
export function canonicalHome(home: string): string {
  let existing = path.resolve(home);
  const missing: string[] = [];
  for (;;) {
    try { return path.join(fs.realpathSync.native(existing), ...missing.reverse()); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const parent = path.dirname(existing);
      if ((code !== 'ENOENT' && code !== 'ENOTDIR') || parent === existing) { throw error; }
      missing.push(path.basename(existing));
      existing = parent;
    }
  }
}

function userKey(): string {
  if (typeof process.getuid === 'function') { return `uid:${process.getuid()}`; }
  // Windows: the account name; a fixed key when it cannot be read keeps every process of this user on one lease.
  try { return `user:${os.userInfo().username.toLowerCase()}`; } catch { return 'user:unknown'; }
}

/** The OS endpoint name of a home's lease; independent of the home's socket path. */
export function leaseEndpoint(home: string): string {
  const key = process.platform === 'win32' ? canonicalHome(home).toLowerCase() : canonicalHome(home);
  const name = 'ai-usage-engine-' + createHash('sha256').update(`${userKey()}\0${key}`).digest('hex').slice(0, 32);
  return process.platform === 'win32' ? `\\\\.\\pipe\\${name}` : `\0${name}`;
}

/** A fixed user/home port: collisions deny startup instead of permitting another engine on an alternate port. */
export function tcpLeasePort(home: string): number {
  const key = process.platform === 'win32' ? canonicalHome(home).toLowerCase() : canonicalHome(home);
  const digest = createHash('sha256').update(`${userKey()}\0${key}`).digest('hex');
  return 49152 + Number(BigInt(`0x${digest}`) % 16384n);
}

/** Takes the lease, or returns undefined for an occupied/denied endpoint. TCP may be forced on any platform. */
export async function acquireEngineLease(home: string, options: { kind?: LeaseKind } = {}): Promise<EngineLease | undefined> {
  const kind = options.kind ?? defaultLeaseKind();
  const real = canonicalHome(home);
  if (kind === 'os') {
    if (process.platform !== 'linux' && process.platform !== 'win32') { throw new Error('OS-owned leases need Linux or Windows.'); }
    return acquireListenerLease('os', real, leaseEndpoint(real));
  }
  return acquireListenerLease('tcp', real, { host: '127.0.0.1', port: tcpLeasePort(real), exclusive: true });
}

type LeaseState = { held: boolean; listeners: Array<() => void> };

function makeLease(kind: LeaseKind, home: string, instanceId: string, state: LeaseState, release: () => void): EngineLease {
  return {
    kind, instanceId, home,
    held: () => state.held,
    assertHeld: () => { if (!state.held) { throw new LeaseLostError(home); } },
    release: () => { if (!state.held) { return; } state.held = false; state.listeners = []; release(); },
    onLost: (listener) => { state.listeners.push(listener); }
  };
}

function lost(state: LeaseState): void {
  if (!state.held) { return; }
  state.held = false;
  const listeners = state.listeners;
  state.listeners = [];
  for (const listener of listeners) { try { listener(); } catch { /* A listener must not keep the others from running. */ } }
}

function acquireListenerLease(kind: LeaseKind, home: string, endpoint: string | net.ListenOptions): Promise<EngineLease | undefined> {
  return new Promise((resolve, reject) => {
    // The lease endpoint answers nothing: it exists only to be held. Connections are dropped at once.
    const server = net.createServer((socket) => socket.destroy());
    const onError = (error: NodeJS.ErrnoException) => {
      server.close();
      if (error.code === 'EADDRINUSE' || error.code === 'EACCES') { resolve(undefined); } else { reject(error); }
    };
    server.once('error', onError);
    server.listen(endpoint, () => {
      server.off('error', onError);
      server.unref();
      const state: LeaseState = { held: true, listeners: [] };
      server.on('error', () => lost(state));
      server.on('close', () => lost(state));
      resolve(makeLease(kind, home, randomUUID(), state, () => server.close()));
    });
  });
}

/**
 * Observes ownership without acquiring it. Only a certain refused connection means a TCP lease is free;
 * timeouts and all other errors fail closed. The OS endpoint additionally permits ENOENT for an absent pipe.
 */
export async function leaseHeld(home: string, options: { kind?: LeaseKind } = {}): Promise<boolean> {
  const kind = options.kind ?? defaultLeaseKind();
  const real = canonicalHome(home);
  return new Promise((resolve) => {
    const socket = kind === 'tcp'
      ? net.connect({ host: '127.0.0.1', port: tcpLeasePort(real) })
      : net.connect(leaseEndpoint(real));
    const done = (held: boolean) => { socket.destroy(); resolve(held); };
    socket.setTimeout(1_000, () => done(true));
    socket.once('connect', () => done(true));
    socket.once('error', (error: NodeJS.ErrnoException) => done(!(error.code === 'ECONNREFUSED' || (kind === 'os' && error.code === 'ENOENT'))));
  });
}
