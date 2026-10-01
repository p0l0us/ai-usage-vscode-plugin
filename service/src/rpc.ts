import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as net from 'net';

/**
 * Newline-delimited JSON over a local socket. A client's first message must be `hello` with the shared token;
 * until then the connection answers nothing but an error and is closed. No `vscode` imports: the extension and
 * the command line share this module.
 */

export type RpcRequest = { id: number; method: string; params?: unknown };
export type RpcResponse = { id: number; result?: unknown; error?: { message: string; code?: string } };
/** A pushed message: the event name and its fields, flat. */
export type RpcEvent = { event: string } & Record<string, unknown>;

export class RpcError extends Error {
  constructor(message: string, readonly code?: string) { super(message); }
}

/** Server-side view of one client. */
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
  /** Handles a method after the hello; `hello` itself is handled here. */
  handle: (method: string, params: unknown, connection: RpcConnection) => Promise<unknown>;
  /** Called with the hello params once a client authenticated; may throw to refuse it. */
  onHello?: (connection: RpcConnection, params: Record<string, unknown>) => unknown;
  onDisconnect?: (connection: RpcConnection) => void;
  log?: (message: string) => void;
};

const MAX_LINE_BYTES = 8 * 1024 * 1024;

/** Splits a socket's bytes into JSON lines; an oversized or malformed line closes the connection. */
export function lineReader(socket: net.Socket, onLine: (line: string) => void, onError: (error: Error) => void): void {
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    if (buffer.length > MAX_LINE_BYTES) { onError(new Error('message too large')); return; }
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
      if (line) { onLine(line); }
    }
  });
}

export class RpcServer {
  private readonly server: net.Server;
  private readonly connections = new Map<number, RpcConnection>();
  private nextId = 1;

  constructor(private readonly options: RpcServerOptions) {
    this.server = net.createServer((socket) => this.accept(socket));
  }

  get clientCount(): number { return this.connections.size; }

  /** Lists authenticated clients. */
  clients(): RpcConnection[] { return [...this.connections.values()]; }

  async listen(): Promise<void> {
    await removeStaleSocket(this.options.socketPath);
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.options.socketPath, () => { this.server.off('error', reject); resolve(); });
    });
    if (process.platform !== 'win32') {
      try { fs.chmodSync(this.options.socketPath, 0o600); } catch { /* Best effort; the directory is 0700. */ }
    }
  }

  broadcast(event: RpcEvent): void {
    for (const connection of this.connections.values()) {
      if (connection.subscriptions === 'all' || connection.subscriptions.has(event.event)) { connection.send(event); }
    }
  }

  async close(): Promise<void> {
    for (const connection of this.connections.values()) { connection.close(); }
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    if (process.platform !== 'win32') {
      try { fs.unlinkSync(this.options.socketPath); } catch { /* Already gone. */ }
    }
  }

  private accept(socket: net.Socket): void {
    const id = this.nextId++;
    let authenticated = false;
    const write = (message: RpcResponse | RpcEvent) => {
      if (!socket.destroyed) { socket.write(`${JSON.stringify(message)}\n`); }
    };
    const connection: RpcConnection = {
      id, client: 'unknown', subscriptions: new Set(),
      send: (event) => write(event),
      close: () => socket.destroy()
    };
    const fail = (message: string, id = 0) => { write({ id, error: { message } }); socket.end(); };
    socket.on('error', () => { /* A client that vanished; close handles it. */ });
    socket.on('close', () => {
      if (authenticated) {
        this.connections.delete(id);
        this.options.onDisconnect?.(connection);
      }
    });
    lineReader(socket, (line) => {
      let request: RpcRequest;
      try { request = JSON.parse(line) as RpcRequest; } catch { fail('malformed request'); return; }
      if (typeof request.id !== 'number' || typeof request.method !== 'string') { fail('malformed request'); return; }
      if (!authenticated) {
        const params = (typeof request.params === 'object' && request.params !== null ? request.params : {}) as Record<string, unknown>;
        if (request.method !== 'hello' || params.token !== this.options.token) {
          this.options.log?.(`rpc: refused a connection that did not start with a valid hello`);
          fail('unauthorized: the first message must be hello with the service token', request.id);
          return;
        }
        authenticated = true;
        connection.client = typeof params.client === 'string' ? params.client : 'unknown';
        connection.version = typeof params.version === 'string' ? params.version : undefined;
        connection.subscriptions = params.subscribe === 'all' ? 'all' : new Set(Array.isArray(params.subscribe) ? params.subscribe.map(String) : []);
        this.connections.set(id, connection);
        Promise.resolve().then(() => this.options.onHello?.(connection, params)).then(
          (result) => write({ id: request.id, result: result ?? { ok: true } }),
          (error) => { write({ id: request.id, error: { message: error instanceof Error ? error.message : String(error) } }); socket.end(); });
        return;
      }
      this.options.handle(request.method, request.params, connection).then(
        (result) => write({ id: request.id, result: result ?? null }),
        (error) => write({ id: request.id, error: { message: error instanceof Error ? error.message : String(error), code: error instanceof RpcError ? error.code : undefined } }));
    }, (error) => fail(error.message));
  }
}

