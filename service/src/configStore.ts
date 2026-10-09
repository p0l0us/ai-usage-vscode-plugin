import { SETTINGS_CATALOG } from './settingsCatalog';
import * as fs from 'fs';
import * as path from 'path';
import { AuthProvider, writeJsonAtomically } from './authFiles';
import { AutomationSettings, RotationStrategy, RotationTrigger, modelWindowFilter } from './accountAutomation';
import { claudeConfigDir } from './live';
import { RpcError } from './rpc';

/**
 * The service's own settings, one block per provider plus the `mcp` block, kept in `config.json`. The VS Code
 * extension mirrors them into its `aiUsage.<provider>.*` and `aiUsage.mcp.*` settings and back; `ai-usage config`
 * reads and writes them directly.
 */

export type UsageSource = 'auto' | 'api' | 'cli' | 'sessionLog' | 'accountFile' | 'both';
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
  autoReset: { enabled: boolean; confirmationRequired: boolean };
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
  { key: 'autoReset.confirmationRequired', type: 'boolean', providers: ['codex'], description: 'Require a connected editor to approve an earned Codex reset before redemption; without approval no credit is redeemed.' },
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
    enabled: true, source: 'auto', accountFile: { checkIntervalSeconds: 15 }, proxy: { enabled: false, port: 43117 },
    cliPath: provider,
    checkIntervalMinutes: 30,
    api: { minIntervalSeconds: 30 },
    keepAlive: { enabled: false, periodHours: claude ? 2 : 6, model: claude ? 'haiku' : 'gpt-5.6-luna', home: `~/.${provider}-tmp` },
    autoReset: { enabled: !claude, confirmationRequired: false },
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
    resetConfirmationRequired: provider === 'codex' && own.autoReset.confirmationRequired,
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

// --- config authority: revisions, scopes and the owner's writes -------------------------------------------------

/**
 * What a setting governs. `engine` settings drive the service; `presentation` ones are stored and shared for clients
 * but change nothing in the engine; `local` ones are an editor's own integration choices (whether and how it
 * connects) that clients never patch; `workspace` ones are a global default that each connection may override in
 * its workspace context.
 */
export type SettingScope = 'engine' | 'presentation' | 'local' | 'workspace';

const LOCAL_KEYS = new Set(['accountService.enabled', 'accountService.background']);
const WORKSPACE_KEYS = new Set(['bridge.codex.sessionDirectory', 'bridge.claude.sessionDirectory']);
const PRESENTATION_KEYS = new Set(['chatTokens.enabled', 'updateIntervalMinutes', 'refreshIntervalMinutes', 'accounts',
  'claude.statusBar.accountNumber', 'codex.statusBar.accountNumber', 'codex.switchRestartHint',
  'claude.advanced.rotationDiagnostics', 'codex.advanced.rotationDiagnostics']);

export function settingScope(dotted: string): SettingScope {
  if (LOCAL_KEYS.has(dotted)) { return 'local'; }
  if (WORKSPACE_KEYS.has(dotted)) { return 'workspace'; }
  if (PRESENTATION_KEYS.has(dotted) || dotted.startsWith('statusBar.') || dotted.startsWith('chatChips.')) { return 'presentation'; }
  return 'engine';
}

/** Every dotted key a client can address, in `listConfig` order. */
export function configKeys(): string[] {
  return listConfig(defaultConfig()).map((entry) => entry.key);
}

export type ConfigView = { config: ServiceConfig; revision: number; revisions: Record<string, number>; scopes: Record<string, SettingScope> };
export type ConfigPatchResult = { config: ServiceConfig; revision: number; changed: string[] };

/** A rejected configuration change; `code` and `data` travel to the client with the error. */
export class ConfigError extends RpcError {
  constructor(message: string, code: 'config-conflict' | 'config-local-setting' | 'config-invalid', readonly data?: Record<string, unknown>) { super(message, code); }
}

type ConfigDocument = { config: ServiceConfig; revision: number; revisions: Record<string, number> };

