import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import * as os from 'os';
import { createHmac, randomUUID } from 'crypto';
import { ChildProcess, spawn } from 'child_process';
import { ServiceConfig } from './configStore';

export type BridgeWorkspaceContext = { folders: string[]; sessionDirectory?: Partial<Record<'codex' | 'claude', string>> };
export type BridgeRequestContext = { directories: Partial<Record<'codex' | 'claude', string>>; expiresAt: number; signature: string };
export type BridgeConnection = { endpoint: string; token: string; workspaceContext?: BridgeRequestContext };
/** The service owns the bridge process, token file and session policy. Clients only render/relay its responses. */
export class BridgeRuntime {
  private starting?: Promise<BridgeConnection>;
  private child?: ChildProcess;
  private disposed = false;
  private stopping?: Promise<void>;
  private childStopping?: Promise<void>;
  private signature?: string;
  private readonly ownerId = randomUUID();
  constructor(private readonly config: () => ServiceConfig, _folders: () => string[] = () => []) {}
  connection(context?: BridgeWorkspaceContext): BridgeConnection {
    const config = this.config().bridge;
    const endpoint = new URL(config.url);
    if (endpoint.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) || endpoint.username || endpoint.password) {
      throw new Error('The CLI bridge URL must be a loopback HTTP address.');
    }
    const file = config.tokenFile || path.join(os.homedir(), '.cli-byok-bridge', 'token');
    let token: string;
    try { token = fs.readFileSync(file, 'utf8').trim(); } catch { throw new Error('The bridge token is unavailable. Start the bridge through the service.'); }
    const directories: Partial<Record<'codex' | 'claude', string>> = {};
    if (context) for (const provider of ['codex', 'claude'] as const) {
      const selected = context.sessionDirectory?.[provider] || (context.folders.length === 1 ? context.folders[0] : '');
      if (selected) {
        if (!path.isAbsolute(selected) || selected.includes('\0') || selected.length > 4096) throw new Error('A bridge session directory must be an absolute path.');
        directories[provider] = selected;
      }
    }
    const expiresAt = Date.now() + 60_000;
    const signature = createHmac('sha256', token).update(JSON.stringify({ directories, expiresAt })).digest('hex');
    return { endpoint: endpoint.href, token, ...(context ? { workspaceContext: { directories, expiresAt, signature } } : {}) };
  }
  async request(route: string, method = 'GET', body?: unknown): Promise<unknown> {
    const connection = this.connection();
    const endpoint = new URL(connection.endpoint);
    const target = new URL(route, endpoint);
    if (target.origin !== endpoint.origin) throw new Error('Bridge routes must stay on the local endpoint.');
    return new Promise((resolve, reject) => {
      const req = http.request(target, { method, headers: { authorization: `Bearer ${connection.token}`, 'content-type': 'application/json' } }, res => {
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
  async ensure(context?: BridgeWorkspaceContext): Promise<BridgeConnection> {
    if (this.disposed) throw new Error('Bridge runtime is closed.');
    if (!this.starting) this.starting = this.start().finally(() => { this.starting = undefined; });
    await this.starting;
    return this.connection(context);
  }
  private async start(): Promise<BridgeConnection> {
    if (this.disposed) throw new Error('Bridge runtime is closed.');
    const config = this.config().bridge;
    const signature = JSON.stringify([config.url, config.tokenFile, config.codex.executable, config.claude.executable]);
    if (this.child && this.signature !== signature) await this.stopChild();
    if (this.disposed) throw new Error('Bridge runtime is closed.');
    const tokenFile = config.tokenFile || path.join(os.homedir(), '.cli-byok-bridge', 'token');
    await this.waitForPreviousOwner(tokenFile + '.owner.json');
    let health: { capabilities?: string[]; owner?: { id?: string; pid?: number; bridgePid?: number } } | undefined;
    try { health = await this.request('/health') as typeof health; } catch { /* Start only after the endpoint is unavailable. */ }
    if (health && (!Array.isArray(health.capabilities) || !['workspace_context', 'image_input'].every(capability => health.capabilities!.includes(capability)))) {
      throw new Error('The running CLI bridge is outdated and cannot accept workspace context or images. Stop it and restart the AI Usage service.');
    }
    if ((health && this.child && !health.owner) || (health?.owner && (!this.child || health.owner.id !== this.ownerId || health.owner.bridgePid !== this.child.pid))) {
      throw new Error('The CLI bridge is owned by another managed engine; refusing to attach.');
    }
    if (this.disposed) throw new Error('Bridge runtime is closed.');
    if (!health) {
      if (this.child) await this.stopChild();
      if (!config.autoStart) throw new Error('The CLI bridge is not running and bridge.autoStart is off.');
      const endpoint = new URL(config.url);
      if (endpoint.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(endpoint.hostname) || endpoint.username || endpoint.password) throw new Error('Automatic bridge startup requires a loopback HTTP URL.');
      const entry = [path.join(__dirname, '..', 'bridge', 'src', 'cli.mjs'), path.join(__dirname, '..', '..', 'bridge', 'src', 'cli.mjs')].find(fs.existsSync);
      if (!entry) throw new Error('The service package does not contain the CLI bridge. Reinstall the service.');
      const child = spawn(process.execPath, [entry, '--port', endpoint.port || '80', '--token-file', config.tokenFile || path.join(os.homedir(), '.cli-byok-bridge', 'token'),
        '--owner-id', this.ownerId, '--owner-pid', String(process.pid), '--backends', 'codex,claude', '--codex', config.codex.executable, '--claude', config.claude.executable],
      { cwd: os.tmpdir(), env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true });
      this.child = child; this.signature = signature;
      let spawnError: Error | undefined;
      child.once('error', error => { spawnError = error; });
      child.once('close', () => { if (this.child === child) this.child = undefined; });
      let ready = false;
      for (let i = 0; i < 30 && !this.disposed; i++) {
        if (spawnError) throw spawnError;
        try {
          const status = await this.request('/health') as { capabilities?: string[]; owner?: { id?: string; bridgePid?: number } };
          if (status.owner?.id !== this.ownerId || status.owner.bridgePid !== child.pid ||
            !Array.isArray(status.capabilities) || !['workspace_context', 'image_input'].every(capability => status.capabilities!.includes(capability))) {
            throw new Error('Bridge startup ownership or capabilities did not match the managed child.');
          }
          ready = true; break;
        } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
      }
      if (!ready) { await this.stopChild(); throw new Error('The service could not start the CLI bridge. Check bridge.url and bridge.tokenFile.'); }
    }
    if (this.disposed) { await this.stopChild(); throw new Error('Bridge runtime is closed.'); }
    await this.syncSettings();
    return this.connection();
  }
  async syncSettings(_context?: BridgeWorkspaceContext): Promise<void> {
    const settings = Object.fromEntries((['codex', 'claude'] as const).map(provider => {
      const { executable: _executable, ...settings } = this.config().bridge[provider];
      return [provider, settings];
    }));
    await this.request('/v1/session-settings', 'PUT', settings);
  }
  /** Admission can close before native drain completes; its persistent child record remains authoritative. */
  private async waitForPreviousOwner(file: string): Promise<void> {
    let stat: fs.Stats | undefined;
    let record: { id: string; pid: number; parentPid: number };
    try {
      stat = fs.lstatSync(file);
      if (!stat.isFile()) throw new Error('not a regular file');
      record = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!record || typeof record.id !== 'string' || !/^[a-f0-9-]{36}$/.test(record.id) ||
        !Number.isSafeInteger(record.pid) || record.pid <= 0 || !Number.isSafeInteger(record.parentPid) || record.parentPid <= 0 ||
        record.pid === record.parentPid) throw new Error('invalid owner record');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && stat === undefined) return;
      throw new Error('The managed bridge owner record is unavailable or invalid; refusing to start another.');
    }
    if (record.id === this.ownerId && record.pid === this.child?.pid) return;
    const alive = (pid: number): boolean => {
      try { process.kill(pid, 0); }
      catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
      if (process.platform === 'linux') {
        try { return !/\) Z /.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8')); }
        catch (error) { return (error as NodeJS.ErrnoException).code !== 'ENOENT'; }
      }
      return true;
    };
    if (alive(record.pid)) {
      if (alive(record.parentPid)) throw new Error('The CLI bridge is owned by another running engine; refusing to attach.');
      const deadline = Date.now() + 6_000;
      while (alive(record.pid)) {
        if (this.disposed) throw new Error('Bridge runtime is closed.');
        if (Date.now() >= deadline) throw new Error('The orphan CLI bridge has not exited; refusing to start another.');
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    // Retain the record through child exit. Reclaim only this same observed record; a late publisher never replaces a successor.
    const current = fs.lstatSync(file);
    if (current.dev !== stat.dev || current.ino !== stat.ino || fs.readFileSync(file, 'utf8') !== JSON.stringify(record)) {
      throw new Error('The managed bridge owner changed during takeover; refusing to start another.');
    }
    fs.unlinkSync(file);
  }

  private async stopChild(): Promise<void> {
    if (this.childStopping) return this.childStopping;
    const child = this.child;
    if (!child) return;
    if (child.exitCode !== null || child.signalCode !== null) { this.child = undefined; return; }
    this.childStopping = new Promise<void>((resolve, reject) => {
      const force = setTimeout(() => child.kill('SIGKILL'), 3_000);
      const timeout = setTimeout(() => { cleanup(); reject(new Error('The previous CLI bridge did not exit; refusing to start another.')); }, 6_000);
      const cleanup = () => { clearTimeout(force); clearTimeout(timeout); child.off('close', closed); };
      const closed = () => { cleanup(); if (this.child === child) this.child = undefined; resolve(); };
      child.once('close', closed);
      child.kill('SIGTERM');
    }).finally(() => { this.childStopping = undefined; });
    await this.childStopping;
  }
  dispose(): Promise<void> {
    this.disposed = true;
    if (!this.stopping) this.stopping = (async () => {
      await this.stopChild();
      await this.starting?.catch(() => undefined);
      await this.stopChild();
    })().catch(error => { this.stopping = undefined; throw error; });
    return this.stopping;
  }
}
