import { ProxyLease, acquireProxyLease, proxyLeaseNamespace } from './proxyLease';
import * as fs from 'fs';
import * as path from 'path';
import { writeTextAtomically } from './authFiles';
import { ServiceConfig } from './configStore';
import { CODEX_PROXY_SERVICE, CodexAccountProxy, probeCodexProxy } from './codexProxy';
import {
  applyCodexProxyProviderToFile,
  codexConfigPath,
  newCodexProxySecret,
  readCodexConfigText,
  readCodexProxySecret,
  removeCodexProxyProviderFromFile
} from './codexConfig';

/**
 * Runs the Codex account proxy (`codexProxy.ts`) for this window and keeps Codex's `config.toml` pointing at it
 * (`codexConfig.ts`), following `aiUsage.codex.proxy.*`.
 *
 * Every window of the same user shares one Codex home, so only one window can own the port: the first to bind
 * serves, the others recognise it through the health endpoint and stay passive, and whichever window is left when
 * the owner closes takes the port over on its next tick. The owner removes the provider from `config.toml` when it
 * stops, so Codex falls back to its native login rather than to a dead port while nobody serves; the bearer token
 * is kept in SecretStorage (and in the file itself) so a new owner keeps serving chats that were started under the
 * previous one.
 */


export const DEFAULT_CODEX_PROXY_PORT = 43117;

type Status = 'off' | 'serving' | 'shared' | 'blocked' | 'error';

export class CodexProxyRuntime  {
  private disposed = false;
  private ownership?: ProxyLease;
  private proxy: CodexAccountProxy | undefined;
  private status: Status = 'off';
  private syncing: Promise<void> | undefined;
  private reported: string | undefined;
  private configFile: string | undefined;

  constructor(
    private readonly directory: string,
    private readonly config: () => ServiceConfig,
    private readonly notice: (message: string) => void,
    private readonly log: (message: string) => void,
    private readonly home: () => string,
    private readonly refreshLogin: () => Promise<unknown>,
    private readonly version: string,
    private readonly lockFile = proxyLeaseNamespace()
  ) {}

  /** True while Codex chats reach the active login through a proxy, served by this window or another one. */
  get active(): boolean {
    return this.status === 'serving' || this.status === 'shared';
  }

  /** Brings the proxy and `config.toml` in line with the settings; safe to call from every tick. */
  sync(): Promise<void> {
    if (!this.syncing) {
      this.syncing = this.reconcile()
        .catch((error) => this.log(`codex proxy: ${error instanceof Error ? error.message : String(error)}`))
        .finally(() => {
          this.syncing = undefined;
        });
    }
    return this.syncing;
  }

  dispose(): void {
    this.disposed = true;
    if (!this.proxy) { this.ownership?.release(); this.ownership = undefined; return; }
    this.proxy.closeNow();
    this.proxy = undefined;
    this.status = 'off';
    try {
      if (this.configFile && removeCodexProxyProviderFromFile(this.configFile)) {
        this.log(`codex proxy: stopped; ${this.configFile} routes Codex natively again`);
      }
    } catch {
      // Extension host is shutting down; the next window to own the port rewrites the file anyway.
    }
    this.ownership?.release(); this.ownership = undefined;
  }

  private async reconcile(): Promise<void> {
    if (this.disposed) return;
    const home = this.home();
    const file = codexConfigPath(home);
    this.configFile = file;
    if (!this.config().codex.proxy.enabled) {
      await this.turnOff(file, 'disabled');
      return;
    }
    const port = this.config().codex.proxy.port;
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      this.problem('error', 'codex.proxy.port must be an integer from 1024 to 65535.'); return;
    }
    if (this.proxy && this.proxy.port !== port) {
      await this.turnOff(file, `port changed to ${port}`);
    }
    if (this.disposed) return;
    if (!this.proxy) {
      this.ownership ??= await acquireProxyLease(this.lockFile);
      if (this.disposed) { this.ownership?.release(); this.ownership = undefined; return; }
      if (!this.ownership) {
        const health = await probeCodexProxy(port);
        if (health?.service === CODEX_PROXY_SERVICE) this.setStatus('shared', `the account proxy is already running on port ${port}`);
        else this.problem('blocked', 'Another service owns the Codex proxy for this OS user. Use that service and its configured port.');
        return;
      }
      const secret = await this.secret(file);
      if (this.disposed) return;
      const proxy = new CodexAccountProxy({
        home, port, secret, log: this.log, refreshLogin: this.refreshLogin, version: this.version,
        onLoginRejected: this.notice
      });
      try {
        await proxy.start();
        if (this.disposed) { await proxy.stop(); return; }
      } catch (error) {
        this.ownership?.release(); this.ownership = undefined;
        if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
          const health = await probeCodexProxy(port);
          if (health?.service === CODEX_PROXY_SERVICE) {
            this.setStatus('shared', `another service (pid ${health.pid ?? '?'}) serves the Codex account proxy on 127.0.0.1:${port}`);
            return;
          }
          this.problem('blocked', `port ${port} is taken by another program. Set aiUsage.codex.proxy.port to a free port.`);
          return;
        }
        this.problem('error', `could not listen on 127.0.0.1:${port}: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      this.proxy = proxy;
      this.setStatus('serving', `Codex account proxy listening on ${proxy.baseUrl}, serving the login in ${home}`);
    }
    // The owner keeps the file pointing at itself; this also repairs an external edit or a takeover.
    try {
      if (applyCodexProxyProviderToFile(file, { baseUrl: this.proxy.baseUrl, secret: this.proxy.secret })) {
        this.log(`codex proxy: ${file} now routes new Codex chats through ${this.proxy.baseUrl}`);
      }
    } catch (error) {
      this.problem('error', `could not update ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async turnOff(file: string, reason: string): Promise<void> {
    if (!this.ownership) { this.status = 'off'; return; }
    if (this.proxy) {
      await this.proxy.stop();
      this.proxy = undefined;
      this.log(`codex proxy: stopped (${reason})`);
    }
    this.status = 'off';
    this.reported = undefined;
    try {
      if (removeCodexProxyProviderFromFile(file)) {
        this.log(`codex proxy: ${file} routes Codex natively again`);
      }
    } catch (error) {
      this.log(`codex proxy: could not restore ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.ownership?.release(); this.ownership = undefined;
  }

  /**
   * The token running chats already send wins (it is in the file), then the one this user's other windows used,
   * then a new one; whichever it is ends up in both places.
   */
  private async secret(file: string): Promise<string> {
    let secret: string | undefined;
    try {
      secret = readCodexProxySecret(readCodexConfigText(file));
    } catch {
      secret = undefined;
    }
    const secretFile = path.join(this.directory, 'codex-proxy-token');
    let stored: string | undefined;
    try { stored = fs.readFileSync(secretFile, 'utf8').trim() || undefined; } catch { /* First start. */ }
    secret = secret ?? stored ?? newCodexProxySecret();
    if (secret !== stored) {
      writeTextAtomically(secretFile, secret);
    }
    return secret;
  }

  private setStatus(status: Status, message: string): void {
    if (this.status !== status) {
      this.log(`codex proxy: ${message}`);
    }
    this.status = status;
    this.reported = undefined;
  }

  /** Logged on every occurrence, shown to the user once per distinct message. */
  private problem(status: Status, message: string): void {
    this.status = status;
    this.log(`codex proxy: ${message}`);
    if (this.reported !== message) {
      this.reported = message;
      this.notice(`The Codex account proxy is not running: ${message}`);
    }
  }
}
