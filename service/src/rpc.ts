import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as net from 'net';
import { SERVICE_CAPABILITIES, SERVICE_PROTOCOL_VERSION } from './protocol';
import type { RequestOptions } from './protocol';

/** Newline-delimited JSON on an authenticated local socket. Requests are never replayed. */
export type RpcRequest = { id: number; method: string; params?: unknown; deadlineAt?: number };
export type RpcResponse = { id: number; result?: unknown; error?: { message: string; code?: string; data?: unknown } };
export type RpcEvent = { event: string } & Record<string, unknown>;
export type RpcErrorCode = 'unauthorized' | 'incompatible' | 'invalid_request' | 'timeout' | 'cancelled' | 'closed' | 'conflict' | 'unknown_method' | 'invalid_params' | 'internal';

export class RpcError extends Error {
  constructor(message: string, readonly code?: string, readonly data?: unknown) { super(message); this.name = 'RpcError'; }
}

export type RpcRequestContext = { requestId: number; deadlineAt?: number; signal: AbortSignal };
export type RpcConnection = {
  readonly id: number;
  client: string;
  version?: string;
  subscriptions: Set<string> | 'all';
  send(event: RpcEvent): void;
  close(): void;
};
export type RpcServerOptions = {
  socketPath: string;
  token: string;
  handle: (method: string, params: unknown, connection: RpcConnection, context: RpcRequestContext) => Promise<unknown>;
  onHello?: (connection: RpcConnection, params: Record<string, unknown>) => unknown;
  onDisconnect?: (connection: RpcConnection) => void;
  log?: (message: string) => void;
  protocolVersion?: number;
  capabilities?: readonly string[];
};
const MAX_LINE_BYTES = 8 * 1024 * 1024;

export function lineReader(socket: net.Socket, onLine: (line: string) => void, onError: (error: Error) => void): void {
  let buffer = '';
  let failed = false;
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    if (failed) return;
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const raw = buffer.slice(0, newline);
      if (Buffer.byteLength(raw) > MAX_LINE_BYTES) { failed = true; onError(new Error('message too large')); return; }
      buffer = buffer.slice(newline + 1);
      if (raw.trim()) onLine(raw.trim());
      newline = buffer.indexOf('\n');
    }
    if (Buffer.byteLength(buffer) > MAX_LINE_BYTES) { failed = true; onError(new Error('message too large')); }
  });
}

function wireError(error: unknown): NonNullable<RpcResponse['error']> {
  const detail = error && typeof error === 'object' ? error as { code?: unknown; data?: unknown } : {};
  return { message: error instanceof Error ? error.message : String(error),
    code: typeof detail.code === 'string' ? detail.code : 'internal',
    ...(detail.data !== undefined ? { data: detail.data } : {}) };
}

