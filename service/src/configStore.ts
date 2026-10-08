import { SETTINGS_CATALOG } from './settingsCatalog';
import * as fs from 'fs';
import * as path from 'path';
import { AuthProvider, writeJsonAtomically } from './authFiles';
import { AutomationSettings, RotationStrategy, RotationTrigger, modelWindowFilter } from './accountAutomation';
import { claudeConfigDir } from './live';

/**
 * The service's own settings, one block per provider plus the `mcp` block, kept in `config.json`. The VS Code
 * extension mirrors them into its `aiUsage.<provider>.*` and `aiUsage.mcp.*` settings and back; `ai-usage config`
 * reads and writes them directly.
 */

export type UsageSource = 'api' | 'cli' | 'sessionLog' | 'accountFile' | 'both';
export type CopilotConfig = { enabled: boolean; source: UsageSource; account: string; checkIntervalMinutes: number };
export type BridgeBackendConfig = { executable: string; persistSessions: boolean; openInCli: boolean; openInExtension: boolean; sessionDirectory: string; subagentsEnabled: boolean; requestTimeoutMinutes: number; toolTimeoutMinutes: number };
export type BridgeConfig = { modelsEnabled: boolean; autoStart: boolean; url: string; tokenFile: string; codex: BridgeBackendConfig; claude: BridgeBackendConfig };

export type ModelLimits = 'auto' | 'always' | 'never';

export type ProviderConfig = {
  enabled: boolean;
  source: UsageSource;
  accountFile: { checkIntervalSeconds: number };
  proxy: { enabled: boolean; port: number };
  /** Command or full path of the vendor CLI, for keep-alives, sign-ins and usage reads. */
  cliPath: string;
  /** Spacing of service endpoint calls, and the pause after a transient error, in minutes. */
  checkIntervalMinutes: number;
  api: {
    /** Smallest gap between two calls to the usage endpoint, across every account and client (Claude). */
    minIntervalSeconds: number;
  };
  keepAlive: {
    enabled: boolean;
    periodHours: number;
    model: string;
    /** Dedicated CLI home for background checks; must be separate from the native CLI home. */
    home: string;
  };
  autoReset: { enabled: boolean };
  autoRotate: {
    enabled: boolean;
    resetAware: boolean;
    fiveHourThresholdPercent: number;
    weeklyThresholdPercent: number;
    modelLimits: ModelLimits;
    strategy: RotationStrategy;
    trigger: RotationTrigger;
    minStayMinutes: number;
  };
};

/** The MCP server for AI agents (`ai-usage mcp`); experimental and off by default. */
export type McpConfig = {
  /** Serve the tools at all: the command, and the server the extension offers to the agents of a VS Code window. */
  enabled: boolean;
  /** Offer the tools that change the active account (switch_account, rotate_account), not only the usage tools. */
  switching: boolean;
};

/** Where new profiles may be kept: privately in the service home, or in an open project's folder. */
export type ProfileScopesConfig = {
  privateProfiles: { enabled: boolean };
  projectProfiles: { enabled: boolean; file: string };
};

/** The usage history: readings, switches and sweeps appended to month files for later analysis. */
export type HistoryConfig = {
  enabled: boolean;
  retentionDays: number;
  /** Where the files go; empty is `usage-history` under the service home. */
  directory: string;
};

export type ServiceConfig = { version: 1; copilot: CopilotConfig; bridge: BridgeConfig; claude: ProviderConfig; codex: ProviderConfig; mcp: McpConfig; history: HistoryConfig } & ProfileScopesConfig;

import { DEFAULT_PROJECT_PROFILES_FILE, PROVIDERS, TITLES } from './profileStore';

export type SettingType = 'boolean' | 'number' | 'integer' | 'string' | 'enum' | 'array';
export type ConfigValue = boolean | number | string | null | unknown[];
export type SettingSchema = {
  /** Path below the provider, such as `autoRotate.strategy`. */
  key: string;
  type: SettingType;
  nullable?: boolean;
  default?: ConfigValue;
  values?: string[];
  min?: number;
  max?: number;
  /** Providers the setting applies to; every provider when omitted. */
  providers?: AuthProvider[];
  description: string;
};

