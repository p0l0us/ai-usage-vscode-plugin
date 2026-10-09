import type { Readable, Writable } from 'stream';
import type { StatusCursor, StatusFilter, StatusRead } from './statusProjection';
import type { ServiceConfig } from './configStore';
import type { AuthProvider } from './authFiles';
import { readableProblem } from './accountProbe';
import type { ServiceClient } from './client';
import { formatResetRemaining } from './live';
import type { UsageStateView } from './usageMonitor';
import { PROVIDERS, TITLES } from './profileStore';
import type { RequestOptions, ProfileView, ProviderView, SerializedUsage, SerializedWindow } from './protocol';

/**
 * The MCP server behind `ai-usage mcp`: JSON-RPC 2.0 over stdin and stdout, one message per line, with the tools
 * an AI agent needs to read every saved profile's usage and, when allowed, switch the active account. Experimental,
 * and off until the `mcp.enabled` setting is on; every tool call checks the setting again, so turning it off takes
 * effect at once for a server that is already running. Written without an MCP SDK: the handful of methods used here
 * is small, and the service package has no dependencies.
 */

export const MCP_SERVER_NAME = 'ai-usage';
/** Newest first; a client's choice is echoed when it is one of these, otherwise the newest is offered. */
export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

export type JsonRpcNotification = { jsonrpc: '2.0'; method: 'notifications/resources/updated'; params: { uri: string } };

type JsonRpcId = number | string | null;
type JsonRpcRequest = { jsonrpc?: string; id?: JsonRpcId; method?: unknown; params?: unknown };
export type JsonRpcResponse = { jsonrpc: '2.0'; id: JsonRpcId; result?: unknown; error?: { code: number; message: string } };

/** A protocol-level failure: the request itself was wrong. A failed tool is a tool result with `isError` instead. */
class McpError extends Error {
  constructor(readonly code: number, message: string) { super(message); }
}

const INSTRUCTIONS = [
  'Tools of the shared AI Usage account service for Claude Code and Codex subscriptions.',
  'Start with list_accounts, which includes a live read-only rotationPolicy for both subscriptions even when service filters the account rows.',
  'An occasional deliberate switch_account is allowed while built-in rotation is enabled, but that policy may select a different account later.',
  'Before sustained AI-agent-managed account selection, ASK THE USER for permission to disable every competing built-in automatic rotation',
  'for the providers you will manage: claude.autoRotate.enabled and/or codex.autoRotate.enabled. Managing both requires both settings false.',
  'Never silently change settings, treat MCP switching permission as permission to disable rotation, or claim exclusive account control.',
  'After the user changes approved settings, re-read rotationPolicy before starting and before later decisions; stop and ask again if competing rotation is enabled.',
  'These tools do not provide a configuration-write tool or autonomous loop. Cached status resources support subscribe/unsubscribe notifications; get_usage_status and bounded wait_for_usage_updates work with tools-only hosts. The host must read/forward updates and arrange model execution; notifications never guarantee automatic model wake-up.',
  "switch_account selects the profile you chose; rotate_account invokes the engine's configured deterministic selection policy once, even when scheduled rotation is disabled.",
  'usedPercent is used quota, not remaining quota. Require fresh readings attributed to the candidate account; refresh_usage reads a saved candidate or the native active login.',
  'Unknown, stale, expired or failed readings do not prove spare capacity. General 5h/weekly quota is a hard capacity gate; configured rotation thresholds are policy cutoffs, not proof that all quota is exhausted.',
  'Model-scoped limits apply to that model only. Prefer a generally eligible account with headroom for the intended model.',
  'If every generally eligible Claude account lacks Fable headroom, a generally eligible fallback may remain selected, but Fable remains limited:',
  'never select a generally exhausted account solely for Fable headroom, claim Fable quota was restored, or switch the model.',
  'Keep an already generally eligible active fallback when no model-capable alternative exists instead of oscillating among model-limited accounts.',
  "Keep-alive uses isolated checks and can consume quota; Codex earned resets replenish the active account's quota and may require editor approval. Neither is another automatic account selector.",
  'Claude reads a switched login on its next turn; an already-running Codex session needs the account proxy or a restart to adopt it.',
  'Say which account changed and report any verification warning.'
].join(' ');

const SERVICE_PARAM = { type: 'string', enum: ['claude', 'codex'], description: 'The subscription: claude (Claude Code) or codex.' };
const PROFILE_PARAM = { type: 'string', description: 'The saved profile: its name, 1-based number, id or login email, as list_accounts shows them.' };

export type ToolDefinition = {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: Record<string, unknown>;
  /** Offered and allowed only while `mcp.switching` is on. */
  switching?: boolean;
};

const STATUS_PROPERTIES = {
  providers: { type: 'array', items: { type: 'string', enum: ['claude', 'codex', 'copilot'] }, maxItems: 3, uniqueItems: true },
  accountIds: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 128 }, maxItems: 40, uniqueItems: true },
  since: { type: 'object', properties: { epoch: { type: 'string', minLength: 1, maxLength: 128 }, revision: { type: 'integer', minimum: 0 } }, required: ['epoch', 'revision'], additionalProperties: false }
};

