import * as fs from 'fs';
import { AccountService, AccountServiceOptions, HostIdentity } from './accountService';
import type { PrivateProfileBackend } from './profileStore';
import { Logger } from './logger';
import { ServiceInfoFile, ensureServiceHome, infoFile, logFile, readOrCreateToken, readServiceInfo, readToken, socketPath, stateDir } from './paths';
import { RpcClient, RpcServer } from './rpc';
import { SERVICE_CAPABILITIES, SERVICE_PROTOCOL_VERSION } from './protocol';
import type { HelloResult, ServiceInfo } from './protocol';
import { serviceVersion } from './version';
import { EngineLease, LeaseKind, acquireEngineLease, leaseHeld, defaultLeaseKind, tcpLeasePort } from './runtimeLease';

/**
 * The one way an account service engine runs, whether as the background daemon or inside a VS Code window: take the
 * home's ownership lease, then create the token, load the configuration, construct the engine and serve it on the
 * home's socket to authenticated clients. Lifecycle (`service.status`, `service.shutdown`) and the log
 * (`log.tail`, `log` events) are answered here, identically in both modes.
 */

export type HostMode = 'background' | 'embedded';

export type HostOptions = {
  home: string;
  version?: string;
  /** `background`: its own process (`ai-usage service run`); `embedded`: inside another program, such as VS Code. */
  mode?: HostMode;
  /** @deprecated `mode: 'embedded'`. */
  embedded?: boolean;
  /** Told every log line, besides the service log file. */
  onLog?: (line: string) => void;
  /** Where the private profiles are kept; profiles.json in the home by default. */
  privateProfiles?: PrivateProfileBackend;
  /** First values for settings config.json does not have yet (a first run). Existing settings are never replaced. */
  seedConfig?: Record<string, unknown>;
  /** @deprecated Same seed-only meaning as `seedConfig`. */
  initialConfig?: Record<string, unknown>;
  /** Lease kind; the platform default unless a test forces the lock file. */
  leaseKind?: LeaseKind;
  /** How long to wait for a lease holder to answer before reporting it unreachable. */
  ownerWaitMs?: number;
  /** Test fixtures in place of provider calls; applied after the lease, and unable to replace the home, log, version or lease. */
  engineOptions?: EngineTestOptions;
};

export type EngineTestOptions = Partial<Pick<AccountServiceOptions, 'fetchUsage' | 'usageIdentity' | 'now' | 'probe' | 'reset' | 'identityOf' | 'verifyCodex' | 'syncClaudeMetadata'>>;

export type StopInfo = { by: 'host' | 'client' | 'signal' | 'lease-lost'; client?: string; reason?: string };

/** A running account service: its engine, and how to stop it. */
export type ServiceHost = {
  readonly service: AccountService;
  readonly socket: string;
  readonly mode: HostMode;
  readonly instanceId: string;
  /** Writes a line to the service log, which every connected client also receives. */
  log(message: string): void;
  /**
   * Closes every connection, drains the engine's admitted work, waits for the bridge to exit, removes the info file,
   * then releases the lease. Rejects, keeping the lease, when that could not be proven; it may be called again.
   */
  stop(reason?: string): Promise<void>;
  /** Resolves once stopped: by `stop`, a client's `service.shutdown`, a signal, or a lost lease. */
  readonly stopped: Promise<StopInfo>;
};

export type EngineOwnedReason = 'owner-running' | 'owner-unreachable';

/**
 * Another process owns the home. `owner-running`: it answers; connect to it. `owner-unreachable`: it holds the lease
 * but does not answer on the socket; nothing may host this home until it exits, so callers report and retry.
 */
export class EngineOwnedError extends Error {
  constructor(message: string, readonly code: EngineOwnedReason, readonly owner?: ServiceInfoFile, readonly info?: ServiceInfo) { super(message); }
}