/** Every setting a client can read or change, in the order `ai-usage config` lists them. */
export const SETTINGS: SettingSchema[] = [
  { key: 'keepAlive.enabled', type: 'boolean', description: 'Periodically send a small prompt with every saved account and record the usage it reports.' },
  { key: 'keepAlive.periodHours', type: 'number', min: 0.25, max: 168, description: 'Hours between two keep-alives of one account.' },
  { key: 'keepAlive.model', type: 'string', description: 'Subscription model used for the keep-alive prompt; empty for the CLI default (Codex).' },
  { key: 'keepAlive.home', type: 'string', description: 'Dedicated CLI home for background checks; ~ is expanded. Must not be the native CLI home.' },
  { key: 'autoRotate.enabled', type: 'boolean', description: 'Switch the active account automatically once it reaches a rotation threshold.' },
  { key: 'autoReset.enabled', type: 'boolean', providers: ['codex'], description: 'Automatically redeem an available earned Codex rate-limit reset when it is more useful than rotating or waiting.' },
  { key: 'autoRotate.resetAware', type: 'boolean', providers: ['codex'], description: 'Avoid automatic switches in the five minutes before a Codex usage window resets; reconsider after the reset.' },
  { key: 'autoRotate.fiveHourThresholdPercent', type: 'number', min: 1, max: 100, description: 'Rotate when the 5-hour window reaches this percentage; a candidate must be below it.' },
  { key: 'autoRotate.weeklyThresholdPercent', type: 'number', min: 1, max: 100, description: 'Rotate when a weekly window reaches this percentage; a candidate must be below it.' },
  { key: 'autoRotate.modelLimits', type: 'enum', values: ['auto', 'always', 'never'], providers: ['claude'], description: 'Whether the model-scoped weekly window (7d Fable) counts: auto follows Claude Code\'s configured model.' },
  { key: 'autoRotate.strategy', type: 'enum', values: ['soonestReset', 'evenPace', 'leastWaste', 'sequential'], description: 'How the next account is chosen.' },
  { key: 'autoRotate.trigger', type: 'enum', values: ['limit', 'proactive'], description: 'limit switches only at a threshold; proactive also switches to a clearly better account.' },
  { key: 'autoRotate.minStayMinutes', type: 'number', min: 5, max: 10080, description: 'With the proactive trigger, how long a newly active account is kept.' },
  { key: 'cliPath', type: 'string', description: 'Command or full path of the vendor CLI.' },
  { key: 'checkIntervalMinutes', type: 'number', min: 0.25, max: 1440, description: 'Spacing of usage endpoint calls and the pause after a transient error, in minutes; Claude accepts a quarter minute, Codex at least one.' },
  { key: 'api.minIntervalSeconds', type: 'number', min: 0, max: 600, providers: ['claude'], description: 'Smallest gap between two calls to the Claude usage endpoint, across all accounts and clients.' }
];

/** Settings outside the provider blocks, addressed by their key alone (`mcp.enabled`), listed after the others. */
export const GLOBAL_SETTINGS: SettingSchema[] = [
  { key: 'privateProfiles.enabled', type: 'boolean', description: 'Keep new profiles privately in the service home (profiles.json). Off only stops new private profiles; saved ones stay.' },
  { key: 'projectProfiles.enabled', type: 'boolean', description: 'Also load and save profiles in each open project folder\'s profile file, login included, so they travel with the project.' },
  { key: 'projectProfiles.file', type: 'string', description: 'Path of a project\'s profile file, relative to the folder (default .ai-usage.profiles.json); it has the format of a profile export.' },
  { key: 'history.enabled', type: 'boolean', description: 'Record every reading, switch, rotation sweep, exhausted stretch and check change to month files for later analysis.' },
  { key: 'history.retentionDays', type: 'number', min: 1, max: 36500, description: 'Delete a month\'s history file once the whole month is older than this many days.' },
  { key: 'history.directory', type: 'string', description: 'Where the history files go; empty is usage-history under the service home. ~ is expanded.' },
  { key: 'mcp.enabled', type: 'boolean', description: 'Experimental. Serve the MCP tools that let an AI agent read every profile\'s usage and switch profiles (ai-usage mcp, and the server VS Code offers to its agents).' },
  { key: 'mcp.switching', type: 'boolean', description: 'Let agents change the active account through MCP (switch_account, rotate_account); off leaves them the usage tools only.' }
];