export const TOOLS: ToolDefinition[] = [
  {
    name: 'list_accounts', title: 'List accounts',
    description: 'Every saved Claude Code and Codex profile with its last usage reading: the 5-hour and weekly windows as percent used with their reset times, when it was read, whether the profile is active, usable, at a limit or has a login problem, and whether keep-alive and rotation are on. Includes the current native login even when unsaved, its freshness and model-scoped limits. The shared engine may collect a reading when its cache is due; use refresh_usage to request one now. Pass service to limit the account rows; rotationPolicy still exposes exact current settings for both subscriptions and the user-approval prerequisites for sustained agent-managed selection.',
    inputSchema: { type: 'object', properties: { service: SERVICE_PARAM }, additionalProperties: false },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  },
  {
    name: 'refresh_usage', title: 'Refresh usage',
    description: 'Reads usage now, without sending a prompt. Omit profile to read the native active login, including an unsaved account; supply profile for a saved candidate. Costs an endpoint call. Reports freshness and model limits; does not change the account or model.',
    inputSchema: { type: 'object', properties: { service: SERVICE_PARAM, profile: PROFILE_PARAM }, required: ['service'], additionalProperties: false },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true }
  },
  {
    name: 'switch_account', title: 'Switch account', switching: true,
    description: 'Makes a saved profile the active login of that CLI (Claude Code or Codex). Changes the login account only; it does not select or change a model. Every new CLI command uses the new login. Claude reads it on its next turn; an already-running Codex session needs the account proxy or a restart to adopt it. Choose using fresh attributed usage and general/model quota. Occasional deliberate switches remain allowed with built-in rotation enabled; it may later override this choice. Sustained agent-managed selection first requires asking the user to disable competing automatic rotation for every managed provider and re-reading rotationPolicy. Returns the service\'s own message and whether the account in use actually changed.',
    inputSchema: { type: 'object', properties: { service: SERVICE_PARAM, profile: PROFILE_PARAM }, required: ['service', 'profile'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  {
    name: 'rotate_account', title: 'Rotate account', switching: true,
    description: 'Invokes the engine\'s configured deterministic rotation policy once, even when scheduled automatic rotation is off. This does not install an AI-agent selection loop: it switches to the best candidate by the configured strategy only when the active account is at a threshold (or, with the proactive trigger, when a clearly better one exists). Nothing happens when the active account is fine; the answer says why.',
    inputSchema: { type: 'object', properties: { service: SERVICE_PARAM }, required: ['service'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  },
  {
    name: 'get_usage_status', title: 'Read cached usage status',
    description: 'Cached toolbar usage, total saved-account counts, every filtered saved account, separate native login and per-Codex-account reset credits with explicit known/stale/unknown states. No provider calls. Includes live rotationPolicy for both providers. Optional since cursor returns unchanged when the global revision is unchanged; a new epoch requires full resync.',
    inputSchema: { type: 'object', properties: STATUS_PROPERTIES, additionalProperties: false },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  },
  {
    name: 'wait_for_usage_updates', title: 'Wait for cached usage updates',
    description: 'Wait at most 30 seconds for an engine status revision after the required epoch/revision cursor, then return cached status or unchanged. One pending wait per MCP connection. Global revisions may concern another provider; filters limit disclosed rows. Cancel via notifications/cancelled. No provider calls, account changes, replay history or automatic model wake-up; the host must arrange later waits and model execution.',
    inputSchema: { type: 'object', properties: { ...STATUS_PROPERTIES, timeoutSeconds: { type: 'integer', minimum: 1, maximum: 30, default: 25 } }, required: ['since'], additionalProperties: false },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }
];

export type RotationPolicy = {
  observedAt: string;
  settings: Record<string, boolean | number | string>;
  managedProviderPrerequisites: Record<AuthProvider, { setting: string; currentlyDisabled: boolean }>;
  allBuiltInRotationDisabled: boolean;
  userApprovalRequiredForSettingsChanges: true;
  exclusiveAccountControlGuaranteed: false;
  automaticActions: {
    keepAlive: { claude: boolean; codex: boolean; nativeAccountSelection: false; usesIsolatedCliHomes: true; canConsumeQuota: true };
    codexEarnedReset: { enabled: boolean; confirmationRequired: boolean; nativeAccountSelection: false; canSpendCredits: true };
    proxyAndBridge: { selectAccountsAutomatically: false };
  };
  agentScheduling: { continuousSelectionProvided: false; engineEventsForwardedToMcp: true; automaticModelWakeupProvided: false };
};

/** Read-only facts from engine configuration; no credentials, filesystem reads or policy mutations. */
export function rotationPolicy(config: ServiceConfig, now: Date): RotationPolicy {
  const settings: RotationPolicy['settings'] = { 'mcp.enabled': config.mcp.enabled, 'mcp.switching': config.mcp.switching };
  for (const provider of PROVIDERS) {
    const own = config[provider];
    settings[`${provider}.enabled`] = own.enabled;
    settings[`${provider}.checkIntervalMinutes`] = own.checkIntervalMinutes;
    settings[`${provider}.keepAlive.enabled`] = own.keepAlive.enabled;
    for (const key of ['enabled', 'strategy', 'trigger', 'fiveHourThresholdPercent', 'weeklyThresholdPercent', 'minStayMinutes'] as const) {
      settings[`${provider}.autoRotate.${key}`] = own.autoRotate[key];
    }
  }
  settings['claude.autoRotate.modelLimits'] = config.claude.autoRotate.modelLimits;
  settings['codex.autoRotate.resetAware'] = config.codex.autoRotate.resetAware;
  settings['codex.autoReset.enabled'] = config.codex.autoReset.enabled;
  settings['codex.autoReset.confirmationRequired'] = config.codex.autoReset.confirmationRequired;
  const claudeDisabled = !config.claude.autoRotate.enabled;
  const codexDisabled = !config.codex.autoRotate.enabled;
  return { observedAt: now.toISOString(), settings,
    managedProviderPrerequisites: {
      claude: { setting: 'claude.autoRotate.enabled', currentlyDisabled: claudeDisabled },
      codex: { setting: 'codex.autoRotate.enabled', currentlyDisabled: codexDisabled }
    },
    allBuiltInRotationDisabled: claudeDisabled && codexDisabled, userApprovalRequiredForSettingsChanges: true,
    exclusiveAccountControlGuaranteed: false,
    automaticActions: {
      keepAlive: { claude: config.claude.keepAlive.enabled, codex: config.codex.keepAlive.enabled,
        nativeAccountSelection: false, usesIsolatedCliHomes: true, canConsumeQuota: true },
      codexEarnedReset: { enabled: config.codex.autoReset.enabled, confirmationRequired: config.codex.autoReset.confirmationRequired,
        nativeAccountSelection: false, canSpendCredits: true },
      proxyAndBridge: { selectAccountsAutomatically: false }
    },
    agentScheduling: { continuousSelectionProvided: false, engineEventsForwardedToMcp: true, automaticModelWakeupProvided: false }
  };
}
function rotationPolicyText(policy: RotationPolicy): string {
  return `Built-in automatic account rotation: claude.autoRotate.enabled=${policy.settings['claude.autoRotate.enabled']}; codex.autoRotate.enabled=${policy.settings['codex.autoRotate.enabled']}. ` +
    'Occasional deliberate MCP switches are allowed; enabled built-in rotation may later override them. ' +
    'Before sustained AI-agent-managed selection, ask the user to disable automatic rotation for every managed provider (both settings for both providers), then re-read rotationPolicy. ' +
    'This is a configuration snapshot, not user consent or exclusive account ownership. MCP offers cached status subscriptions and bounded tool waits; the host arranges future calls and model execution. No background agent loop or automatic model wake-up is provided.';
}

type ToolResult = { content: Array<{ type: 'text'; text: string }>; structuredContent?: Record<string, unknown>; isError?: boolean };

export type Freshness = { state: 'fresh' | 'stale' | 'unknown'; ageSeconds?: number; maxAgeSeconds: number };
export type WindowSummary = { label: string; usedPercent: number; resetsAt?: string; resetsIn?: string; scope: 'account' | 'model'; model?: string };

export function readingFreshness(usage: SerializedUsage | undefined, now: Date, maxAgeMs = 60 * 60_000): Freshness {
  const ageMs = usage ? now.getTime() - Date.parse(usage.fetchedAt) : NaN;
  const valid = Boolean(usage?.windows.length) && usage!.windows.every(w => Number.isFinite(w.usedPercent) && w.usedPercent >= 0 && w.usedPercent <= 100);
  const resetExpired = usage?.windows.some(w => w.resetsAt !== undefined && (!Number.isFinite(Date.parse(w.resetsAt)) || Date.parse(w.resetsAt) <= now.getTime()));
  return { state: !valid || !Number.isFinite(ageMs) || ageMs < -60_000 ? 'unknown' : resetExpired || ageMs > maxAgeMs ? 'stale' : 'fresh',
    ...(Number.isFinite(ageMs) ? { ageSeconds: Math.max(0, Math.round(ageMs / 1000)) } : {}), maxAgeSeconds: maxAgeMs / 1000 };
}
export type ActiveUsageSummary = { saved: boolean; profileId?: string; status: 'ok' | 'error' | 'unavailable'; freshness: Freshness;
  modelLimited: boolean; usage?: { fetchedAt: string; plan?: string; windows: WindowSummary[] }; problem?: string };
export function activeUsageSummary(state: UsageStateView, nativeUnsaved: boolean, now: Date, maxAgeMs: number): ActiveUsageSummary {
  const usage = state.result.kind === 'ok' ? state.result.usage : state.lastGood;
  const freshness = readingFreshness(usage, now, maxAgeMs);
  if (state.result.kind !== 'ok' && freshness.state === 'fresh') freshness.state = 'stale';
  const windows = usage?.windows.map(w => windowSummary(w, now));
  return { saved: Boolean(state.profileId) && !nativeUnsaved, profileId: state.profileId, status: state.result.kind, freshness,
    modelLimited: windows?.some(w => w.scope === 'model' && w.usedPercent >= 100) ?? false,
    usage: usage ? { fetchedAt: usage.fetchedAt, plan: usage.plan, windows: windows! } : undefined,
    problem: state.result.kind === 'error' ? state.result.message : state.result.kind === 'unavailable' ? state.result.reason : undefined };
}
export type ProfileSummary = {
  number: number;
  id: string;
  name: string;
  email?: string;
  active: boolean;
  /** A login is stored, its reading is fresh, and neither a counted limit nor a login problem blocks it. */
  usable: boolean;
  loginStored: boolean;
  freshness: Freshness;
  atLimit: boolean;
  /** Only a model-scoped weekly window (such as 7d Fable) is used up; other models still work. */
  modelLimited: boolean;
  loginProblem?: string;
  problems: string[];
  checkedAt?: string;
  usage?: { fetchedAt: string; plan?: string; windows: WindowSummary[] };
};
export type ServiceSummary = {
  service: AuthProvider;
  title: string;
  activeProfile?: { id: string; name: string; number: number };
  /** The native login belongs to no saved profile. */
  nativeUnsaved: boolean;
  activeUsage?: ActiveUsageSummary;
  keepAlive: boolean;
  autoRotate: boolean;
  rotation: string;
  profiles: ProfileSummary[];
};

function windowSummary(window: SerializedWindow, now: Date): WindowSummary {
  const resetsIn = formatResetRemaining(window.resetsAt ? new Date(window.resetsAt) : undefined, now);
  const model = /^(?:5h|7d)\s+(.+)$/i.exec(window.label)?.[1];
  return { label: window.label, usedPercent: window.usedPercent, resetsAt: window.resetsAt, resetsIn: resetsIn || undefined,
    scope: model ? 'model' : 'account', ...(model ? { model } : {}) };
}

export function profileSummary(profile: ProfileView, now: Date, maxAgeMs = 60 * 60_000): ProfileSummary {
  const usage = profile.usage;
  const freshness = readingFreshness(usage, now, maxAgeMs);
  return {
    number: profile.number, id: profile.id, name: profile.name, email: profile.email, active: profile.active,
    usable: profile.hasCredential && !profile.loginProblem && !profile.limit.readOnly && freshness.state === 'fresh',
    loginStored: profile.hasCredential,
    atLimit: profile.limit.readOnly, modelLimited: profile.limit.dimmed, freshness,
    loginProblem: profile.loginProblem ? readableProblem(profile.loginProblem) : undefined,
    problems: profile.problems.map((problem) => problem.label),
    checkedAt: profile.checkedAt,
    usage: usage ? { fetchedAt: usage.fetchedAt, plan: usage.plan, windows: usage.windows.map((window) => windowSummary(window, now)) } : undefined
  };
}

export function serviceSummary(view: ProviderView, now: Date, maxAgeMs = 60 * 60_000): ServiceSummary {
  const active = view.profiles.find((profile) => profile.active);
  return {
    service: view.provider, title: view.title,
    activeProfile: active ? { id: active.id, name: active.name, number: active.number } : undefined,
    nativeUnsaved: view.nativeUnsaved, keepAlive: view.keepAlive, autoRotate: view.autoRotate, rotation: view.strategySummary,
    profiles: view.profiles.map((profile) => profileSummary(profile, now, maxAgeMs))
  };
}

function windowsText(windows: WindowSummary[]): string {
  return windows.map((window) => `${window.label} ${Math.round(window.usedPercent)}%${window.resetsIn ? ` (resets in ${window.resetsIn})` : ''}`).join(' · ');
}

/** One line per profile, readable by a model that gets no structured content. */
export function summaryText(summary: ServiceSummary): string {
  const header = `${summary.title}: active ${summary.activeProfile ? `“${summary.activeProfile.name}” (#${summary.activeProfile.number})` : 'none'}${summary.nativeUnsaved ? ' (the current login is not a saved profile)' : ''} · keep-alive ${summary.keepAlive ? 'on' : 'off'} · rotation ${summary.autoRotate ? `on (${summary.rotation})` : `off (${summary.rotation})`}`;
  const native = summary.activeUsage;
  const nativeLine = native ? `  native active login${summary.nativeUnsaved ? ' (unsaved)' : ''}: ${native.usage ? windowsText(native.usage.windows) : 'no reading'} · ${native.freshness.state}${native.problem ? ` · ${native.problem}` : ''}` : undefined;
  if (!summary.profiles.length) { return [header, nativeLine, '  no saved profiles'].filter(Boolean).join('\n'); }
  const lines = summary.profiles.map((profile) => {
    const state = [profile.active ? 'active' : undefined, profile.atLimit ? 'at its limit' : undefined, profile.modelLimited ? 'model window used up' : undefined,
      profile.loginProblem ? `login problem: ${profile.loginProblem}` : undefined, ...profile.problems.map((problem) => `problem: ${problem}`),
      !profile.loginStored ? 'no login stored' : undefined].filter(Boolean).join(', ');
    const reading = profile.usage ? `${windowsText(profile.usage.windows)} · checked ${profile.checkedAt ?? profile.usage.fetchedAt}` : 'no reading yet';
    return `  #${profile.number} “${profile.name}”${profile.email ? ` ${profile.email}` : ''}${state ? ` [${state}]` : ''}: ${reading} · ${profile.freshness.state}`;
  });
  return [header, nativeLine, ...lines].filter(Boolean).join('\n');
}

function providerArg(value: unknown): AuthProvider {
  if (value === 'claude' || value === 'codex') { return value; }
  throw new McpError(INVALID_PARAMS, 'service must be "claude" or "codex".');
}

function profileArg(value: unknown): string {
  if (typeof value === 'string' && value.trim()) { return value.trim(); }
  throw new McpError(INVALID_PARAMS, 'profile must name a saved profile: its name, number, id or email.');
}

function text(message: string, structuredContent?: Record<string, unknown>, isError = false): ToolResult {
  return { content: [{ type: 'text', text: message }], ...(structuredContent ? { structuredContent } : {}), ...(isError ? { isError } : {}) };
}

class WaitDeadline extends Error {
  constructor() { super('Usage wait deadline elapsed before cached status was available.'); }
}
/** Connect callbacks and test doubles may not accept AbortSignal; cancellation still settles this caller. */
function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const aborted = () => { signal.removeEventListener('abort', aborted); reject(signal.reason); };
    signal.addEventListener('abort', aborted, { once: true });
    pending.then(value => { signal.removeEventListener('abort', aborted); signal.aborted ? reject(signal.reason) : resolve(value); },
      error => { signal.removeEventListener('abort', aborted); reject(error); });
  });
}

const STATUS_URI = 'ai-usage://status';
const STATUS_PROVIDERS = ['claude', 'codex', 'copilot'] as const;
function statusFilter(input: Record<string, unknown>, requireCursor = false): StatusFilter {
  const filter: StatusFilter = {};
  for (const key of ['providers', 'accountIds'] as const) {
    const value = input[key];
    if (value === undefined) continue;
    const limit = key === 'providers' ? 3 : 40;
    if (!Array.isArray(value) || value.length > limit || new Set(value).size !== value.length || value.some(entry =>
      typeof entry !== 'string' || !entry.length || entry.length > 128 || (key === 'providers' && !STATUS_PROVIDERS.includes(entry as typeof STATUS_PROVIDERS[number])))) {
      throw new McpError(INVALID_PARAMS, `Invalid ${key} filter.`);
    }
    if (key === 'providers') filter.providers = value as StatusFilter['providers']; else filter.accountIds = value;
  }
  if (input.since !== undefined) {
    const value = input.since as Partial<StatusCursor>;
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => key !== 'epoch' && key !== 'revision') ||
      typeof value.epoch !== 'string' || !value.epoch.length || value.epoch.length > 128 || !Number.isSafeInteger(value.revision) || value.revision! < 0) {
      throw new McpError(INVALID_PARAMS, 'Invalid status cursor.');
    }
    filter.since = value as StatusCursor;
  } else if (requireCursor) throw new McpError(INVALID_PARAMS, 'since is required for a bounded wait.');
  return filter;
}
function resourceFilter(params: unknown): { uri: string; filter: StatusFilter } {
  const input = params as { uri?: unknown };
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => key !== 'uri' && key !== '_meta') || typeof input.uri !== 'string' || Buffer.byteLength(input.uri) > 1024) {
    throw new McpError(INVALID_PARAMS, 'A status resource URI is required.');
  }
  let url: URL;
  try { url = new URL(input.uri); } catch { throw new McpError(INVALID_PARAMS, 'Invalid resource URI.'); }
  if (url.protocol !== 'ai-usage:' || url.hostname !== 'status' || url.pathname || url.hash || url.username || url.password || url.port) {
    throw new McpError(-32002, 'Unknown status resource.');
  }
  const keys = [...url.searchParams.keys()];
  if (keys.some(key => key !== 'provider' && key !== 'account') || new Set(keys).size !== keys.length) throw new McpError(INVALID_PARAMS, 'Invalid resource filters.');
  const provider = url.searchParams.get('provider'), account = url.searchParams.get('account');
  if ((provider !== null && !STATUS_PROVIDERS.includes(provider as typeof STATUS_PROVIDERS[number])) || (account !== null && (!provider || !account.length || account.length > 128))) {
    throw new McpError(INVALID_PARAMS, 'Invalid resource filters.');
  }
  const canonical = new URLSearchParams();
  if (provider !== null) canonical.set('provider', provider);
  if (account !== null) canonical.set('account', account);
  const uri = STATUS_URI + (canonical.size ? `?${canonical}` : '');
  if (uri !== input.uri) throw new McpError(INVALID_PARAMS, 'Use the canonical status resource URI.');
  return { uri, filter: statusFilter({ ...(provider ? { providers: [provider] } : {}), ...(account ? { accountIds: [account] } : {}) }) };
}

