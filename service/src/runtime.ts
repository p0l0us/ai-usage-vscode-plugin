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
  constructor(home: string, private readonly config: () => ServiceConfig, version: string,
    private readonly log: (message: string) => void, notice: (message: string) => void, folders: () => string[], refreshLogin?: () => Promise<unknown>) {
    this.proxy = new CodexProxyRuntime(home, config, notice, log, codexHomeDir, refreshLogin ?? (() => refreshCodexNativeLogin(config().codex.cliPath)), version);
    this.bridge = new BridgeRuntime(config, folders);
  }
  start(): void { this.started = true; void this.sync(); }
  async sync(): Promise<void> {
    if (!this.started || this.disposed) return;
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
  dispose(): void { this.disposed = true; this.proxy.dispose(); this.bridge.dispose(); }
}
