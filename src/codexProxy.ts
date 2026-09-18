import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as path from 'path';
import { URL } from 'url';

/**
 * Local reverse proxy that gives running Codex processes the currently active login.
 *
 * A Codex `app-server` loads `auth.json` once and never adopts a rewritten file (verified against 0.154.0), and the
 * Codex VS Code extension never respawns its server, so an AI Usage profile switch used to need an extension-host
 * restart. Codex does, however, re-read `config.toml` when a chat starts, and a custom model provider may point at
 * any `base_url`. AI Usage therefore registers itself as that provider (see `codexConfig.ts`): Codex posts every
 * model request here without credentials, and this proxy reads `auth.json` *per request*, attaches the active
 * login and forwards the request untouched — ChatGPT logins to the ChatGPT Codex backend, API keys to the OpenAI
 * API. A switch is therefore visible to every chat on the proxy from its next turn. The server binds to
 * 127.0.0.1 only and requires the bearer token written into `config.toml`, so a web page on the same machine
 * cannot use the login through it.
 */

export const CODEX_PROXY_SERVICE = 'ai-usage-codex-proxy';
export const CHATGPT_CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex';
export const OPENAI_API_BASE_URL = 'https://api.openai.com/v1';
/** Path Codex is given as `base_url`; everything below it is forwarded. */
const PREFIX = '/v1';
const HEALTH_PATH = '/ai-usage/health';
/** Codex request bodies carry the whole conversation; well above anything seen, well below memory trouble. */
const MAX_BODY_BYTES = 64 * 1024 * 1024;
/** Time to first upstream byte. Streams are not limited afterwards; long turns are normal. */
const UPSTREAM_HEADERS_TIMEOUT_MS = 60_000;
const PROBE_TIMEOUT_MS = 1_500;

/** Request headers that describe the local hop or that the proxy sets itself. */
const DROPPED_REQUEST_HEADERS = new Set([
  'host', 'connection', 'keep-alive', 'content-length', 'transfer-encoding', 'te', 'upgrade', 'expect',
  'authorization', 'chatgpt-account-id', 'proxy-authorization', 'proxy-connection'
]);
const DROPPED_RESPONSE_HEADERS = new Set(['connection', 'keep-alive', 'transfer-encoding']);

export type CodexLogin =
  | { kind: 'chatgpt'; accessToken: string; accountId?: string }
  | { kind: 'apikey'; apiKey: string };