type ResourceSubscription = { controller: AbortController; filter: StatusFilter };

export type McpServerOptions = {
  /** Connects to the account service; called again after the connection was lost. */
  connect: () => Promise<ServiceClient>;
  version: string;
  /** Diagnostics; never stdout, which carries the protocol. */
  log?: (message: string) => void;
  now?: () => Date;
  /** False means the notification was not accepted because output is backpressured. */
  notify?: (notification: JsonRpcNotification) => boolean;
};

export class McpServer {
  private client?: ServiceClient;
  private connecting?: Promise<ServiceClient>;
  private closed = false;
  private readonly requests = new Map<JsonRpcId, AbortController>();
  private readonly subscriptions = new Map<string, ResourceSubscription>();
  private readonly dirty = new Set<string>();
  private readonly changes = new Set<() => void>();
  private eventRevision = 0;
  private initialized = false;
  private waitReserved = false;
  private waitCancel?: AbortController;
  private notificationTimer?: NodeJS.Timeout;
  private reconnectTimer?: NodeJS.Timeout;
  private detachClient?: () => void;
  private flushing = false;

  constructor(private readonly options: McpServerOptions) {}

  close(): void {
    this.closed = true;
    clearTimeout(this.notificationTimer); clearTimeout(this.reconnectTimer);
    this.detachClient?.(); this.detachClient = undefined;
    this.clearSubscriptions();
    this.changed();
    for (const controller of this.requests.values()) controller.abort();
    this.client?.close();
    this.client = undefined;
  }