for (const entry of SETTINGS_CATALOG) {
  const [provider, ...rest] = entry.key.split('.');
  const covered = (provider === 'claude' || provider === 'codex') && SETTINGS.some(setting =>
    setting.key === rest.join('.') && (!setting.providers || setting.providers.includes(provider)));
  if (!covered && !GLOBAL_SETTINGS.some(setting => setting.key === entry.key)) {
    GLOBAL_SETTINGS.push(entry as SettingSchema);
  }
}

export function defaultProviderConfig(provider: AuthProvider): ProviderConfig {
  const claude = provider === 'claude';
  return {
    enabled: true, source: 'both', accountFile: { checkIntervalSeconds: 15 }, proxy: { enabled: false, port: 43117 },
    cliPath: provider,
    checkIntervalMinutes: claude ? 10 : 5,
    api: { minIntervalSeconds: 30 },
    keepAlive: { enabled: false, periodHours: claude ? 2 : 6, model: claude ? 'haiku' : 'gpt-5.6-luna', home: `~/.${provider}-tmp` },
    autoReset: { enabled: !claude },
    autoRotate: {
      enabled: false,
      resetAware: !claude,
      // Codex defaults to rotating on a used-up 5-hour window only.
      fiveHourThresholdPercent: claude ? 95 : 100,
      weeklyThresholdPercent: claude ? 99.5 : 99,
      modelLimits: 'auto',
      strategy: claude ? 'soonestReset' : 'sequential',
      trigger: 'limit',
      minStayMinutes: 30
    }
  };
}

