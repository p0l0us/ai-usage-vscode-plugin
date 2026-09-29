import * as vscode from 'vscode';
import { ServiceConfig, SETTINGS, listConfig } from '../service/out';

/**
 * Keeps the service's settings and the extension's `aiUsage.<provider>.*` settings equal: a change in Settings is
 * pushed to the service, a change made with `ai-usage config` (or a hand-edited config.json) is written back to
 * the user settings. The service's file is the source of truth once it exists; the extension seeds it from the
 * user settings the first time.
 */

/** `claude.autoRotate.enabled` ↔ `aiUsage.claude.autoRotate.enabled`. */
export function settingKey(configKey: string): string {
  return `aiUsage.${configKey}`;
}

export function configKeyOf(settingKey: string): string | undefined {
  const match = /^aiUsage\.((claude|codex)\.(.+))$/.exec(settingKey);
  if (!match) { return undefined; }
  const [, key, provider, rest] = match;
  const schema = SETTINGS.find((setting) => setting.key === rest);
  return schema && (!schema.providers || schema.providers.includes(provider as 'claude' | 'codex')) ? key : undefined;
}

/** Every config key with the value the user settings hold for it (an unset setting yields its default). */
export function readSettings(config: ServiceConfig, configuration = vscode.workspace.getConfiguration()): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const entry of listConfig(config)) {
    const value = configuration.get<unknown>(settingKey(entry.key));
    if (value !== undefined && value !== null) { values[entry.key] = value; }
  }
  return values;
}

/**
 * Config keys whose user setting differs from the service value, with the service value. A setting VS Code does
 * not know (undefined) is left alone rather than written.
 */
export function differences(config: ServiceConfig, configuration = vscode.workspace.getConfiguration()): Array<{ key: string; value: unknown; current: unknown }> {
  const result: Array<{ key: string; value: unknown; current: unknown }> = [];
  for (const entry of listConfig(config)) {
    const current = configuration.get<unknown>(settingKey(entry.key));
    if (current === undefined || current === null) { continue; }
    if (JSON.stringify(current) !== JSON.stringify(entry.value)) { result.push({ key: entry.key, value: entry.value, current }); }
  }
  return result;
}

export class ConfigSync {
  /** Set while this class writes user settings, so the resulting change events are not pushed back. */
  private writing = 0;

  constructor(private readonly log: (message: string) => void) {}

  get isWriting(): boolean { return this.writing > 0; }

  /** Writes the service's values into the user settings where they differ. */
  async pull(config: ServiceConfig): Promise<number> {
    const changes = differences(config);
    if (!changes.length) { return 0; }
    const configuration = vscode.workspace.getConfiguration();
    this.writing++;
    try {
      for (const change of changes) {
        await configuration.update(settingKey(change.key), change.value, vscode.ConfigurationTarget.Global);
      }
      this.log(`settings: adopted ${changes.map((change) => `${change.key} = ${JSON.stringify(change.value)}`).join(', ')} from the account service`);
    } finally {
      // Change events are delivered asynchronously; leave the guard up until they have passed.
      setTimeout(() => { this.writing--; }, 500);
    }
    return changes.length;
  }

  /** The values to push for a configuration change event; empty when the change was this class's own write. */
  changedKeys(event: vscode.ConfigurationChangeEvent, config: ServiceConfig): Record<string, unknown> {
    if (this.writing) { return {}; }
    const values: Record<string, unknown> = {};
    const configuration = vscode.workspace.getConfiguration();
    for (const entry of listConfig(config)) {
      const key = settingKey(entry.key);
      if (!event.affectsConfiguration(key)) { continue; }
      const value = configuration.get<unknown>(key);
      if (value !== undefined && value !== null && JSON.stringify(value) !== JSON.stringify(entry.value)) { values[entry.key] = value; }
    }
    return values;
  }
}