function jwtClaims(token: string): Record<string, unknown> | undefined {
  const parts = token.split('.');
  if (parts.length < 2) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function accountIdFromToken(token: string): string | undefined {
  const auth = jwtClaims(token)?.['https://api.openai.com/auth'];
  const id = typeof auth === 'object' && auth !== null ? (auth as Record<string, unknown>).chatgpt_account_id : undefined;
  return typeof id === 'string' && id ? id : undefined;
}

/** Reads a Codex `auth.json` document the way Codex does: a ChatGPT login wins unless `auth_mode` says API key. */
export function parseCodexLogin(document: unknown): CodexLogin | undefined {
  if (typeof document !== 'object' || document === null) {
    return undefined;
  }
  const record = document as Record<string, unknown>;
  const tokens = typeof record.tokens === 'object' && record.tokens !== null ? record.tokens as Record<string, unknown> : undefined;
  const accessToken = typeof tokens?.access_token === 'string' && tokens.access_token ? tokens.access_token : undefined;
  const apiKey = typeof record.OPENAI_API_KEY === 'string' && record.OPENAI_API_KEY ? record.OPENAI_API_KEY : undefined;
  const mode = typeof record.auth_mode === 'string' ? record.auth_mode.toLowerCase() : undefined;
  if (accessToken && !(mode === 'apikey' && apiKey)) {
    const accountId = typeof tokens?.account_id === 'string' && tokens.account_id ? tokens.account_id : accountIdFromToken(accessToken);
    return { kind: 'chatgpt', accessToken, accountId };
  }
  return apiKey ? { kind: 'apikey', apiKey } : undefined;
}

export function codexAuthPath(home: string): string {
  return path.join(home, 'auth.json');
}

/** The login in `home/auth.json` right now; undefined when the file is missing, unreadable or holds no login. */
export function readCodexLogin(home: string): CodexLogin | undefined {
  try {
    return parseCodexLogin(JSON.parse(fs.readFileSync(codexAuthPath(home), 'utf8')));
  } catch {
    return undefined;
  }
}

export type CodexProxyOptions = {
  /** Codex home whose `auth.json` holds the active login. */
  home: string;
  /** 0 picks a free port (tests). */
  port: number;
  /** Bearer token Codex sends (from `config.toml`); requests without it are refused. */
  secret: string;
  log: (message: string) => void;
  /**
   * Asked once after an upstream 401 for a ChatGPT login. Codex itself performs the refresh and rewrites
   * `auth.json` (rotating the refresh token safely); the proxy only re-reads the file afterwards.
   */
  refreshLogin?: () => Promise<unknown>;
  chatgptBaseUrl?: string;
  apiBaseUrl?: string;
  /** Reported by the health endpoint so another window can recognise the proxy. */
  version?: string;
};

type ProxyError = { error: { message: string; type: string } };

function errorBody(message: string): ProxyError {
  return { error: { message, type: 'ai_usage_proxy_error' } };
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

/** Only the loopback names; a browser page cannot make a request whose Host is one of them point elsewhere. */
export function isLoopbackHost(host: string | undefined): boolean {
  const name = (host ?? '').replace(/:\d+$/, '').toLowerCase();
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]';
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('request body too large'), { code: 'E_TOO_LARGE' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** The version Codex sends the ChatGPT backend from its own client but not from a custom provider. */
function codexVersionFromUserAgent(userAgent: string | string[] | undefined): string | undefined {
  const match = /^codex[\w-]*\/(\S+)/.exec(String(userAgent ?? ''));
  return match?.[1];
}

/** Headers for the upstream request: Codex's own headers plus the active login. */
export function upstreamHeaders(incoming: http.IncomingHttpHeaders, login: CodexLogin, bodyLength: number): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(incoming)) {
    if (value !== undefined && !DROPPED_REQUEST_HEADERS.has(name)) {
      headers[name] = value;
    }
  }
  headers['content-length'] = String(bodyLength);
  if (login.kind === 'chatgpt') {
    headers.authorization = `Bearer ${login.accessToken}`;
    if (login.accountId) {
      headers['chatgpt-account-id'] = login.accountId;
    }
    const version = codexVersionFromUserAgent(incoming['user-agent']);
    if (version && headers.version === undefined) {
      headers.version = version;
    }
  } else {
    headers.authorization = `Bearer ${login.apiKey}`;
  }
  return headers;
}

function responseHeaders(incoming: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(incoming)) {
    if (value !== undefined && !DROPPED_RESPONSE_HEADERS.has(name)) {
      headers[name] = value;
    }
  }
  return headers;
}

export class CodexAccountProxy {
  private server: http.Server | undefined;
  private refreshing: Promise<void> | undefined;
  private requests = 0;

  constructor(private readonly options: CodexProxyOptions) {}

  get secret(): string {
    return this.options.secret;
  }

  get port(): number {
    const address = this.server?.address();
    return typeof address === 'object' && address ? address.port : this.options.port;
  }

