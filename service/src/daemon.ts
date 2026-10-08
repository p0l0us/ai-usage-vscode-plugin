import * as fs from 'fs';
import { AccountService } from './accountService';
import type { PrivateProfileBackend } from './profileStore';
import { Logger } from './logger';
import { ensureServiceHome, infoFile, logFile, readOrCreateToken, socketPath, stateDir } from './paths';
import { RpcServer } from './rpc';
import { pingService } from './client';
import type { HelloResult } from './protocol';
import { serviceVersion } from './version';

export type DaemonOptions = {
  home: string;
  version?: string;
  /** Also print log lines to stderr, for `ai-usage service run`. */
  foreground?: boolean;
};

export type HostOptions = {
  home: string;
  initialConfig?: Record<string, unknown>;
  version?: string;
  /**
   * Hosted inside another program (the VS Code extension host) instead of its own process: it serves the same
   * socket while that program runs, nothing is installed, and the info file says so.
   */
  embedded?: boolean;
  /** Told every log line, besides the service log file. */
  onLog?: (line: string) => void;
  /** Where the private profiles are kept; profiles.json in the home by default. */
  privateProfiles?: PrivateProfileBackend;
};

/** A running account service: its core, and how to stop it. */
export type ServiceHost = {
  readonly service: AccountService;
  readonly socket: string;
  /** Writes a line to the service log, which every connected client also receives. */
  log(message: string): void;
  /** Stops the timers, closes every connection and removes the socket and info file. */
  stop(): Promise<void>;
  /** Resolves once stopped, by `stop` or by a client's `service.shutdown`. */
  readonly stopped: Promise<void>;
};

/**
 * Starts the account service in this process and serves it on the home's socket. Exactly one host serves a home:
 * when another daemon or embedded host already answers, this throws and the caller connects to that one instead.
 */
export async function startServiceHost(options: HostOptions): Promise<ServiceHost> {
  const home = ensureServiceHome(options.home);
  fs.mkdirSync(stateDir(home), { recursive: true, mode: 0o700 });
  const version = options.version ?? serviceVersion();
  const already = await pingService(home);
  if (already) { throw new Error(`the account service is already running (pid ${already.pid}, version ${already.version})`); }
  const logger = new Logger(logFile(home));
  if (options.onLog) { logger.onLine(options.onLog); }
  const token = readOrCreateToken(home);
  const service = new AccountService({ home, version, log: (message) => logger.log(message), privateProfiles: options.privateProfiles, initialConfig: options.initialConfig });
  let stopping: Promise<void> | undefined;
  let resolveStopped: () => void = () => undefined;
  const stopped = new Promise<void>((resolve) => { resolveStopped = resolve; });
  const socket = socketPath(home);
  const stop = (): Promise<void> => {
    if (stopping) { return stopping; }
    stopping = (async () => {
      logger.log('account service stopping');
      service.dispose();
      await server.close();
      try { fs.unlinkSync(infoFile(home)); } catch { /* Already gone. */ }
      resolveStopped();
    })();
    return stopping;
  };
  const server = new RpcServer({
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
    handle: async (method, params, connection) => {
      if (method === 'service.shutdown') {
        logger.log(`shutdown requested by ${connection.client} (#${connection.id})`);
        setTimeout(() => void stop(), 50);
        return { ok: true };
      }
      if (method === 'log.tail') {
        const lines = typeof (params as { lines?: unknown })?.lines === 'number' ? (params as { lines: number }).lines : 100;
        return Logger.tail(logFile(home), lines);
      }
      return service.handle(method, params, connection.id);
    }
  });
  service.clientCount = () => server.clientCount;
  service.events.on('event', (event) => server.broadcast(event));
  logger.onLine((line) => server.broadcast({ event: 'log', line }));
  await server.listen();
  fs.writeFileSync(infoFile(home), JSON.stringify({ pid: process.pid, version, startedAt: service.startedAt.toISOString(), socket, node: process.execPath, home,
    ...(options.embedded ? { embedded: true } : {}) }, null, 2), { mode: 0o600 });
  logger.log(`account service ${version} started ${options.embedded ? 'inside VS Code ' : ''}(pid ${process.pid}, node ${process.version}, home ${home})`);
  service.start();
  return { service, socket, log: (message) => logger.log(message), stop, stopped };
}

/**
 * Runs the account service as its own process until it is told to stop: by a signal, or by a client's
 * `service.shutdown`. Exactly one host runs per service home; a second one finds the first through the socket and exits.
 */
export async function runDaemon(options: DaemonOptions): Promise<void> {
  const host = await startServiceHost({ home: options.home, version: options.version,
    onLog: options.foreground ? (line) => process.stderr.write(`${line}\n`) : undefined });
  const onSignal = (signal: NodeJS.Signals) => { host.log(`received ${signal}`); void host.stop(); };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  if (process.platform === 'win32') { process.once('SIGBREAK' as NodeJS.Signals, onSignal); }
  await host.stopped;
}