  private service(): Promise<ServiceClient> {
    if (this.closed) return Promise.reject(new Error('The MCP adapter is closed.'));
    if (this.client?.connected) {
      if (!this.detachClient && (this.subscriptions.size || this.waitReserved)) this.attachClient(this.client);
      return Promise.resolve(this.client);
    }
    if (!this.connecting) {
      this.connecting = this.options.connect()
        .then((client) => { if (this.closed || (!this.requests.size && !this.subscriptions.size && !this.waitReserved)) { client.close(); throw new Error('The MCP connection no longer has an active caller.'); } this.client = client; if (this.subscriptions.size || this.waitReserved) this.attachClient(client); return client; })
        .finally(() => { this.connecting = undefined; });
    }
    return this.connecting;
  }

  private releaseIdleListeners(): void {
    if (this.subscriptions.size || this.waitReserved) return;
    this.detachClient?.(); this.detachClient = undefined;
    clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined;
  }
  private check(signal?: AbortSignal): void {
    signal?.throwIfAborted();
    if (this.closed) throw new Error('The MCP adapter is closed.');
  }
  endSubscriptions(): void {
    this.clearSubscriptions();
    this.waitCancel?.abort(new Error('MCP input disconnected.'));
    clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined;
  }
  private clearSubscriptions(): void {
    for (const subscription of this.subscriptions.values()) subscription.controller.abort();
    this.subscriptions.clear(); this.dirty.clear();
    this.releaseIdleListeners();
    clearTimeout(this.notificationTimer); this.notificationTimer = undefined;
  }
  private changed(): void {
    this.eventRevision++;
    for (const wake of this.changes) wake();
  }
  private attachClient(client: ServiceClient): void {
    this.detachClient?.();
    const event = (value: { event: string; config?: ServiceConfig }) => {
      if (value.event === 'configChanged' && value.config?.mcp.enabled === false) {
        this.clearSubscriptions(); this.waitCancel?.abort(new Error('MCP is disabled.')); this.changed(); return;
      }
      if (value.event !== 'statusChanged' && value.event !== 'configChanged') return;
      this.changed();
      for (const uri of this.subscriptions.keys()) this.dirty.add(uri);
      this.resumeNotifications();
    };
    const closed = () => {
      if (this.client !== client) return;
      this.detachClient?.(); this.detachClient = undefined; this.client = undefined;
      this.changed();
      for (const uri of this.subscriptions.keys()) this.dirty.add(uri);
      this.reconnect();
    };
    client.on('event', event); client.on('close', closed);
    this.detachClient = () => { client.removeListener('event', event); client.removeListener('close', closed); };
  }
  private reconnect(): void {
    if (this.closed || this.reconnectTimer || (!this.subscriptions.size && !this.waitReserved)) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.service().then(async client => {
        this.check();
        const config = await client.getConfig(); this.check();
        if (!config.mcp.enabled) { this.clearSubscriptions(); this.waitCancel?.abort(new Error('MCP is disabled.')); this.changed(); return; }
        if (!this.subscriptions.size && !this.waitReserved) return;
        await client.statusSnapshot(); this.check();
        await this.enabled(client, new AbortController().signal); this.check();
        this.changed();
        for (const uri of this.subscriptions.keys()) this.dirty.add(uri);
        this.resumeNotifications();
      }).catch(() => this.reconnect());
    }, 1000);
    this.reconnectTimer.unref();
  }
  /** Called after output drains; dirtiness is bounded by the subscription limit. */
  resumeNotifications(): void {
    if (this.closed || !this.initialized || !this.dirty.size || this.notificationTimer || this.flushing || !this.options.notify) return;
    this.notificationTimer = setTimeout(() => {
      this.notificationTimer = undefined;
      void this.flushNotifications();
    }, 100);
    this.notificationTimer.unref();
  }
  private async flushNotifications(): Promise<void> {
    if (this.flushing || this.closed || !this.dirty.size) return;
    this.flushing = true;
    try {
      const client = await this.service(); this.check();
      const config = await client.getConfig(); this.check();
      if (!config.mcp.enabled) { this.clearSubscriptions(); this.waitCancel?.abort(new Error('MCP is disabled.')); this.changed(); return; }
      for (const uri of this.dirty) {
        if (!this.subscriptions.has(uri)) { this.dirty.delete(uri); continue; }
        if (!this.options.notify?.({ jsonrpc: '2.0', method: 'notifications/resources/updated', params: { uri } })) break;
        this.dirty.delete(uri);
      }
    } catch { this.reconnect(); } finally { this.flushing = false; }
  }
  private async enabled(client: ServiceClient, signal: AbortSignal): Promise<ServiceConfig> {
    this.check(signal);
    const config = await abortable(client.getConfig({ signal, timeoutMs: 5000 }), signal); this.check(signal);
    if (!config.mcp.enabled) { this.clearSubscriptions(); this.waitCancel?.abort(new Error('MCP is disabled.')); this.changed(); throw new Error('The AI Usage MCP server is turned off (mcp.enabled).'); }
    return config;
  }
  private async cachedStatus(client: ServiceClient, filter: StatusFilter, signal: AbortSignal): Promise<Record<string, unknown>> {
    this.check(signal);
    const result: StatusRead = await abortable(client.statusSnapshot(filter, { signal, timeoutMs: 5000 }), signal); this.check(signal);
    const config = await this.enabled(client, signal);
    return result.status === 'unchanged' ? { status: result.status, cursor: result.cursor }
      : { status: result.status, snapshot: { ...result.snapshot, rotationPolicy: rotationPolicy(config, this.options.now?.() ?? new Date()) }, resync: result.resync };
  }
  private async subscribe(params: unknown, signal: AbortSignal): Promise<unknown> {
    const { uri, filter } = resourceFilter(params);
    this.check(signal);
    const existing = this.subscriptions.get(uri);
    if (existing) {
      const client = await abortable(this.service(), signal); this.check(signal); await this.enabled(client, signal);
      if (this.subscriptions.get(uri) !== existing) throw new Error('Status subscription was cancelled.');
      return {};
    }
    if (this.subscriptions.size >= 8) throw new McpError(INVALID_PARAMS, 'At most 8 status subscriptions are allowed.');
    const entry: ResourceSubscription = { controller: new AbortController(), filter };
    this.subscriptions.set(uri, entry); // Reserve before any await; unsubscribe can cancel the baseline.
    const combined = AbortSignal.any([signal, entry.controller.signal]);
    const before = this.eventRevision;
    try {
      const client = await abortable(this.service(), combined); this.check(combined);
      await this.enabled(client, combined);
      await this.cachedStatus(client, filter, combined); this.check(combined);
      if (this.subscriptions.get(uri) !== entry) throw new Error('Status subscription was cancelled.');
      if (this.eventRevision !== before) { this.dirty.add(uri); this.resumeNotifications(); }
      return {};
    } catch (error) {
      if (this.subscriptions.get(uri) === entry) { this.subscriptions.delete(uri); this.dirty.delete(uri); this.releaseIdleListeners(); }
      throw error;
    }
  }
  private async waitStatus(filter: StatusFilter, signal: AbortSignal): Promise<Record<string, unknown>> {
    let wake: (() => void) | undefined;
    let last: Record<string, unknown> | undefined;
    const changed = () => wake?.();
    this.changes.add(changed);
    signal.addEventListener('abort', changed, { once: true });
    try {
      while (true) {
        this.check(signal);
        const revision = this.eventRevision;
        const client = await abortable(this.service(), signal); this.check(signal);
        await this.enabled(client, signal);
        last = await this.cachedStatus(client, filter, signal); this.check(signal);
        if (last.status === 'snapshot') return { ...last, timedOut: false };
        await new Promise<void>(resolve => {
          wake = resolve;
          if (signal.aborted || this.closed || revision !== this.eventRevision) resolve();
        });
        wake = undefined;
      }
    } catch (error) {
      if (signal.reason instanceof WaitDeadline && last?.status === 'unchanged') return { ...last, timedOut: true };
      throw error;
    } finally { this.changes.delete(changed); signal.removeEventListener('abort', changed); }
  }

  /** Answers one message; undefined for a notification, which gets no answer even when it fails. */
  async handle(message: unknown): Promise<JsonRpcResponse | undefined> {
    const receivedAt = Date.now();
    if (typeof message !== 'object' || message === null || Array.isArray(message)) { return failure(null, INVALID_REQUEST, 'Invalid request.'); }
    const request = message as JsonRpcRequest;
    if (request.jsonrpc !== '2.0' || (request.id !== undefined && request.id !== null && typeof request.id !== 'string' && typeof request.id !== 'number') ||
      (typeof request.id === 'number' && !Number.isFinite(request.id))) return failure(null, INVALID_REQUEST, 'Invalid JSON-RPC envelope.');
    const notification = request.id === undefined;
    const id = request.id ?? null;
    if (typeof request.method !== 'string') { return notification ? undefined : failure(id, INVALID_REQUEST, 'Invalid request: no method.'); }
    if (request.method === 'notifications/cancelled') {
      const target = (request.params as { requestId?: JsonRpcId } | undefined)?.requestId;
      if (target !== undefined) this.requests.get(target)?.abort();
      return undefined;
    }
    if (!notification && this.requests.has(id)) return failure(id, INVALID_REQUEST, 'Duplicate request id.');
    if (!notification && this.requests.size >= 64) return failure(id, INVALID_REQUEST, 'Too many active requests.');
    const controller = new AbortController();
    if (!notification) this.requests.set(id, controller);
    try {
      const result = await this.dispatch(request.method, request.params, controller.signal, receivedAt);
      return notification ? undefined : { jsonrpc: '2.0', id, result: result ?? {} };
    } catch (error) {
      if (notification) { return undefined; }
      if (error instanceof McpError) { return failure(id, error.code, error.message); }
      return failure(id, INTERNAL_ERROR, error instanceof Error ? error.message : String(error));
    } finally { if (!notification) this.requests.delete(id); }
  }

  private async dispatch(method: string, params: unknown, signal: AbortSignal, receivedAt: number): Promise<unknown> {
    switch (method) {
      case 'initialize': {
        const requested = (params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
        return {
          protocolVersion: typeof requested === 'string' && PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false }, resources: { subscribe: true, listChanged: false } },
          serverInfo: { name: MCP_SERVER_NAME, title: 'AI Usage accounts', version: this.options.version },
          instructions: INSTRUCTIONS
        };
      }
      case 'notifications/initialized': this.initialized = true; this.resumeNotifications(); return;
      case 'ping': return {};
      case 'resources/list': {
        if (params && (typeof params !== 'object' || Array.isArray(params) || Object.keys(params).some(key => key !== '_meta'))) throw new McpError(INVALID_PARAMS, 'This fixed resource list has no pagination cursor.');
        const client = await abortable(this.service(), signal); this.check(signal); await this.enabled(client, signal);
        return { resources: [STATUS_URI, ...STATUS_PROVIDERS.map(provider => `${STATUS_URI}?provider=${provider}`)].map(uri => ({ uri, name: uri, description: 'Cached toolbar usage, total saved-account counts and per-account reset credits. Optional &account=<encoded saved ID> requires provider; native data is withheld when unrelated to the filter.', mimeType: 'application/json' })) };
      }
      case 'resources/read': {
        const { uri, filter } = resourceFilter(params);
        const client = await abortable(this.service(), signal); this.check(signal); await this.enabled(client, signal);
        const value = await this.cachedStatus(client, filter, signal);
        return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(value) }] };
      }
      case 'resources/subscribe': return this.subscribe(params, signal);
      case 'resources/unsubscribe': {
        const { uri } = resourceFilter(params);
        this.subscriptions.get(uri)?.controller.abort(); this.subscriptions.delete(uri); this.dirty.delete(uri); this.releaseIdleListeners();
        if (!this.subscriptions.size) { clearTimeout(this.notificationTimer); this.notificationTimer = undefined; }
        return {};
      }
      case 'tools/list': return { tools: (await this.offeredTools()).map(({ switching: _switching, ...tool }) => tool) };
      case 'tools/call': return this.callTool(params, signal, receivedAt);
      default:
        if (method.startsWith('notifications/')) { return undefined; }
        throw new McpError(METHOD_NOT_FOUND, `Method not found: ${method}.`);
    }
  }

  /** The switching tools are left out while `mcp.switching` is off; the service's answer decides, not a stale list. */
  private async offeredTools(): Promise<ToolDefinition[]> {
    try {
      const config = await (await this.service()).getConfig();
      if (!config.mcp.enabled) return [];
      return config.mcp.switching ? TOOLS : TOOLS.filter((tool) => !tool.switching);
    } catch { return []; }
  }

  private async callTool(params: unknown, signal: AbortSignal, receivedAt: number): Promise<ToolResult> {
    const { name, arguments: args } = (typeof params === 'object' && params !== null ? params : {}) as { name?: unknown; arguments?: unknown };
    const tool = TOOLS.find((candidate) => candidate.name === name);
    if (!tool) { throw new McpError(INVALID_PARAMS, `Unknown tool: ${String(name)}.`); }
    if (args !== undefined && (typeof args !== 'object' || args === null || Array.isArray(args))) throw new McpError(INVALID_PARAMS, 'Tool arguments must be an object.');
    const input = (args ?? {}) as Record<string, unknown>;
    const properties = tool.inputSchema.properties as Record<string, unknown>;
    const unexpected = Object.keys(input).filter(key => !(key in properties));
    if (unexpected.length) throw new McpError(INVALID_PARAMS, `Unexpected argument: ${unexpected.join(', ')}.`);
    let deadlineTimer: NodeJS.Timeout | undefined;
    const waiting = name === 'wait_for_usage_updates';
    if (waiting && this.waitReserved) throw new McpError(INVALID_PARAMS, 'Only one pending usage wait is allowed.');
    if (waiting) { this.waitReserved = true; this.waitCancel = new AbortController(); signal = AbortSignal.any([signal, this.waitCancel.signal]); }
    try {
      if (waiting) {
        statusFilter(input, true);
        const seconds = input.timeoutSeconds ?? 25;
        if (typeof seconds !== 'number' || !Number.isInteger(seconds) || seconds < 1 || seconds > 30) throw new McpError(INVALID_PARAMS, 'timeoutSeconds must be an integer from 1 to 30.');
        const deadline = new AbortController();
        deadlineTimer = setTimeout(() => deadline.abort(new WaitDeadline()), Math.max(0, receivedAt + seconds * 1000 - Date.now()));
        signal = AbortSignal.any([signal, deadline.signal]);
      }
      const client = await abortable(this.service(), signal); this.check(signal);
      const config = await abortable(client.getConfig({ signal, timeoutMs: 90_000 }), signal); this.check(signal);
      if (!config.mcp.enabled) {
        return text('The AI Usage MCP server is turned off. Turn on aiUsage.mcp.enabled in VS Code settings, or run: ai-usage config mcp.enabled true', undefined, true);
      }
      if (tool.switching && !config.mcp.switching) {
        return text('Switching accounts through MCP is turned off (aiUsage.mcp.switching in VS Code settings, mcp.switching for ai-usage config). Only the usage tools are available.', undefined, true);
      }
      signal.throwIfAborted();
      return await this.run(client, tool.name, input, { signal, timeoutMs: 90_000 }, config);
    } catch (error) {
      if (error instanceof McpError) { throw error; }
      // Something the agent can act on (the service is not running, the profile does not exist) is a tool result.
      const message = error instanceof Error ? error.message : String(error);
      this.options.log?.(`${tool.name}: ${message}`);
      return text(message, signal.reason instanceof WaitDeadline ? { timedOut: true } : undefined, true);
    } finally { clearTimeout(deadlineTimer); if (waiting) { this.waitReserved = false; this.waitCancel = undefined; this.releaseIdleListeners(); } }
  }

  private async run(client: ServiceClient, name: string, input: Record<string, unknown>, options: RequestOptions, config: ServiceConfig): Promise<ToolResult> {
    switch (name) {
      case 'get_usage_status': {
        const result = await this.cachedStatus(client, statusFilter(input), options.signal!);
        return text(JSON.stringify(result), result);
      }
      case 'wait_for_usage_updates': {
        const timeout = input.timeoutSeconds ?? 25;
        if (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout < 1 || timeout > 30) throw new McpError(INVALID_PARAMS, 'timeoutSeconds must be an integer from 1 to 30.');
        const result = await this.waitStatus(statusFilter(input, true), options.signal!);
        return text(JSON.stringify(result), result);
      }
      case 'list_accounts': {
        const services = input.service === undefined ? PROVIDERS : [providerArg(input.service)];
        const summaries = await Promise.all(services.map(async provider => {
          const view = await client.list(provider, options);
          const state = await client.liveUsage(provider, false, options);
          const now = this.options.now?.() ?? new Date();
          const summary = serviceSummary(view, now, Math.max(1, config[provider].checkIntervalMinutes ?? 5) * 60_000);
          summary.activeUsage = activeUsageSummary(state, view.nativeUnsaved, now, Math.max(1, config[provider].checkIntervalMinutes ?? 5) * 60_000);
          return summary;
        }));
        const policy = rotationPolicy(config, this.options.now?.() ?? new Date());
        return text([...summaries.map(summaryText), rotationPolicyText(policy)].join('\n\n'), { services: summaries, rotationPolicy: policy });
      }
      case 'refresh_usage': {
        const provider = providerArg(input.service);
        if (input.profile === undefined) {
          const [view, state] = await Promise.all([client.list(provider, options), client.liveUsage(provider, true, options)]);
          const now = this.options.now?.() ?? new Date();
          const activeUsage = activeUsageSummary(state, view.nativeUnsaved, now, Math.max(1, config[provider].checkIntervalMinutes ?? 5) * 60_000);
          return text(`${TITLES[provider]} native active login${view.nativeUnsaved ? ' (unsaved)' : ''}: ${activeUsage.usage ? windowsText(activeUsage.usage.windows) : 'no reading'} · ${activeUsage.freshness.state}${activeUsage.problem ? ` · ${activeUsage.problem}` : ''}`,
            { service: provider, nativeUnsaved: view.nativeUnsaved, activeUsage }, state.result.kind !== 'ok');
        }
        const result = await client.readUsage(provider, { ref: profileArg(input.profile) }, options);
        const now = this.options.now?.() ?? new Date();
        const name = `${TITLES[provider]} profile “${result.profile.name}”`;
        if (result.usage) {
          const windows = result.usage.windows.map((window) => windowSummary(window, now));
          return text(`${name}: ${windowsText(windows)} · read ${result.usage.fetchedAt}`,
            { service: provider, profile: result.profile, usage: { fetchedAt: result.usage.fetchedAt, plan: result.usage.plan, windows }, freshness: readingFreshness(result.usage, now) });
        }
        const problem = result.usageError ? readableProblem(result.usageError) : 'the usage could not be read';
        return text(`${name}: ${problem}`, { service: provider, profile: result.profile, error: problem }, true);
      }
      case 'switch_account': {
        const provider = providerArg(input.service);
        const result = await client.activate(provider, { ref: profileArg(input.profile) }, options);
        const policy = rotationPolicy(config, this.options.now?.() ?? new Date());
        const warning = config[provider].autoRotate.enabled ? ` Built-in ${TITLES[provider]} automatic rotation remains enabled and may select another account later.` : '';
        return text(`${result.message}${result.accountChanged ? '' : ' The account in use did not change.'}${warning}`,
          { service: provider, profile: result.profile, level: result.level, accountChanged: result.accountChanged, verification: result.verification ?? null, message: result.message, rotationPolicy: policy },
          result.level === 'error');
      }
      case 'rotate_account': {
        const provider = providerArg(input.service);
        const result = await client.rotateNow(provider, {}, options);
        return text(result.switched
          ? `${TITLES[provider]} rotated to “${result.activeProfileName ?? result.activeProfileId}”.`
          : `${TITLES[provider]} not rotated: ${result.reason ?? 'no reason given'}.`,
        { service: provider, switched: result.switched, reason: result.reason, activeProfileId: result.activeProfileId, activeProfileName: result.activeProfileName, selectionMode: 'enginePolicy', rotationPolicy: rotationPolicy(config, this.options.now?.() ?? new Date()) });
      }
      default: throw new McpError(INVALID_PARAMS, `Unknown tool: ${name}.`);
    }
  }
}