export class RpcServer {
  private readonly server: net.Server;
  private readonly connections = new Map<number, RpcConnection>();
  private readonly sockets = new Set<net.Socket>();
  private nextId = 1;
  private stopping = false;
  private closing?: Promise<void>;
  private socketIdentity?: { dev: number; ino: number };
  constructor(private readonly options: RpcServerOptions) { this.server = net.createServer(socket => this.accept(socket)); }
  get clientCount(): number { return this.connections.size; }
  clients(): RpcConnection[] { return [...this.connections.values()]; }
  async listen(): Promise<void> {
    await removeStaleSocket(this.options.socketPath);
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.options.socketPath, () => { this.server.off('error', reject); resolve(); });
    });
    if (process.platform !== 'win32') {
      const stat = fs.statSync(this.options.socketPath);
      this.socketIdentity = { dev: stat.dev, ino: stat.ino };
      fs.chmodSync(this.options.socketPath, 0o600);
    }
  }
  broadcast(event: RpcEvent): void {
    for (const connection of this.connections.values()) {
      if (connection.subscriptions === 'all' || connection.subscriptions.has(event.event)) connection.send(event);
    }
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.stopping = true;
    this.broadcast({ event: 'lifecycle', state: 'stopping' });
    for (const socket of this.sockets) socket.destroy();
    this.closing = new Promise<void>(resolve => this.server.close(() => resolve())).then(() => {
      if (this.socketIdentity && process.platform !== 'win32') {
        try {
          const stat = fs.statSync(this.options.socketPath);
          if (stat.dev === this.socketIdentity.dev && stat.ino === this.socketIdentity.ino) fs.unlinkSync(this.options.socketPath);
        } catch { /* Already gone. */ }
      }
    });
    return this.closing;
  }
  private accept(socket: net.Socket): void {
    if (this.stopping) { socket.destroy(); return; }
    this.sockets.add(socket);
    const id = this.nextId++;
    let authenticated = false;
    let helloPending = false;
    const requests = new Map<number, { controller: AbortController; timer?: NodeJS.Timeout }>();
    const write = (message: RpcResponse | RpcEvent) => { if (!socket.destroyed && socket.writable) socket.write(`${JSON.stringify(message)}\n`); };
    const connection: RpcConnection = { id, client: 'unknown', subscriptions: new Set(), send: event => write(event), close: () => socket.destroy() };
    const helloTimer = setTimeout(() => socket.destroy(), 5_000);
    helloTimer.unref();
    const fail = (error: unknown, requestId = 0) => { write({ id: requestId, error: wireError(error) }); socket.end(); };
    socket.on('error', () => { /* Close handles vanished clients. */ });
    socket.on('close', () => {
      clearTimeout(helloTimer);
      this.sockets.delete(socket);
      for (const entry of requests.values()) { clearTimeout(entry.timer); entry.controller.abort(new RpcError('client disconnected', 'closed')); }
      if (authenticated) { this.connections.delete(id); this.options.onDisconnect?.(connection); }
    });
    lineReader(socket, line => {
      let request: RpcRequest;
      try { request = JSON.parse(line); } catch { fail(new RpcError('malformed request', 'invalid_request')); return; }
      if (!request || !Number.isSafeInteger(request.id) || typeof request.method !== 'string' ||
        (request.deadlineAt !== undefined && (typeof request.deadlineAt !== 'number' || !Number.isFinite(request.deadlineAt)))) {
        fail(new RpcError('malformed request', 'invalid_request')); return;
      }
      if (!authenticated) {
        const params = (typeof request.params === 'object' && request.params !== null ? request.params : {}) as Record<string, unknown>;
        if (helloPending || request.method !== 'hello' || params.token !== this.options.token) {
          this.options.log?.('rpc: refused unauthenticated connection');
          fail(new RpcError('unauthorized: the first message must be hello with the service token', 'unauthorized'), request.id); return;
        }
        const protocolVersion = this.options.protocolVersion ?? SERVICE_PROTOCOL_VERSION;
        const capabilities = this.options.capabilities ?? SERVICE_CAPABILITIES;
        if ((params.protocolVersion !== undefined && params.protocolVersion !== protocolVersion) ||
          (params.requiredCapabilities !== undefined && (!Array.isArray(params.requiredCapabilities) || params.requiredCapabilities.some(c => typeof c !== 'string' || !capabilities.includes(c))))) {
          fail(new RpcError('incompatible service protocol or missing required capabilities', 'incompatible', { protocolVersion, capabilities }), request.id); return;
        }
        helloPending = true;
        connection.client = typeof params.client === 'string' ? params.client : 'unknown';
        connection.version = typeof params.version === 'string' ? params.version : undefined;
        connection.subscriptions = params.subscribe === 'all' ? 'all' : new Set(Array.isArray(params.subscribe) ? params.subscribe.filter((s): s is string => typeof s === 'string') : []);
        Promise.resolve().then(() => this.options.onHello?.(connection, params)).then(result => {
          if (socket.destroyed) { this.options.onDisconnect?.(connection); return; }
          clearTimeout(helloTimer);
          authenticated = true;
          this.connections.set(id, connection);
          write({ id: request.id, result: { ...(result && typeof result === 'object' ? result : { ok: true }), protocolVersion, capabilities } });
        }, error => fail(error, request.id));
        return;
      }
      if (request.method === 'rpc.cancel') {
        const target = (request.params as { id?: unknown } | undefined)?.id;
        const pending = typeof target === 'number' ? requests.get(target) : undefined;
        pending?.controller.abort(new RpcError('request cancelled; a started mutation may have completed', 'cancelled'));
        write({ id: request.id, result: { cancelled: Boolean(pending) } }); return;
      }
      if (requests.has(request.id)) { fail(new RpcError('duplicate request id', 'invalid_request'), request.id); return; }
      const controller = new AbortController();
      const context: RpcRequestContext = { requestId: request.id, deadlineAt: request.deadlineAt, signal: controller.signal };
      const abort = () => write({ id: request.id, error: wireError(controller.signal.reason) });
      controller.signal.addEventListener('abort', abort, { once: true });
      const entry: { controller: AbortController; timer?: NodeJS.Timeout } = { controller };
      requests.set(request.id, entry);
      if (request.deadlineAt !== undefined) {
        const remaining = request.deadlineAt - Date.now();
        if (remaining <= 0) controller.abort(new RpcError('request deadline expired', 'timeout'));
        else entry.timer = setTimeout(() => controller.abort(new RpcError('request deadline expired; a started mutation may have completed', 'timeout')), Math.min(remaining, 2_147_483_647));
      }
      // The microtask check ensures a deadline/cancel/disconnect before dispatch never starts a mutation.
      Promise.resolve().then(() => {
        controller.signal.throwIfAborted();
        return this.options.handle(request.method, request.params, connection, context);
      }).then(result => {
        if (!controller.signal.aborted) write({ id: request.id, result: result ?? null });
      }, error => {
        if (!controller.signal.aborted) write({ id: request.id, error: wireError(error) });
      }).finally(() => {
        clearTimeout(entry.timer);
        controller.signal.removeEventListener('abort', abort);
        requests.delete(request.id);
      });
    }, error => fail(new RpcError(error.message, 'invalid_request')));
  }
}
async function removeStaleSocket(socketPath: string): Promise<void> {
  if (process.platform === 'win32' || !fs.existsSync(socketPath)) return;
  const original = fs.statSync(socketPath);
  const alive = await new Promise<boolean>((resolve, reject) => {
    const probe = net.connect(socketPath);
    const timer = setTimeout(() => { probe.destroy(); reject(new RpcError('timed out probing existing socket; ownership is uncertain', 'timeout')); }, 1_000);
    probe.once('connect', () => { clearTimeout(timer); probe.destroy(); resolve(true); });
    probe.once('error', error => {
      clearTimeout(timer);
      if (['ENOENT', 'ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code ?? '')) resolve(false);
      else reject(error);
    });
  });
  if (alive) throw new Error(`another service is already listening on ${socketPath}`);
  try {
    const current = fs.statSync(socketPath);
    if (current.dev !== original.dev || current.ino !== original.ino) throw new Error('socket ownership changed while checking it');
    fs.unlinkSync(socketPath);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}

export type RpcClientOptions = {
  socketPath: string; token: string; client: string; version?: string; subscribe?: string[] | 'all'; folders?: string[];
  timeoutMs?: number; protocolVersion?: number; requiredCapabilities?: readonly string[];
  /** Read-only ownership discovery for a pre-contract host. This client can only send hello. */
  allowLegacyHello?: boolean;
};
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; cleanup(): void };
export class RpcClient extends EventEmitter {
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private closed = false;
  private closeEmitted = false;
  private constructor(private readonly socket: net.Socket, private readonly probeOnly = false) {
    super();
    lineReader(socket, line => this.receive(line), error => socket.destroy(error));
    socket.on('close', () => {
      this.closed = true;
      for (const entry of this.pending.values()) { entry.cleanup(); entry.reject(new RpcError('the service connection was closed; a started mutation may have completed', 'closed')); }
      this.pending.clear();
      if (!this.closeEmitted) { this.closeEmitted = true; this.emit('close'); }
    });
    socket.on('error', error => { if (this.listenerCount('error')) this.emit('error', error); });
  }
  static connect(options: RpcClientOptions): Promise<{ client: RpcClient; hello: unknown }> {
    const timeoutMs = options.timeoutMs ?? 5_000;
    return new Promise((resolve, reject) => {
      const socket = net.connect(options.socketPath);
      const timer = setTimeout(() => { socket.destroy(); reject(new RpcError('timed out connecting to the service', 'timeout')); }, timeoutMs);
      socket.once('error', error => { clearTimeout(timer); reject(error); });
      socket.once('connect', () => {
        const client = new RpcClient(socket, options.allowLegacyHello);
        const protocolVersion = options.protocolVersion ?? SERVICE_PROTOCOL_VERSION;
        const requiredCapabilities = options.requiredCapabilities ?? ['engine'];
        client.call('hello', { token: options.token, client: options.client, version: options.version, protocolVersion: options.allowLegacyHello ? undefined : protocolVersion, requiredCapabilities: options.allowLegacyHello ? undefined : requiredCapabilities,
          subscribe: options.subscribe ?? [], folders: options.folders }, timeoutMs).then(hello => {
          const result = hello as { protocolVersion?: number; capabilities?: string[] } | null;
          if (!result || (!options.allowLegacyHello && (result.protocolVersion !== protocolVersion || !Array.isArray(result.capabilities) || requiredCapabilities.some(c => !result.capabilities!.includes(c))))) {
            throw new RpcError('the service does not support the required protocol/capabilities; upgrade or restart the engine', 'incompatible');
          }
          clearTimeout(timer); resolve({ client, hello });
        }).catch(error => { clearTimeout(timer); socket.destroy(); reject(error); });
      });
    });
  }
  get isClosed(): boolean { return this.closed; }
  call(method: string, params?: unknown, options: number | RequestOptions = 10 * 60_000): Promise<unknown> {
    if (this.probeOnly && method !== 'hello') return Promise.reject(new RpcError('ownership probes can only send hello', 'invalid_params'));
    if (this.closed || this.socket.destroyed) return Promise.reject(new RpcError('the service connection is closed', 'closed'));
    const { timeoutMs = 10 * 60_000, signal } = typeof options === 'number' ? { timeoutMs: options } : options;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.reject(new RpcError('timeoutMs must be a positive finite number', 'invalid_params'));
    if (signal?.aborted) return Promise.reject(new RpcError('request cancelled before it was sent', 'cancelled'));
    const id = this.nextId++;
    const deadlineAt = Date.now() + timeoutMs;
    let encoded: string;
    try { encoded = `${JSON.stringify({ id, method, params, deadlineAt } satisfies RpcRequest)}\n`; }
    catch (error) { return Promise.reject(new RpcError(`request cannot be serialized: ${error instanceof Error ? error.message : String(error)}`, 'invalid_params')); }
    return new Promise((resolve, reject) => {
      const cancel = (code: 'timeout' | 'cancelled') => {
        const entry = this.pending.get(id);
        if (!entry) return;
        this.pending.delete(id); entry.cleanup();
        if (!this.closed && !this.socket.destroyed) this.socket.write(`${JSON.stringify({ id: this.nextId++, method: 'rpc.cancel', params: { id } })}\n`);
        reject(new RpcError(code === 'timeout' ? `the service did not answer ${method} in time; a started mutation may have completed` : 'request cancelled; a started mutation may have completed', code));
      };
      const onAbort = () => cancel('cancelled');
      const timer = setTimeout(() => cancel('timeout'), Math.min(timeoutMs, 2_147_483_647));
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
      this.pending.set(id, { resolve, reject, cleanup });
      signal?.addEventListener('abort', onAbort, { once: true });
      this.socket.write(encoded, error => {
        if (!error) return;
        const entry = this.pending.get(id);
        if (entry) { this.pending.delete(id); entry.cleanup(); entry.reject(new RpcError('request transport failed; mutation outcome is unknown', 'closed')); }
      });
    });
  }
  close(): void { if (this.closed) return; this.closed = true; this.socket.destroy(); }
  private receive(line: string): void {
    let message: RpcResponse & RpcEvent;
    try { message = JSON.parse(line); } catch { this.socket.destroy(new RpcError('malformed service response', 'invalid_request')); return; }
    if (!message || typeof message !== 'object') { this.socket.destroy(new RpcError('malformed service response', 'invalid_request')); return; }
    if (typeof message.event === 'string') { this.emit('event', message); return; }
    const entry = this.pending.get(message.id);
    if (!entry) return;
    this.pending.delete(message.id); entry.cleanup();
    if (message.error) entry.reject(new RpcError(message.error.message, message.error.code, message.error.data));
    else entry.resolve(message.result);
  }
}
