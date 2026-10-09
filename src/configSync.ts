import * as vscode from 'vscode';
import { GLOBAL_SETTINGS, ServiceConfig, SETTINGS, listConfig, defaultConfig, setConfigValue, settingScope } from '../service/out';

const warnedInvalidSettings = new Set<string>();

/**
 * Keeps the engine's settings and the extension's `aiUsage.<provider>.*` and `aiUsage.mcp.*` settings equal: a
 * change in Settings is pushed to the service, a change made with `ai-usage config` (or a hand-edited config.json)
 * is written back to the user settings. Connections hydrate engine settings from persisted state; presentation remains editor-local.
 */

/** `claude.autoRotate.enabled` ↔ `aiUsage.claude.autoRotate.enabled`, `mcp.enabled` ↔ `aiUsage.mcp.enabled`. */
export function settingKey(configKey: string): string {
  return `aiUsage.${configKey}`;
}

export function configKeyOf(settingKey: string): string | undefined {
  if (!settingKey.startsWith('aiUsage.')) { return undefined; }
  const key = settingKey.slice('aiUsage.'.length);
  if (GLOBAL_SETTINGS.some((setting) => setting.key === key)) { return key; }
  const match = /^(claude|codex)\.(.+)$/.exec(key);
  if (!match) { return undefined; }
  const [, provider, rest] = match;
  const schema = SETTINGS.find((setting) => setting.key === rest);
  return schema && (!schema.providers || schema.providers.includes(provider as 'claude' | 'codex')) ? key : undefined;
}

/** Every config key with the value the user settings hold for it (an unset setting yields its default). */
export function readSettings(config: ServiceConfig, configuration = vscode.workspace.getConfiguration()): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  let validatedConfig = config;
  for (const entry of listConfig(config)) {
    const key = settingKey(entry.key);
    const value = configuration.get<unknown>(key);
    if (value === undefined) { continue; }
    // A setting without a default that nobody set comes back as its type's empty value (0 for a number), which is
    // not a choice and may not even be valid for the service; one such value would make it reject the whole batch.
    const inspected = configuration.inspect?.<unknown>(key);
    if (inspected && inspected.defaultValue === undefined && [inspected.globalValue, inspected.workspaceValue, inspected.workspaceFolderValue]
      .every((candidate) => candidate === undefined)) { continue; }
    try {
      validatedConfig = setConfigValue(validatedConfig, entry.key, value);
    } catch {
      if (!warnedInvalidSettings.has(entry.key)) {
        warnedInvalidSettings.add(entry.key);
        void vscode.window.showWarningMessage(`AI Usage: the setting aiUsage.${entry.key} is ignored: it does not meet the service's validation rules. Change or remove it in Settings.`);
      }
      continue;
    }
    values[entry.key] = value;
  }
  return values;
}

/** Seed only explicit first-run engine choices; defaults and editor presentation never become engine writes. */
export function readSeedSettings(config: ServiceConfig, configuration = vscode.workspace.getConfiguration()): Record<string, unknown> {
  return Object.fromEntries(Object.entries(readSettings(config, configuration)).filter(([key]) => {
    if (settingScope(key) !== 'engine') return false;
    const inspected = configuration.inspect?.<unknown>(settingKey(key));
    return inspected && [inspected.globalValue, inspected.workspaceValue, inspected.workspaceFolderValue].some(value => value !== undefined);
  }));
}

export function differences(config: ServiceConfig, configuration = vscode.workspace.getConfiguration()): Array<{ key: string; value: unknown; current: unknown }> {
  const result: Array<{ key: string; value: unknown; current: unknown }> = [];
  for (const entry of listConfig(config)) {
    if (settingScope(entry.key) !== 'engine') continue;
    const current = configuration.get<unknown>(settingKey(entry.key));
    if (current === undefined) { continue; }
    if (JSON.stringify(current) !== JSON.stringify(entry.value)) { result.push({ key: entry.key, value: entry.value, current }); }
  }
  return result;
}

export class ConfigSync {
  /** Set while this class writes user settings, so the resulting change events are not pushed back. */
  private writing = 0;
  private readonly expectedWrites = new Map<string, unknown>();
  private pending = Promise.resolve(0);

  constructor(private readonly log: (message: string) => void) {}

  get isWriting(): boolean { return this.writing > 0; }

  /** Writes the service's values into the user settings where they differ. */
  pull(config: ServiceConfig): Promise<number> {
    this.pending = this.pending.catch(() => 0).then(() => this.hydrate(config));
    return this.pending;
  }

  private async hydrate(config: ServiceConfig): Promise<number> {
    const changes = differences(config);
    if (!changes.length) { return 0; }
    const configuration = vscode.workspace.getConfiguration();
    this.writing++;
    try {
      for (const change of changes) {
        this.expectedWrites.set(change.key, change.value);
        const inspected = configuration.inspect?.(settingKey(change.key));
        const target = inspected?.workspaceFolderValue !== undefined ? vscode.ConfigurationTarget.WorkspaceFolder
          : inspected?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
        await configuration.update(settingKey(change.key), change.value, target);
      }
      this.log(`settings: adopted ${changes.map((change) => `${change.key} = ${JSON.stringify(change.value)}`).join(', ')} from the account service`);
    } finally {
      this.writing--;
    }
    return changes.length;
  }

  /** The values to push for a configuration change event; empty when the change was this class's own write. */
  changedKeys(event: vscode.ConfigurationChangeEvent, config: ServiceConfig): Record<string, unknown> {
    const values: Record<string, unknown> = {};
    const configuration = vscode.workspace.getConfiguration();
    for (const entry of listConfig(config)) {
      if (settingScope(entry.key) !== 'engine') continue;
      const key = settingKey(entry.key);
      if (!event.affectsConfiguration(key)) { continue; }
      const value = configuration.get<unknown>(key);
      if (this.expectedWrites.has(entry.key) && JSON.stringify(this.expectedWrites.get(entry.key)) === JSON.stringify(value)) {
        this.expectedWrites.delete(entry.key); continue;
      }
      this.expectedWrites.delete(entry.key);
      if (value !== undefined && JSON.stringify(value) !== JSON.stringify(entry.value)) { values[entry.key] = value; }
    }
    return values;
  }
}

/** Reuse service validation and defaults when interpreting editor presentation settings. */
export function configFromSettings(configuration = vscode.workspace.getConfiguration()): ServiceConfig {
  let config = defaultConfig();
  for (const [key, value] of Object.entries(readSettings(config, configuration))) config = setConfigValue(config, key, value);
  return config;
}