function readDocument(file: string): { document?: ConfigDocument; missing: boolean; invalid: boolean; raw?: Record<string, unknown> } {
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (error) { return { missing: (error as NodeJS.ErrnoException).code === 'ENOENT', invalid: false }; }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return { missing: false, invalid: true }; }
  if (!isObject(parsed)) { return { missing: false, invalid: true }; }
  const revision = typeof parsed.revision === 'number' && Number.isInteger(parsed.revision) && parsed.revision >= 0 ? parsed.revision : 0;
  const revisions: Record<string, number> = {};
  if (isObject(parsed.revisions)) {
    for (const [key, value] of Object.entries(parsed.revisions)) {
      if (typeof value === 'number' && Number.isInteger(value) && value >= 0) { revisions[key] = Math.min(value, revision); }
    }
  }
  return { document: { config: normalizeConfig(parsed), revision, revisions }, missing: false, invalid: false, raw: parsed };
}

function changedKeys(before: ServiceConfig, after: ServiceConfig): string[] {
  const keys: string[] = [];
  const old = new Map(listConfig(before).map((entry) => [entry.key, JSON.stringify(entry.value)]));
  for (const entry of listConfig(after)) {
    if (old.get(entry.key) !== JSON.stringify(entry.value)) { keys.push(entry.key); }
  }
  return keys;
}

export type ConfigAuthorityOptions = {
  log?: (message: string) => void;
  /** Throws when this process may not write the file (it lost the home's lease); checked before every write. */
  assertWritable?: () => void;
  /** Values for keys the file does not have yet (a first run); existing settings are never replaced by them. */
  seed?: Record<string, unknown>;
  /** Persist the seed (and a missing file) right away; only the lease owner does. */
  persist?: boolean;
};

/**
 * The engine's persisted configuration. Every key carries the revision that last changed it, so a client's patch
 * made against an older view is refused for exactly the keys someone else changed meanwhile, and a reconnecting
 * client never overwrites them. Only the lease owner writes; before writing it merges a hand edit of the file, and an
 * unparsable file is set aside rather than overwritten.
 */
export class ConfigAuthority {
  private document: ConfigDocument;
  private stamp?: string;
  private invalidFile = false;
  private readonly log: (message: string) => void;

  constructor(private readonly file: string, private readonly options: ConfigAuthorityOptions = {}) {
    this.log = options.log ?? (() => undefined);
    const read = readDocument(file);
    this.document = read.document ?? { config: defaultConfig(), revision: 0, revisions: {} };
    this.invalidFile = read.invalid;
    if (read.invalid) { this.log(`config: ${file} is not valid JSON; using defaults until it is fixed or a setting is changed`); }
    this.stamp = this.fileStamp();
    const seeded = this.seed(options.seed ?? {}, read.raw, read.missing || read.invalid);
    if (options.persist && (seeded.length || read.missing)) { this.write(); }
  }

  get config(): ServiceConfig { return this.document.config; }
  get revision(): number { return this.document.revision; }
  revisionOf(key: string): number { return this.document.revisions[key] ?? 0; }

  view(): ConfigView {
    const scopes: Record<string, SettingScope> = {};
    for (const key of configKeys()) { scopes[key] = settingScope(key); }
    return { config: structuredClone(this.document.config), revision: this.document.revision, revisions: { ...this.document.revisions }, scopes };
  }