export function defaultConfig(): ServiceConfig {
  const config = { version: 1, claude: defaultProviderConfig('claude'), codex: defaultProviderConfig('codex'), mcp: { enabled: false, switching: true },
    privateProfiles: { enabled: true }, projectProfiles: { enabled: true, file: DEFAULT_PROJECT_PROFILES_FILE },
    history: { enabled: true, retentionDays: 365, directory: '' } } as ServiceConfig;
  for (const entry of SETTINGS_CATALOG) {
    if (entry.default !== undefined) { assign(config as unknown as Record<string, unknown>, entry.key.split('.'), structuredClone(entry.default)); }
  }
  return config;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function lookup(root: unknown, keyPath: string[]): unknown {
  let current: unknown = root;
  for (const key of keyPath) {
    if (!isObject(current)) { return undefined; }
    current = current[key];
  }
  return current;
}

function assign(root: Record<string, unknown>, keyPath: string[], value: unknown): void {
  let current = root;
  for (const key of keyPath.slice(0, -1)) {
    if (!isObject(current[key])) { current[key] = {}; }
    current = current[key] as Record<string, unknown>;
  }
  current[keyPath[keyPath.length - 1]] = value;
}

export function settingSchema(key: string): SettingSchema | undefined {
  return SETTINGS.find((setting) => setting.key === key);
}

/** The block a setting lives in: the provider's, or the whole config for a global setting. */
function blockOf(config: ServiceConfig, provider: AuthProvider | undefined): Record<string, unknown> {
  return (provider ? config[provider] : config) as unknown as Record<string, unknown>;
}

/** Turns a raw value (a string from the command line, or JSON from a client) into the setting's type, or throws. */
export function coerceSetting(schema: SettingSchema, raw: unknown): ConfigValue {
  if (schema.nullable && (raw === null || raw === 'null')) { return null; }
  switch (schema.type) {
    case 'boolean': {
      if (typeof raw === 'boolean') { return raw; }
      const text = String(raw).trim().toLowerCase();
      if (['true', 'on', 'yes', '1'].includes(text)) { return true; }
      if (['false', 'off', 'no', '0'].includes(text)) { return false; }
      throw new Error(`${schema.key} expects true or false, not "${String(raw)}".`);
    }
    case 'integer':
    case 'number': {
      const value = typeof raw === 'number' ? raw : Number(String(raw).trim());
      if (!Number.isFinite(value)) { throw new Error(`${schema.key} expects a number, not "${String(raw)}".`); }
      if (schema.type === 'integer' && !Number.isInteger(value)) { throw new Error(`${schema.key} expects an integer.`); }
      if (schema.min !== undefined && value < schema.min) { throw new Error(`${schema.key} must be at least ${schema.min}.`); }
      if (schema.max !== undefined && value > schema.max) { throw new Error(`${schema.key} must be at most ${schema.max}.`); }
      return value;
    }
    case 'array': {
      const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (!Array.isArray(value)) { throw new Error(`${schema.key} expects a JSON array.`); }
      return structuredClone(value);
    }
    case 'enum': {
      const value = String(raw).trim();
      if (!schema.values?.includes(value)) { throw new Error(`${schema.key} must be one of ${schema.values?.join(', ')}, not "${value}".`); }
      return value;
    }
    default:
      return String(raw ?? '');
  }
}

/** Merges a parsed file over the defaults, keeping only known keys with valid values. */
export function normalizeConfig(parsed: unknown): ServiceConfig {
  const config = defaultConfig();
  if (!isObject(parsed)) { return config; }
  for (const provider of PROVIDERS) {
    const block = parsed[provider];
    if (!isObject(block)) { continue; }
    for (const schema of SETTINGS) {
      if (schema.providers && !schema.providers.includes(provider)) { continue; }
      const raw = lookup(block, schema.key.split('.'));
      if (raw === undefined || (raw === null && !schema.nullable)) { continue; }
      try { assign(config[provider] as unknown as Record<string, unknown>, schema.key.split('.'), coerceSetting(schema, raw)); }
      catch { /* An invalid value keeps the default. */ }
    }
  }
  for (const schema of GLOBAL_SETTINGS) {
    const raw = lookup(parsed, schema.key.split('.'));
    if (raw === undefined || (raw === null && !schema.nullable)) { continue; }
    try { assign(blockOf(config, undefined), schema.key.split('.'), coerceSetting(schema, raw)); }
    catch { /* An invalid value keeps the default. */ }
  }
  return config;
}

export function loadConfig(file: string): ServiceConfig {
  try { return normalizeConfig(JSON.parse(fs.readFileSync(file, 'utf8'))); }
  catch { return defaultConfig(); }
}

export function saveConfig(file: string, config: ServiceConfig): void {
  writeJsonAtomically(file, config);
}

/** `claude.autoRotate.strategy` or `mcp.enabled` → its value; throws for an unknown key. */
export function getConfigValue(config: ServiceConfig, dotted: string): ConfigValue {
  const { provider, schema } = resolveKey(dotted);
  return lookup(blockOf(config, provider), schema.key.split('.')) as ConfigValue;
}

/** Returns a copy of `config` with the value set; throws for an unknown key or an invalid value. */
export function setConfigValue(config: ServiceConfig, dotted: string, raw: unknown): ServiceConfig {
  const { provider, schema } = resolveKey(dotted);
  const next = structuredClone(config);
  assign(blockOf(next, provider), schema.key.split('.'), coerceSetting(schema, raw));
  return next;
}

/** A provider setting (`claude.…`, `codex.…`) with its provider, or a global one (`mcp.…`) without. */
export function resolveKey(dotted: string): { provider?: AuthProvider; schema: SettingSchema } {
  const global = GLOBAL_SETTINGS.find((setting) => setting.key === dotted);
  if (global) { return { schema: global }; }
  const [provider, ...rest] = dotted.split('.');
  if (provider !== 'claude' && provider !== 'codex') {
    throw new Error(`Unknown setting "${dotted}": settings start with claude. or codex., or are one of ${GLOBAL_SETTINGS.map((setting) => setting.key).join(', ')}.`);
  }
  const schema = settingSchema(rest.join('.'));
  if (!schema) { throw new Error(`Unknown setting "${dotted}". Run "ai-usage config" for the list.`); }
  if (schema.providers && !schema.providers.includes(provider)) { throw new Error(`"${dotted}" does not apply to ${TITLES[provider]}.`); }
  return { provider, schema };
}

/** Every applicable dotted key with its value, in schema order, Claude first, then the global settings. */
export function listConfig(config: ServiceConfig): Array<{ key: string; value: ConfigValue; schema: SettingSchema }> {
  const entries: Array<{ key: string; value: ConfigValue; schema: SettingSchema }> = [];
  for (const provider of PROVIDERS) {
    for (const schema of SETTINGS) {
      if (schema.providers && !schema.providers.includes(provider)) { continue; }
      entries.push({ key: `${provider}.${schema.key}`, value: lookup(config[provider], schema.key.split('.')) as ConfigValue, schema });
    }
  }
  for (const schema of GLOBAL_SETTINGS) {
    entries.push({ key: schema.key, value: lookup(config, schema.key.split('.')) as ConfigValue, schema });
  }
  return entries;
}

/** The model Claude Code is configured to use (its user settings `model`), or undefined when unset or unreadable. */
export function claudeCodeModel(): string | undefined {
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(claudeConfigDir(), 'settings.json'), 'utf8'));
    return typeof settings?.model === 'string' && settings.model.trim() ? settings.model.trim() : undefined;
  } catch { return undefined; }
}

