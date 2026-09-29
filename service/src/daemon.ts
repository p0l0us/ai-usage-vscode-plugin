import * as fs from 'fs';
import { AccountService } from './accountService';
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

/**
 * Runs the account service until it is told to stop: by a signal, or by a client's `service.shutdown`. Exactly
 * one daemon runs per service home; a second one finds the first through the socket and exits.
 */
export async function runDaemon(options: DaemonOptions): Promise<void> {
  const home = ensureServiceHome(options.home);
  fs.mkdirSync(stateDir(home), { recursive: true, mode: 0o700 });
  const version = options.version ?? serviceVersion();
  const already = await pingService(home);
  if (already) { throw new Error(`the account service is already running (pid ${already.pid}, version ${already.version})`); }
  const logger = new Logger(logFile(home));
  if (options.foreground) { logger.onLine((line) => process.stderr.write(`${line}\n`)); }
  const token = readOrCreateToken(home);
  const service = new AccountService({ home, version, log: (message) => logger.log(message) });
  let stopping: Promise<void> | undefined;
  const socket = socketPath(home);
  const server = new RpcServer({
    socketPath: socket,
    token,
    log: (message) => logger.log(message),
    onHello: (connection): HelloResult => {
      logger.log(`client connected: ${connection.client}${connection.version ? ` ${connection.version}` : ''} (#${connection.id})`);
      return { ok: true, service: { ...service.info(), socket } };
    },
    onDisconnect: (connection) => logger.log(`client disconnected: ${connection.client} (#${connection.id})`),
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
      return service.handle(method, params);
    }
  });
  service.clientCount = () => server.clientCount;
  service.events.on('event', (event) => server.broadcast(event));
  logger.onLine((line) => server.broadcast({ event: 'log', line }));
  await server.listen();
  fs.writeFileSync(infoFile(home), JSON.stringify({ pid: process.pid, version, startedAt: service.startedAt.toISOString(), socket, node: process.execPath, home }, null, 2), { mode: 0o600 });
  logger.log(`account service ${version} started (pid ${process.pid}, node ${process.version}, home ${home})`);
  service.start();

  const stopped = new Promise<void>((resolve) => {
    stop = async () => {
      if (stopping) { return stopping; }
      stopping = (async () => {
        logger.log('account service stopping');
        service.dispose();
        await server.close();
        try { fs.unlinkSync(infoFile(home)); } catch { /* Already gone. */ }
        resolve();
      })();
      return stopping;
    };
  });
  const onSignal = (signal: NodeJS.Signals) => { logger.log(`received ${signal}`); void stop(); };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  if (process.platform === 'win32') { process.once('SIGBREAK' as NodeJS.Signals, onSignal); }
  await stopped;
}

let stop: () => Promise<void> = async () => undefined;