  /** Fills keys absent from the raw file with the seed values; returns the keys it filled. */
  private seed(values: Record<string, unknown>, raw: Record<string, unknown> | undefined, everything: boolean): string[] {
    const filled: string[] = [];
    let next = this.document.config;
    for (const [key, value] of Object.entries(values)) {
      const { provider, schema } = resolveKey(key);
      const present = !everything && raw !== undefined && lookup(provider ? raw[provider] : raw, schema.key.split('.')) !== undefined;
      if (present) { continue; }
      try {
        const candidate = setConfigValue(next, key, value);
        if (JSON.stringify(getConfigValue(candidate, key)) !== JSON.stringify(getConfigValue(next, key))) { filled.push(key); }
        next = candidate;
      } catch (error) { this.log(`config: ignored the initial value of ${key}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    if (filled.length) {
      this.document = { ...this.document, config: next };
      this.bump(filled);
      this.log(`config: first values for ${filled.join(', ')}`);
    }
    return filled;
  }

  private fileStamp(): string | undefined {
    try { const stat = fs.statSync(this.file); return `${stat.mtimeMs}:${stat.size}:${stat.ino}`; } catch { return undefined; }
  }

  private bump(keys: string[]): void {
    if (!keys.length) { return; }
    const revision = this.document.revision + 1;
    const revisions = { ...this.document.revisions };
    for (const key of keys) { revisions[key] = revision; }
    this.document = { ...this.document, revision, revisions };
  }

  /**
   * Picks up a hand edit of the file: the keys whose values changed get a new revision. Returns those keys, or
   * undefined when the file did not change (or is unreadable, which keeps the current values).
   */
  reloadIfChanged(): string[] | undefined {
    const stamp = this.fileStamp();
    if (stamp === this.stamp) { return undefined; }
    this.stamp = stamp;
    const read = readDocument(this.file);
    if (read.invalid) {
      if (!this.invalidFile) { this.log(`config: ${this.file} is not valid JSON any more; keeping the current settings`); }
      this.invalidFile = true;
      return undefined;
    }
    this.invalidFile = false;
    if (!read.document) { return undefined; }
    const changed = changedKeys(this.document.config, read.document.config);
    // A file written by an older service lacks revisions; ours stay authoritative and only move forward.
    const revision = Math.max(this.document.revision, read.document.revision);
    this.document = { config: read.document.config, revision, revisions: { ...this.document.revisions, ...read.document.revisions } };
    this.bump(changed);
    return changed;
  }

  /**
   * Applies dotted-key values. With `baseRevision`, a key changed after that revision is a conflict and nothing is
   * applied; without it the change is unconditional (an explicit write by a user). Local settings are refused when
   * `refuseLocal` is set (client patches). Returns the keys whose values actually changed.
   */
  patch(values: Record<string, unknown>, options: { baseRevision?: number; refuseLocal?: boolean; source?: string } = {}): ConfigPatchResult {
    const keys = Object.keys(values);
    if (options.refuseLocal) {
      const local = keys.filter((key) => settingScope(key) === 'local');
      if (local.length) { throw new ConfigError(`${local.join(', ')} ${local.length === 1 ? 'is a' : 'are'} local editor setting${local.length === 1 ? '' : 's'}, not service configuration.`, 'config-local-setting', { keys: local }); }
    }
    // A hand edit made since the last read counts as a change by someone else.
    const external = this.reloadIfChanged();
    if (external?.length) { this.log(`config: merged ${external.join(', ')} edited in ${path.basename(this.file)}`); }
    let next = this.document.config;
    for (const [key, value] of Object.entries(values)) {
      try { next = setConfigValue(next, key, value); }
      catch (error) { throw new ConfigError(error instanceof Error ? error.message : String(error), 'config-invalid', { keys: [key] }); }
    }
    if (options.baseRevision !== undefined) {
      // A key already holding the requested value is no conflict: both sides agree.
      const stale = keys.filter((key) => this.revisionOf(key) > options.baseRevision!
        && JSON.stringify(getConfigValue(this.document.config, key)) !== JSON.stringify(getConfigValue(next, key)));
      if (stale.length) {
        const current: Record<string, unknown> = {};
        for (const key of stale) { current[key] = getConfigValue(this.document.config, key); }
        throw new ConfigError(`${stale.join(', ')} changed since revision ${options.baseRevision} (now ${this.document.revision}); read the configuration again.`,
          'config-conflict', { revision: this.document.revision, keys: stale, values: current });
      }
    }
    const changed = keys.filter((key) => JSON.stringify(getConfigValue(this.document.config, key)) !== JSON.stringify(getConfigValue(next, key)));
    if (!changed.length) { return { config: this.document.config, revision: this.document.revision, changed }; }
    const previous = this.document;
    this.document = { ...this.document, config: next };
    this.bump(changed);
    try { this.write(); }
    catch (error) { this.document = previous; throw error; }
    return { config: this.document.config, revision: this.document.revision, changed };
  }

  /** Writes the document atomically; an unparsable file on disk is set aside first, never overwritten. */
  private write(): void {
    this.options.assertWritable?.();
    if (this.invalidFile) {
      const aside = `${this.file}.invalid-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      try { fs.renameSync(this.file, aside); this.log(`config: kept the unreadable ${path.basename(this.file)} as ${path.basename(aside)}`); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; } }
      this.invalidFile = false;
    }
    writeJsonAtomically(this.file, { ...this.document.config, revision: this.document.revision, revisions: this.document.revisions } as unknown as Record<string, unknown>);
    this.stamp = this.fileStamp();
  }
}
