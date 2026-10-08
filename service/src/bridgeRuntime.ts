import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import * as os from 'os';
import { ChildProcess, spawn } from 'child_process';
import { ServiceConfig } from './configStore';

export type BridgeConnection = { endpoint: string; token: string };
/** The service owns the bridge process, token file and session policy. Clients only render/relay its responses. */
export class BridgeRuntime {
  private starting?: Promise<BridgeConnection>;
  private child?: ChildProcess;
  private disposed = false;
  private signature?: string;
  constructor(private readonly config: () => ServiceConfig, private readonly folders: () => string[] = () => []) {}
  connection(): BridgeConnection {
    const config = this.config().bridge;
    const endpoint = new URL(config.url);
    if (endpoint.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) || endpoint.username || endpoint.password) {
      throw new Error('The CLI bridge URL must be a loopback HTTP address.');
    }
    const file = config.tokenFile || path.join(os.homedir(), '.cli-byok-bridge', 'token');
    let token: string;
    try { token = fs.readFileSync(file, 'utf8').trim(); } catch { throw new Error('The bridge token is unavailable. Start the bridge through the service.'); }
    return { endpoint: endpoint.href, token };
  }
  async request(route: string, method = 'GET', body?: unknown): Promise<unknown> {
    const connection = this.connection();
    return new Promise((resolve, reject) => {
      const req = http.request(new URL(route, connection.endpoint), { method, headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json' } }, res => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', chunk => { data += chunk; if (data.length > 2 * 1024 * 1024) req.destroy(new Error('Bridge response too large.')); });
        res.on('error', reject);
        res.on('end', () => { if (res.statusCode !== 200) return reject(new Error(`Bridge returned HTTP ${res.statusCode}.`));
          try { resolve(JSON.parse(data)); } catch { reject(new Error('Invalid bridge response.')); } });
      });
      req.setTimeout(20_000, () => req.destroy(new Error('Bridge check timed out.')));
      req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
  ensure(): Promise<BridgeConnection> {
    if (!this.starting) this.starting = this.start().finally(() => { this.starting = undefined; });
    return this.starting;
  }
  private async start(): Promise<BridgeConnection> {
    if (this.disposed) throw new Error('Bridge runtime is closed.');
    const config = this.config().bridge;
    const signature = JSON.stringify([config.url, config.tokenFile, config.codex.executable, config.claude.executable]);
    if (this.child && this.signature !== signature) { this.child.kill(); this.child = undefined; }
    try { await this.request('/health'); }
    catch {
      if (!config.autoStart) throw new Error('The CLI bridge is not running and bridge.autoStart is off.');
      const endpoint = new URL(config.url);
      if (endpoint.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(endpoint.hostname) || endpoint.username || endpoint.password) throw new Error('Automatic bridge startup requires a loopback HTTP URL.');
      const entry = [path.join(__dirname, '..', 'bridge', 'src', 'cli.mjs'), path.join(__dirname, '..', '..', 'bridge', 'src', 'cli.mjs')].find(fs.existsSync);
      if (!entry) throw new Error('The service package does not contain the CLI bridge. Reinstall the service.');
      const child = spawn(process.execPath, [entry, '--port', endpoint.port || '80', '--token-file', config.tokenFile || path.join(os.homedir(), '.cli-byok-bridge', 'token'),
        '--backends', 'codex,claude', '--codex', config.codex.executable, '--claude', config.claude.executable],
      { cwd: os.tmpdir(), env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'ignore', windowsHide: true });
      this.child = child; this.signature = signature;
      let spawnError: Error | undefined;
      child.once('error', error => { spawnError = error; });
      let ready = false;
      for (let i = 0; i < 30 && !this.disposed; i++) {
        if (spawnError) throw spawnError;
        try { await this.request('/health'); ready = true; break; } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
      }
      if (!ready) { child.kill(); throw new Error('The service could not start the CLI bridge. Check bridge.url and bridge.tokenFile.'); }
    }
    if (this.disposed) { this.child?.kill(); throw new Error('Bridge runtime is closed.'); }
    await this.syncSettings();
    return this.connection();
  }
  async syncSettings(): Promise<void> {
    const folders = this.folders();
    const settings = Object.fromEntries((['codex', 'claude'] as const).map(provider => {
      const { executable: _executable, ...settings } = this.config().bridge[provider];
      return [provider, { ...settings, sessionDirectory: settings.sessionDirectory || (folders.length === 1 ? folders[0] : '') }];
    }));
    await this.request('/v1/session-settings', 'PUT', settings);
  }
  dispose(): void { this.disposed = true; this.child?.kill(); }
}