function failure(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

export type McpStdioOptions = McpServerOptions & { input: Readable; output: Writable };

/**
 * Serves the protocol on the given streams until the input ends; every line is one message, answers go out as one
 * line each, and requests are answered as they finish, so a ping is not held up by a slow tool call.
 */
export async function runMcpStdio(options: McpStdioOptions): Promise<number> {
  const queue: string[] = [];
  let queuedBytes = 0, blocked = false, stopped = false;
  let finish: (() => void) | undefined;
  let outputDrained: (() => void) | undefined;
  const inputFinished = () => finish?.();
  const server = new McpServer({ ...options, notify: notification => {
    if (stopped || blocked || queue.length) return false;
    writeFrame(`${JSON.stringify(notification)}\n`);
    return !stopped;
  } });
  const stop = () => {
    if (stopped) return;
    stopped = true; queue.length = 0; queuedBytes = 0;
    server.close(); outputDrained?.(); finish?.();
  };
  const writeFrame = (frame: string) => {
    try { blocked = !options.output.write(frame); } catch { stop(); }
  };
  const drain = () => {
    if (stopped) return;
    blocked = false;
    while (!blocked && queue.length) {
      const frame = queue.shift()!; queuedBytes -= Buffer.byteLength(frame); writeFrame(frame);
    }
    if (!blocked) { server.resumeNotifications(); outputDrained?.(); }
  };
  const write = (response: JsonRpcResponse | JsonRpcResponse[]) => {
    if (stopped) return;
    const frame = `${JSON.stringify(response)}\n`, bytes = Buffer.byteLength(frame);
    if (bytes > 8 * 1024 * 1024 || queue.length >= 64 || queuedBytes + bytes > 8 * 1024 * 1024) {
      options.log?.('MCP output queue limit exceeded; closing this connection.'); stop(); return;
    }
    if (blocked || queue.length) { queue.push(frame); queuedBytes += bytes; } else writeFrame(frame);
  };
  options.output.on('drain', drain);
  options.output.on('error', stop); options.output.on('close', stop);
  const pending = new Set<Promise<void>>();
  const answer = async (message: unknown) => {
    if (Array.isArray(message)) {
      if (!message.length || message.length > 64) { write(failure(null, INVALID_REQUEST, 'Invalid batch size.')); return; }
      const responses = (await Promise.all(message.map(entry => server.handle(entry)))).filter((response): response is JsonRpcResponse => response !== undefined);
      if (responses.length) write(responses);
      return;
    }
    const response = await server.handle(message);
    if (response) write(response);
  };
  const receive = (line: string) => {
    if (stopped) return;
    if (pending.size >= 64) { options.log?.('MCP active request limit exceeded; closing this connection.'); stop(); return; }
    let message: unknown;
    try { message = JSON.parse(line); } catch { write(failure(null, PARSE_ERROR, 'Parse error.')); return; }
    const task = answer(message).catch((error: unknown) => options.log?.(`unexpected failure: ${error instanceof Error ? error.message : String(error)}`));
    pending.add(task);
    void task.finally(() => pending.delete(task));
  };
  let buffer = '';
  const data = (chunk: string) => {
    if (stopped) return;
    buffer += chunk;
    if (Buffer.byteLength(buffer) > 8 * 1024 * 1024) { write(failure(null, INVALID_REQUEST, 'Message too large.')); stop(); return; }
    let newline = buffer.indexOf('\n');
    while (newline >= 0 && !stopped) {
      const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
      if (line) receive(line);
    }
  };
  try {
    await new Promise<void>(resolve => {
      finish = resolve;
      options.input.setEncoding('utf8'); options.input.on('data', data);
      options.input.once('end', inputFinished); options.input.once('error', stop); options.input.once('close', inputFinished);
      if (stopped) resolve();
    });
    if (!stopped && buffer.trim()) receive(buffer.trim());
    server.endSubscriptions();
    if (pending.size) {
      // Ordinary complete piped requests retain their existing bounded grace period; waits abort immediately.
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([Promise.all(pending), new Promise<void>(resolve => { timer = setTimeout(resolve, 1000); })]);
      clearTimeout(timer);
    }
    server.close(); await Promise.all(pending);
    if (!stopped && (blocked || queue.length)) {
      let drainTimer: NodeJS.Timeout | undefined;
      await Promise.race([new Promise<void>(resolve => { outputDrained = resolve; }), new Promise<void>(resolve => {
        drainTimer = setTimeout(() => { options.log?.('MCP output did not drain within the EOF grace period; closing this connection.'); stop(); resolve(); }, 1000);
      })]);
      clearTimeout(drainTimer); outputDrained = undefined;
    }
  } finally {
    stopped = true; queue.length = 0;
    options.input.removeListener('data', data); options.input.removeListener('error', stop);
    options.input.removeListener('end', inputFinished); options.input.removeListener('close', inputFinished);
    options.output.removeListener('drain', drain); options.output.removeListener('error', stop); options.output.removeListener('close', stop);
    server.close();
  }
  return 0;
}