/** A leftover Unix socket file with nobody listening keeps a new daemon from binding it. */
async function removeStaleSocket(socketPath: string): Promise<void> {
  if (process.platform === 'win32' || !fs.existsSync(socketPath)) { return; }
  const alive = await new Promise<boolean>((resolve) => {
    const probe = net.connect(socketPath);
    probe.once('connect', () => { probe.destroy(); resolve(true); });
    probe.once('error', () => resolve(false));
  });
  if (alive) { throw new Error(`another service is already listening on ${socketPath}`); }
  fs.unlinkSync(socketPath);
}

export type RpcClientOptions = {
  socketPath: string;
  token: string;
  client: string;
  version?: string;
  subscribe?: string[] | 'all';
  /** Project folders open at the client. */
  folders?: string[];
  /** Connect and hello timeout. */
  timeoutMs?: number;
};

/** Client side: one socket, sequential ids, typed events. Emits `event` with each pushed message and `close`. */
export class RpcClient extends EventEmitter {
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer?: NodeJS.Timeout }>();
  private nextId = 1;
  private closed = false;

  private constructor(private readonly socket: net.Socket) {
    super();
    lineReader(socket, (line) => this.receive(line), (error) => this.socket.destroy(error));
    socket.on('close', () => {
      this.closed = true;
      for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(new RpcError('the service connection was closed', 'closed')); }
      this.pending.clear();
      this.emit('close');
    });
    socket.on('error', (error) => { this.emit('error', error); });
  }

  static connect(options: RpcClientOptions): Promise<{ client: RpcClient; hello: unknown }> {
    const timeoutMs = options.timeoutMs ?? 5_000;
    return new Promise((resolve, reject) => {
      const socket = net.connect(options.socketPath);
      const timer = setTimeout(() => { socket.destroy(); reject(new RpcError('timed out connecting to the service', 'timeout')); }, timeoutMs);
      socket.once('error', (error) => { clearTimeout(timer); reject(error); });
      socket.once('connect', () => {
        const client = new RpcClient(socket);
        // Nothing else may be sent before the hello is answered.
        client.call('hello', { token: options.token, client: options.client, version: options.version, subscribe: options.subscribe ?? [], folders: options.folders }, timeoutMs).then(
          (hello) => { clearTimeout(timer); resolve({ client, hello }); },
          (error) => { clearTimeout(timer); socket.destroy(); reject(error); });
      });
    });
  }

  get isClosed(): boolean { return this.closed; }

  call(method: string, params?: unknown, timeoutMs = 10 * 60_000): Promise<unknown> {
    if (this.closed) { return Promise.reject(new RpcError('the service connection is closed', 'closed')); }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new RpcError(`the service did not answer ${method} in time`, 'timeout')); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(`${JSON.stringify({ id, method, params } satisfies RpcRequest)}\n`);
    });
  }

  close(): void {
    this.closed = true;
    this.socket.end();
    this.socket.destroy();
  }

  private receive(line: string): void {
    let message: RpcResponse & RpcEvent;
    try { message = JSON.parse(line); } catch { return; }
    if (typeof message.event === 'string') { this.emit('event', message); return; }
    const entry = this.pending.get(message.id);
    if (!entry) { return; }
    this.pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) { entry.reject(new RpcError(message.error.message, message.error.code)); }
    else { entry.resolve(message.result); }
  }
}