/** What the automation runs with; intervals are bounded even for a hand-edited file. */
export function automationSettings(config: ServiceConfig, provider: AuthProvider): AutomationSettings {
  const own = config[provider];
  const claude = provider === 'claude';
  const clampPercent = (value: number, fallback: number) => Number.isFinite(value) ? Math.min(100, Math.max(1, value)) : fallback;
  return {
    enabled: own.keepAlive.enabled,
    autoRotate: own.autoRotate.enabled,
    autoReset: provider === 'codex' && own.autoReset.enabled,
    fiveHourThresholdPercent: clampPercent(own.autoRotate.fiveHourThresholdPercent, claude ? 95 : 100),
    weeklyThresholdPercent: clampPercent(own.autoRotate.weeklyThresholdPercent, claude ? 99.5 : 99),
    countsWindow: modelWindowFilter(own.autoRotate.modelLimits, claude ? claudeCodeModel() : undefined),
    strategy: own.autoRotate.strategy,
    trigger: own.autoRotate.trigger === 'proactive' ? 'proactive' : 'limit',
    resetAware: provider === 'codex' && own.autoRotate.resetAware,
    minStayMs: Math.max(5, own.autoRotate.minStayMinutes) * 60_000,
    intervalMs: Math.max(0.25, own.keepAlive.periodHours) * 3_600_000,
    // Claude accepts a quarter minute: every endpoint call is spaced by the shared budget regardless.
    checkIntervalMs: Math.max(claude ? 0.25 : 1, own.checkIntervalMinutes) * 60_000,
    home: own.keepAlive.home,
    cliPath: own.cliPath,
    model: own.keepAlive.model
  };
}

/** One line describing the rotation setup, as the Accounts menu and `ai-usage status` show it. */
export function strategySummary(config: ServiceConfig, provider: AuthProvider): string {
  const own = config[provider].autoRotate;
  const thresholds = `5h ≥ ${own.fiveHourThresholdPercent}%, 7d ≥ ${own.weeklyThresholdPercent}%`;
  return `${own.strategy}, ${own.trigger}, ${thresholds}${provider === 'codex' && own.resetAware ? ', reset-aware' : ''}`;
}

/** The config file inside a service home. */
export function configFileOf(home: string): string {
  return path.join(home, 'config.json');
}