/** The shared contract's capabilities (protocol.ts); the host serves every one of them. */
export const HOST_CAPABILITIES: string[] = [...SERVICE_CAPABILITIES];

/** Says hello on `socket` with the home's token; the service's info, or undefined when nothing valid answers. */
async function helloAt(home: string, socket: string, timeoutMs: number): Promise<ServiceInfo | undefined> {
  const token = readToken(home);
  if (!token) { return undefined; }
  try {
    // Read-only discovery that also recognizes a service from before the shared protocol, so it is never hosted over.
    const { client, hello } = await RpcClient.connect({ socketPath: socket, token, client: 'host-probe', timeoutMs, allowLegacyHello: true });
    client.close();
    return (hello as HelloResult).service;
  } catch { return undefined; }
}

/** Asks whoever answers on the home's socket, or on the socket the info file names. */
async function answeringOwner(home: string, timeoutMs: number): Promise<ServiceInfo | undefined> {
  const sockets = [socketPath(home), readServiceInfo(home)?.socket].filter((socket, index, all): socket is string => Boolean(socket) && all.indexOf(socket) === index);
  for (const socket of sockets) {
    const info = await helloAt(home, socket, timeoutMs);
    if (info) { return info; }
  }
  return undefined;
}

async function waitForOwner(home: string, waitMs: number): Promise<ServiceInfo | undefined> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const info = await answeringOwner(home, Math.min(2_000, Math.max(250, deadline - Date.now())));
    if (info || Date.now() >= deadline) { return info; }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

export type EngineProbe = { state: 'free' } | { state: 'running'; info: ServiceInfo } | { state: 'unreachable'; owner?: ServiceInfoFile };

/**
 * Whether an engine owns the home, without starting one: `free` (nobody; the caller may host), `running` (connect),
 * or `unreachable` (the lease is held but nothing answers: do not host). Advisory: hosting itself re-checks.
 */
export async function probeEngine(home: string, options: { leaseKind?: LeaseKind; timeoutMs?: number } = {}): Promise<EngineProbe> {
  const info = await answeringOwner(home, options.timeoutMs ?? 2_000);
  if (info) { return { state: 'running', info }; }
  if (!await leaseHeld(home, { kind: options.leaseKind })) { return { state: 'free' }; }
  return { state: 'unreachable', owner: readServiceInfo(home) };
}

/**
 * Starts the engine in this process and serves it on the home's socket. Exactly one host serves a home: when another
 * one owns it, this throws `EngineOwnedError` before anything in the home was changed.
 */
export async function startServiceHost(options: HostOptions): Promise<ServiceHost> {
  const home = ensureServiceHome(options.home);
  const mode: HostMode = options.mode ?? (options.embedded ? 'embedded' : 'background');
  const version = options.version ?? serviceVersion();
  const lease = await acquireEngineLease(home, { kind: options.leaseKind });
  if (!lease) {
    // The owner may be starting right now: give it a moment to answer before calling it unreachable.
    const info = await waitForOwner(home, options.ownerWaitMs ?? 3_000);
    if (info) { throw new EngineOwnedError(`the account service is already running (pid ${info.pid}, version ${info.version})`, 'owner-running', readServiceInfo(home), info); }
    const owner = readServiceInfo(home);
    const endpoint = (options.leaseKind ?? defaultLeaseKind()) === 'tcp' ? ` (TCP lease 127.0.0.1:${tcpLeasePort(home)} is occupied or unavailable)` : '';
    throw new EngineOwnedError(`the account service home ${home}${endpoint} is owned by another process${owner ? ` (pid ${owner.pid})` : ''} that does not answer on its socket; `
      + 'not starting a second service. Stop that process, or wait for it to exit.', 'owner-unreachable', owner);
  }
  try {
    return await hostWithLease(home, mode, version, lease, options);
  } catch (error) {
    lease.release();
    throw error;
  }
}

