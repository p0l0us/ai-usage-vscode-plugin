import { createHash, randomBytes } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Where the service keeps everything: saved profiles with their logins, its configuration, per-account
 * readings, the log and the socket clients connect to. `AI_USAGE_HOME` overrides the default `~/.ai-usage`.
 * Kept short on purpose: Unix socket paths are limited to about 100 characters.
 */
export function serviceHome(): string {
  const configured = process.env.AI_USAGE_HOME?.trim();
  return path.resolve(configured || path.join(os.homedir(), '.ai-usage'));
}

/** Creates the home (mode 0700) and returns it. */
export function ensureServiceHome(home = serviceHome()): string {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    try { fs.chmodSync(home, 0o700); } catch { /* A file system without modes. */ }
  }
  return home;
}

export const profilesFile = (home = serviceHome()): string => path.join(home, 'profiles.json');
export const configFile = (home = serviceHome()): string => path.join(home, 'config.json');
export const tokenFile = (home = serviceHome()): string => path.join(home, 'service.token');
/** Written by a running daemon: its pid, version and socket, so clients and `service status` can find it. */
export const infoFile = (home = serviceHome()): string => path.join(home, 'service.json');
export const logFile = (home = serviceHome()): string => path.join(home, 'service.log');
/** Per-account readings, sweep records, lock files and the endpoint call ledgers. */
export const stateDir = (home = serviceHome()): string => path.join(home, 'state');
/** Where the extension installs the service package and the `ai-usage` launcher. */
export const installDir = (home = serviceHome()): string => path.join(home, 'service');
export const launcherDir = (home = serviceHome()): string => path.join(home, 'bin');

/** Unix socket paths are limited to about 104 bytes; longer ones fail with EINVAL. */
const MAX_SOCKET_PATH_BYTES = 100;

/**
 * Unix socket in the home, or a named pipe on Windows whose name is derived from the home. A home whose path is
 * too long for a socket gets one in the runtime directory instead, named after the home so clients find it.
 */
export function socketPath(home = serviceHome()): string {
  const hash = createHash('sha1').update(process.platform === 'win32' ? home.toLowerCase() : home).digest('hex').slice(0, 12);
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\ai-usage-${hash}`;
  }
  const inHome = path.join(home, 'service.sock');
  if (Buffer.byteLength(inHome) <= MAX_SOCKET_PATH_BYTES) { return inHome; }
  return path.join(process.env.XDG_RUNTIME_DIR || os.tmpdir(), `ai-usage-${hash}.sock`);
}

/**
 * Shared secret every client presents first. On POSIX the socket already lives in a mode-0700 directory; on
 * Windows a named pipe is reachable by other local users, so the token (mode 0600) is what limits access.
 */
export function readOrCreateToken(home = serviceHome()): string {
  const file = tokenFile(home);
  try {
    const token = fs.readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f]{64}$/.test(token)) { return token; }
  } catch { /* Not created yet. */ }
  ensureServiceHome(home);
  const token = randomBytes(32).toString('hex');
  fs.writeFileSync(file, token, { mode: 0o600 });
  return token;
}

export function readToken(home = serviceHome()): string | undefined {
  try {
    const token = fs.readFileSync(tokenFile(home), 'utf8').trim();
    return /^[0-9a-f]{64}$/.test(token) ? token : undefined;
  } catch { return undefined; }
}

/** `embedded`: hosted inside a VS Code window rather than as its own background process. */
export type ServiceInfoFile = { pid: number; version: string; startedAt: string; socket: string; node: string; home: string; embedded?: boolean };

export function readServiceInfo(home = serviceHome()): ServiceInfoFile | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(infoFile(home), 'utf8')) as Partial<ServiceInfoFile>;
    return typeof parsed.pid === 'number' && typeof parsed.socket === 'string' ? parsed as ServiceInfoFile : undefined;
  } catch { return undefined; }
}

/** True when a process with that pid exists; a process of another user counts as alive too. */
export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) { return false; }
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}