  /** What Codex is given as the provider's `base_url`. */
  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}${PREFIX}`;
  }

  get listening(): boolean {
    return this.server?.listening ?? false;
  }

  /** Rejects with the `listen` error (`EADDRINUSE` when another process holds the port). */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => void this.handle(req, res));
      // Codex talks WebSocket to its own backend but plain HTTP to a custom provider; refuse upgrades outright.
      server.on('upgrade', (_req, socket) => socket.end('HTTP/1.1 404 Not Found\r\nconnection: close\r\n\r\n'));
      server.once('error', reject);
      server.listen(this.options.port, '127.0.0.1', () => {
        server.off('error', reject);
        server.on('error', (error) => this.options.log(`codex proxy: server error: ${error.message}`));
        this.server = server;
        resolve();
      });
    });
  }

  /** Stops accepting connections; streams that are already running finish on their own. */
  stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    return new Promise((resolve) => {
      if (!server) {
        resolve();
        return;
      }
      server.close(() => resolve());
      server.closeIdleConnections();
    });
  }

  /** Same as `stop`, without waiting; for `deactivate()`. */
  closeNow(): void {
    this.server?.close();
    this.server?.closeIdleConnections();
    this.server = undefined;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === HEALTH_PATH) {
      sendJson(res, 200, { service: CODEX_PROXY_SERVICE, pid: process.pid, version: this.options.version ?? null });
      return;
    }
    if (!isLoopbackHost(req.headers.host)) {
      sendJson(res, 403, errorBody('The AI Usage Codex proxy only answers requests addressed to 127.0.0.1.'));
      return;
    }
    if (!url.pathname.startsWith(`${PREFIX}/`)) {
      sendJson(res, 404, errorBody(`The AI Usage Codex proxy has no route ${url.pathname}.`));
      return;
    }
    if (req.headers.authorization !== `Bearer ${this.options.secret}`) {
      sendJson(res, 401, errorBody('The request did not carry the AI Usage Codex proxy token from config.toml; start a new Codex chat to pick up the current configuration.'));
      return;
    }
    let body: Buffer;
    try {
      body = await readBody(req);
    } catch (error) {
      sendJson(res, (error as NodeJS.ErrnoException).code === 'E_TOO_LARGE' ? 413 : 400, errorBody(`Could not read the request: ${(error as Error).message}`));
      return;
    }
    let login = readCodexLogin(this.options.home);
    if (!login) {
      sendJson(res, 401, errorBody(`No Codex login in ${codexAuthPath(this.options.home)}. Sign in with Codex or activate an AI Usage profile.`));
      return;
    }
    const id = ++this.requests;
    const aborted = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) {
        aborted.abort();
      }
    });
    try {
      let upstream = await this.forward(req, url, body, login, aborted.signal);
      if (upstream.statusCode === 401 && login.kind === 'chatgpt' && this.options.refreshLogin) {
        this.options.log(`codex proxy #${id}: upstream answered 401; asking Codex to refresh the login`);
        await this.refresh();
        const refreshed = readCodexLogin(this.options.home);
        if (refreshed?.kind === 'chatgpt' && refreshed.accessToken !== login.accessToken) {
          upstream.destroy();
          login = refreshed;
          upstream = await this.forward(req, url, body, login, aborted.signal);
        }
      }
      if (upstream.statusCode && upstream.statusCode >= 400) {
        this.options.log(`codex proxy #${id}: ${req.method} ${url.pathname} → ${upstream.statusCode} (${login.kind} login)`);
      }
      res.writeHead(upstream.statusCode ?? 502, responseHeaders(upstream.headers));
      upstream.pipe(res);
    } catch (error) {
      if (aborted.signal.aborted) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.options.log(`codex proxy #${id}: upstream request failed: ${message}`);
      if (!res.headersSent) {
        sendJson(res, 502, errorBody(`The AI Usage Codex proxy could not reach OpenAI: ${message}`));
      } else {
        res.destroy();
      }
    }
  }

  private forward(req: http.IncomingMessage, url: URL, body: Buffer, login: CodexLogin, signal: AbortSignal): Promise<http.IncomingMessage> {
    const base = (login.kind === 'chatgpt' ? this.options.chatgptBaseUrl ?? CHATGPT_CODEX_BASE_URL : this.options.apiBaseUrl ?? OPENAI_API_BASE_URL).replace(/\/+$/, '');
    const target = new URL(`${base}${url.pathname.slice(PREFIX.length)}${url.search}`);
    const transport = target.protocol === 'http:' ? http : https;
    return new Promise((resolve, reject) => {
      const request = transport.request(target, { method: req.method, headers: upstreamHeaders(req.headers, login, body.length), signal }, (response) => {
        request.setTimeout(0);
        resolve(response);
      });
      request.setTimeout(UPSTREAM_HEADERS_TIMEOUT_MS, () => request.destroy(new Error('OpenAI did not answer within 60 seconds')));
      request.on('error', reject);
      request.end(body);
    });
  }

  /** One refresh at a time: concurrent 401s share it, so the refresh token is never used twice. */
  private refresh(): Promise<void> {
    if (!this.refreshing) {
      this.refreshing = Promise.resolve(this.options.refreshLogin?.()).then(() => undefined, (error) => {
        this.options.log(`codex proxy: login refresh failed: ${error instanceof Error ? error.message : String(error)}`);
      }).finally(() => {
        this.refreshing = undefined;
      });
    }
    return this.refreshing;
  }
}

export type CodexProxyHealth = { service?: string; pid?: number; version?: string | null };

/** Asks whatever listens on the port whether it is an AI Usage Codex proxy; undefined when it is not (or silent). */
export function probeCodexProxy(port: number): Promise<CodexProxyHealth | undefined> {
  return new Promise((resolve) => {
    const request = http.get({ host: '127.0.0.1', port, path: HEALTH_PATH, timeout: PROBE_TIMEOUT_MS }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        if (text.length < 4096) {
          text += chunk;
        }
      });
      response.on('end', () => {
        try {
          const parsed: unknown = JSON.parse(text);
          resolve(typeof parsed === 'object' && parsed !== null ? parsed as CodexProxyHealth : undefined);
        } catch {
          resolve(undefined);
        }
      });
      response.on('error', () => resolve(undefined));
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(undefined));
  });
}