async function hostWithLease(home: string, mode: HostMode, version: string, lease: EngineLease, options: HostOptions): Promise<ServiceHost> {
  // A service from before the lease does not hold it; when one answers, it owns the home and this host steps back.
  const legacy = await answeringOwner(home, 1_500);
  if (legacy) {
    throw new EngineOwnedError(`the account service is already running (pid ${legacy.pid}, version ${legacy.version})`, 'owner-running', readServiceInfo(home), legacy);
  }
  fs.mkdirSync(stateDir(home), { recursive: true, mode: 0o700 });
  const logger = new Logger(logFile(home));
  if (options.onLog) { logger.onLine(options.onLog); }
  const token = readOrCreateToken(home);
  const identity: HostIdentity = { mode, instanceId: lease.instanceId, protocol: SERVICE_PROTOCOL_VERSION, capabilities: HOST_CAPABILITIES, lease: lease.kind };
  const fixtures: EngineTestOptions = {};
  for (const key of ['fetchUsage', 'usageIdentity', 'now', 'probe', 'reset', 'identityOf', 'verifyCodex', 'syncClaudeMetadata'] as const) {
    if (options.engineOptions?.[key] !== undefined) { (fixtures as Record<string, unknown>)[key] = options.engineOptions[key]; }
  }
  const service = new AccountService({ ...fixtures, home, version, log: (message) => logger.log(message), privateProfiles: options.privateProfiles,
    seedConfig: { ...(options.initialConfig ?? {}), ...(options.seedConfig ?? {}) }, ownership: lease });
  service.hostIdentity = identity;
  const socket = socketPath(home);
  let stopping: Promise<void> | undefined;
  let serverClosed = false;
  let resolveStopped: (info: StopInfo) => void = () => undefined;
  const stopped = new Promise<StopInfo>((resolve) => { resolveStopped = resolve; });
  const stopWith = (info: StopInfo): Promise<void> => {
    if (stopping) { return stopping; }
    const attempt = (async () => {
      logger.log(`account service stopping (${info.by}${info.client ? ` ${info.client}` : ''}${info.reason ? `: ${info.reason}` : ''})`);
      // No new connections or requests; the engine then drains admitted work and waits for the bridge to exit.
      if (!serverClosed) { serverClosed = true; await server.close(); }
      try { await service.dispose(); }
      catch (error) {
        // Not proven stopped (work still running, or a bridge child that did not exit): keep the lease, so no
        // successor starts beside it. Nobody can connect meanwhile; `stop` may be called again to retry.
        const message = error instanceof Error ? error.message : String(error);
        logger.log(`account service: could not stop cleanly, keeping the ownership of ${home}: ${message}`);
        throw new Error(`the account service did not stop cleanly and still owns ${home}: ${message}`);
      }
      // The info file is ours only while the lease is; a successor may already have written its own.
      try { if (readServiceInfo(home)?.instanceId === lease.instanceId) { fs.unlinkSync(infoFile(home)); } } catch { /* Already gone. */ }
      lease.release();
      resolveStopped(info);
    })();
    stopping = attempt;
    attempt.catch(() => { if (stopping === attempt) { stopping = undefined; } });
    return attempt;
  };
  const server: RpcServer = new RpcServer({
    socketPath: socket,
    token,
    log: (message) => logger.log(message),
    onHello: (connection, params): HelloResult => {
      logger.log(`client connected: ${connection.client}${connection.version ? ` ${connection.version}` : ''} (#${connection.id})`);
      if (Array.isArray(params.folders)) { service.declareFolders(connection.id, params.folders.filter((folder): folder is string => typeof folder === 'string')); }
      return { ok: true, service: { ...service.info(), socket } };
    },
    onDisconnect: (connection) => {
      service.forgetFolders(connection.id);
      logger.log(`client disconnected: ${connection.client} (#${connection.id})`);
    },
    handle: async (method, params, connection, request?): Promise<unknown> => {
      const raw = typeof params === 'object' && params !== null ? params as Record<string, unknown> : {};
      if (method === 'service.shutdown') {
        const reason = typeof raw.reason === 'string' ? raw.reason.slice(0, 200) : undefined;
        logger.log(`shutdown requested by ${connection.client} (#${connection.id})${reason ? `: ${reason}` : ''}`);
        setTimeout(() => void stopWith({ by: 'client', client: connection.client, reason }).catch(() => undefined), 50);
        return { ok: true, mode };
      }
      if (method === 'service.status') {
        return { ...service.info(), socket, clients: server.clients().map((client) => ({ id: client.id, client: client.client, version: client.version })) };
      }
      if (method === 'service.info') { return { ...service.info(), socket }; }
      if (method === 'log.tail') {
        const lines = typeof raw.lines === 'number' && Number.isFinite(raw.lines) ? Math.max(1, Math.min(10_000, Math.floor(raw.lines))) : 100;
        return Logger.tail(logFile(home), lines);
      }
      return service.handle(method, params, connection.id, request);
    }
  });
  service.clientCount = () => server.clientCount;
  service.events.on('event', (event) => server.broadcast(event));
  logger.onLine((line) => server.broadcast({ event: 'log', line }));
  // Holding the lease, a socket file nobody answers on belongs to a dead owner and is replaced; one that still accepts
  // connections (a hung service from before the lease) makes this fail rather than serve beside it.
  try { await server.listen(); }
  catch (error) { await service.dispose().catch(() => undefined); throw error; }
  // Stopped a moment later, so the request that noticed the loss still gets its answer.
  lease.onLost(() => { logger.log('account service: lost the ownership of its home'); setTimeout(() => void stopWith({ by: 'lease-lost' }).catch(() => undefined), 50); });
  const info: ServiceInfoFile = { pid: process.pid, version, startedAt: service.startedAt.toISOString(), socket, node: process.execPath, home,
    ...(mode === 'embedded' ? { embedded: true } : {}), mode, instanceId: lease.instanceId, protocol: SERVICE_PROTOCOL_VERSION, lease: lease.kind };
  writeInfoFile(home, info);
  logger.log(`account service ${version} started ${mode === 'embedded' ? 'inside another program ' : ''}(pid ${process.pid}, node ${process.version}, home ${home}, lease ${lease.kind})`);
  try { service.start(); }
  catch (error) { await stopWith({ by: 'host', reason: error instanceof Error ? error.message : String(error) }).catch(() => undefined); throw error; }
  return { service, socket, mode, instanceId: lease.instanceId, log: (message) => logger.log(message),
    stop: (reason) => stopWith({ by: 'host', reason }), stopped };
}

function writeInfoFile(home: string, info: ServiceInfoFile): void {
  const file = infoFile(home);
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(info, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, file);
}

export type DaemonOptions = {
  home: string;
  version?: string;
  /** Also print log lines to stderr, for `ai-usage service run`. */
  foreground?: boolean;
};

/**
 * Runs the engine as its own process until told to stop: by a signal, or by a client's `service.shutdown`. When
 * another host owns the home this throws `EngineOwnedError` without changing anything.
 */
export async function runDaemon(options: DaemonOptions): Promise<StopInfo> {
  const host = await startServiceHost({ home: options.home, version: options.version, mode: 'background',
    onLog: options.foreground ? (line) => process.stderr.write(`${line}\n`) : undefined });
  let signalled: NodeJS.Signals | undefined;
  const onSignal = (signal: NodeJS.Signals) => { signalled = signal; host.log(`received ${signal}`); void host.stop(`signal ${signal}`); };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  if (process.platform === 'win32') { process.once('SIGBREAK' as NodeJS.Signals, onSignal); }
  const info = await host.stopped;
  return signalled ? { ...info, by: 'signal', reason: signalled } : info;
}
