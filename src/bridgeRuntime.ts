import * as vscode from 'vscode';
import { ChildProcess, spawn } from 'child_process';
import * as path from 'path';
import * as os from 'os';
import * as net from 'net';
import { bridgeGet, syncSessionSettings } from './bridgeIntegration';

export class BridgeRuntime implements vscode.Disposable {
  private starting?: Promise<void>;
  private child?: ChildProcess;
  private disposed = false;
  constructor(private readonly extensionPath: string) {}

  ensure(): Promise<void> {
    if (!this.starting) this.starting = this.start().finally(() => { this.starting = undefined; });
    return this.starting;
  }

  private async start(): Promise<void> {
    if (this.disposed) throw new Error('Bridge runtime is closed.');
    const config = vscode.workspace.getConfiguration('aiUsage.bridge');
    const endpoint = new URL(config.get<string>('url', 'http://127.0.0.1:3210'));
    if (endpoint.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) || endpoint.username || endpoint.password) throw new Error('The CLI bridge URL must be a loopback HTTP address.');
    const port = Number(endpoint.port || 80);
    const listening = await new Promise<boolean>(resolve => {
      const socket = net.connect({ host: endpoint.hostname.replace(/^\[|\]$/g, ''), port });
      const finish = (value: boolean) => { socket.destroy(); resolve(value); };
      socket.setTimeout(1000, () => finish(false)); socket.once('connect', () => finish(true)); socket.once('error', () => finish(false));
    });
    if (!listening) {
      if (!config.get('autoStart', true)) throw new Error('CLI bridge is not running. Enable AI Usage Bridge: Auto Start or start it manually.');
      if (endpoint.hostname === '[::1]') throw new Error('Automatic startup requires the bridge URL to use 127.0.0.1 or localhost.');
      const tokenFile = config.get<string>('tokenFile', '') || path.join(os.homedir(), '.cli-byok-bridge', 'token');
      const args = [path.join(this.extensionPath, 'bridge', 'src', 'cli.mjs'), '--port', String(port), '--token-file', tokenFile,
        '--backends', 'codex,claude', '--codex', config.get<string>('codex.executable', 'codex'), '--claude', config.get<string>('claude.executable', 'claude')];
      const child = spawn(process.execPath, args, { cwd: this.extensionPath, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'ignore', windowsHide: true });
      this.child = child;
      let spawnError: Error | undefined;
      child.once('error', error => { spawnError = error; });
      // Another VS Code window may win the bind race. Check the shared endpoint
      // even if this child exits; never terminate a server owned by another window.
      let ready = false;
      for (let attempt = 0; attempt < 30 && !this.disposed; attempt++) {
        if (spawnError) throw new Error('Could not start the bundled CLI bridge.');
        try { await bridgeGet('/health'); ready = true; break; } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
      }
      if (!ready) throw new Error('The bundled CLI bridge did not start. Check the bridge URL and token file in AI Usage → Copilot CLI bridge (experimental) settings.');
    } else await bridgeGet('/health'); // Verify authentication before discovering models.
    if (this.disposed) throw new Error('Bridge runtime is closed.');
    await syncSessionSettings();
  }

  dispose(): void { this.disposed = true; this.child?.kill(); }
}
