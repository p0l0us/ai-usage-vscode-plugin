import * as path from 'path';
import { ServiceConfig, getConfigValue } from './configStore';
import { claudeConfigDir, codexHomeDir, refreshCodexNativeLogin } from './live';
import { CodexProxyRuntime } from './codexProxyRuntime';
import { codexConfigPath } from './codexConfig';
import { applyCodexSettingsToFile, readCodexSettingAssignments } from './codexSettings';
import { applyClaudeSettingsToFile, readClaudeSettingAssignments } from './claudeSettings';
import { BridgeRuntime } from './bridgeRuntime';

export class ServiceRuntime {
  readonly proxy: CodexProxyRuntime;
  readonly bridge: BridgeRuntime;
  private started = false;
  private disposed = false;
  /** The home's ownership lease; native settings, the proxy and the bridge are touched only while it is held. */
  ownership?: { held(): boolean };
  constructor(home: string, private readonly config: () => ServiceConfig, version: string,
    private readonly log: (message: string) => void, notice: (message: string) => void, folders: () => string[], refreshLogin?: () => Promise<unknown>) {
    this.proxy = new CodexProxyRuntime(home, config, notice, log, codexHomeDir, refreshLogin ?? (() => refreshCodexNativeLogin(config().codex.cliPath)), version);
    this.bridge = new BridgeRuntime(config, folders);
  }
  /** Starts reconciling native settings, the proxy and the bridge; only an owned engine does (see AccountService.start). */
  start(): Promise<void> { this.started = true; return this.sync(); }
  async sync(): Promise<void> {
    if (!this.started || this.disposed) return;
    if (this.ownership && !this.ownership.held()) return;
    const get = (key: string) => getConfigValue(this.config(), key.replace(/^aiUsage\./, ''));
    try {
      applyCodexSettingsToFile(codexConfigPath(codexHomeDir()), readCodexSettingAssignments(get));
      applyClaudeSettingsToFile(path.join(claudeConfigDir(), 'settings.json'), readClaudeSettingAssignments(get));
    } catch (error) { this.log(`native settings: ${error instanceof Error ? error.message : String(error)}`); }
    await this.proxy.sync();
    // An enabled bridge keeps working independently of VS Code.
    if (this.config().bridge.modelsEnabled && this.config().bridge.autoStart) {
      try { await this.bridge.ensure(); } catch (error) { this.log(`bridge: ${error instanceof Error ? error.message : String(error)}`); }
    }
  }
  /** Restores native routing, stops the proxy, and resolves once the bridge process has exited. */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.proxy.dispose();
    await this.bridge.dispose();
  }
}
