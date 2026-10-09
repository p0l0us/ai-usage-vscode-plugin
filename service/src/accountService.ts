import { randomUUID, createHash } from 'crypto';
import { projectQuota, projectResetCredits, StatusFilter, StatusRead, StatusSnapshot, StatusProvider, StatusNative, StatusCursor } from './statusProjection';
import { mcpCli, mcpCommand, readMcpRegistration, registerMcpServer, unregisterMcpServer } from './mcpRegistration';
import { findStaleCodexProcesses } from './codexProcesses';
import { UsageMonitor, UsageContext, UsageStateView, usageSettings, nativeUsageIdentity, serializeUsageState } from './usageMonitor';
import { ServiceRuntime } from './runtime';
import { readCurrentSessionTokens } from './sessionTokens';
import { EventEmitter } from 'events';
import { AsyncLocalStorage } from 'async_hooks';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ApiCallBudget, sleep } from './apiBudget';
import { AuthProvider, StoredCredential, parseCredentialJson, readNativeCredential } from './authFiles';
import { activateClaudeAccountMetadata, claudeAccountFileConfirms, CredentialIdentity } from './accountIdentity';
import { AccountAutomation, AutomationProfiles, KeepAliveNowResult, LockWait } from './accountAutomation';
import {
  resetCodexAccount, acquireAccountLock, explainAccountProblem, isolatedEnvironment, loginArgs, loginHome, probeAccount, readableProblem, stagedCredentialPath
} from './accountProbe';
import { deserializeUsage } from './cache';
import { ConfigAuthority, ConfigPatchResult, ConfigView, ServiceConfig, automationSettings, configFileOf, strategySummary } from './configStore';
import { LiveUsage, LiveResult, ProviderId, newestValidUsage, refreshCodexNativeLogin, resolveCli, verifyCodexNativeAccount } from './live';
import { ExportedProfile, ImportPlan, parseProfileExport, serializeProfileExport } from './profileTransfer';
import { ActivationOutcome, PrivateProfileBackend, ProfileMetadata, ProfileStore, PROVIDERS, TITLES, importOutcome } from './profileStore';
import {
  ActivationResult, ExportResult, ImportPlanView, ImportSummary, KeepAliveAllResult, ProfileView, ProviderView, SaveNativeResult, ServiceEvent, ServiceInfo,
  SerializedUsage, SignInPreparation, SignInResult, Snapshot, UsageReadResult, serializeKeepAlive
} from './protocol';
import { profilesFile, stateDir } from './paths';
import { RpcError } from './rpc';
import type { BridgeWorkspaceContext } from './bridgeRuntime';
import { HistoryExportKind, HistoryInfo, HistorySummaryResult } from './protocol';
import { UsageHistory, eventsCsv, historyFileStart, readingsCsv, usageSnapshot } from './usageHistory';
import { Thresholds, renderHistoryReport, summarizeHistory } from './usageHistoryReport';

/** Shortest gap between background attempts to confirm the activated Claude login. */
const CLAUDE_METADATA_RETRY_MS = 60_000;
/** Attempts before the background identity sync gives up until the next switch. */
const CLAUDE_METADATA_RETRY_LIMIT = 10;
/** Sweeps, keep-alives and the other periodic work run this often. */
export const TICK_MS = 60_000;
/** How long a check requested by hand waits for a running sweep of the service, unless the request says otherwise. */
export const MANUAL_CHECK_WAIT_MS = 3 * 60_000;
/** Pause between accounts when a keep-alive is sent to all of them at once. */
export const KEEP_ALIVE_ALL_SPACING_MS = 3_000;

export type AccountServiceOptions = {
  home: string;
  version: string;
  log: (message: string) => void;
  /** Injected by tests. */
  probe?: typeof probeAccount;
  reset?: typeof resetCodexAccount;
  fetchUsage?: (provider: ProviderId, context: UsageContext, known?: LiveUsage) => Promise<LiveResult>;
  usageIdentity?: (provider: AuthProvider) => string;
  identityOf?: (provider: AuthProvider, credential: StoredCredential) => Promise<CredentialIdentity>;
  verifyCodex?: typeof verifyCodexNativeAccount;
  syncClaudeMetadata?: typeof activateClaudeAccountMetadata;
  now?: () => number;
  /** Where the private profiles are kept; profiles.json in the home by default. */
  privateProfiles?: PrivateProfileBackend;
  /** How long `dispose` waits for admitted requests and background work to finish; it rejects after that. */
  drainTimeoutMs?: number;
  /**
   * The home's ownership lease (see runtimeLease). The host passes it; without it the engine can answer reads and
   * be driven by tests, but `start` refuses to run the background work, so no second engine runs beside an owner.
   */
  ownership?: EngineOwnership;
  /** First values for settings the persisted config.json does not have yet; never replaces existing settings. */
  seedConfig?: Record<string, unknown>;
  /** @deprecated Same seed-only meaning as `seedConfig`; kept for older callers. */
  initialConfig?: Record<string, unknown>;
};

/** What the socket layer tells about a request: cancelled when the client gives up or disconnects, and its deadline. */
export type RequestContext = { signal?: AbortSignal; deadlineAt?: number; requestId?: number };

/** What the engine needs of its ownership lease. */
export type EngineOwnership = { held(): boolean; assertHeld(): void };

/** Facts the host adds to `service.info`: how it runs and which configuration revision is current. */
export type HostIdentity = { mode: 'background' | 'embedded'; instanceId: string; protocol: number; capabilities: string[]; lease: 'os' | 'tcp' };

/**
 * One connection's workspace: the project folders whose profile files are listed, its GitHub sign-ins for Copilot,
 * and session directories for the bridge. Each connection has its own; nothing is shared or merged across windows
 * except the folder union the profile list needs.
 */
export type WorkspaceContext = {
  folders: string[];
  github?: UsageContext;
  sessionDirectory?: Partial<Record<AuthProvider, string>>;
};

/** Methods that change nothing the owner keeps, so they may be answered without checking the lease. */
const READ_ONLY_METHODS = new Set(['status.snapshot', 'reset.confirmations', 'service.info', 'snapshot', 'profiles.list', 'config.get', 'config.read', 'rotation.diagnostics', 'history.info',
  'history.summary', 'history.export', 'profiles.export', 'profiles.planImport', 'runtime.status', 'mcp.registration', 'runtime.staleCodex',
  'usage.sessionTokens', 'automation.cancel']);

function providerParam(params: Record<string, unknown>): AuthProvider {
  const provider = params.provider;
  if (provider !== 'claude' && provider !== 'codex') { throw new RpcError('Choose a service: claude or codex.', 'invalid_params'); }
  return provider;
}

function stringParam(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== 'string' || !value) { throw new RpcError(`Missing ${key}.`, 'invalid_params'); }
  return value;
}

function objectParams(params: unknown): Record<string, unknown> {
  return typeof params === 'object' && params !== null ? params as Record<string, unknown> : {};
}

function isoOrUndefined(value: number | undefined): string | undefined {
  return value === undefined ? undefined : new Date(value).toISOString();
}

/**
 * Everything the service does, behind a method dispatcher: the profile store, the keep-alive and rotation
 * automation, activation verification and the events clients are told about. The daemon wires it to a socket;
 * tests call `handle` directly.
 */
export class AccountService {
  readonly store: ProfileStore;
  readonly usageMonitor: UsageMonitor;
  readonly runtime: ServiceRuntime;
  private usageTimer?: NodeJS.Timeout;
  private readonly statusEpoch = randomUUID();
  private statusRevision = 0;
  private statusDigest?: string;
  private statusTimer?: NodeJS.Timeout;
  private statusLifecycle: import('./protocol').LifecycleState = 'starting';
  private readonly retainedStatus = new Map<string, UsageStateView>();
  private readonly retainedCopilotAccount = new Map<string, string>();
  private readonly retainedAttribution = new Map<string, boolean>();
  private readonly usageContexts = new Map<number, UsageContext>();
  readonly automation: AccountAutomation;
  /** Readings, switches and rotation sweeps, appended to month files for later analysis (`history.*`). */
  readonly history: UsageHistory;
  readonly events = new EventEmitter();
  /** The persisted configuration and its revisions; only the lease owner writes it. */
  readonly configAuthority: ConfigAuthority;
  get config(): ServiceConfig { return this.configAuthority.config; }
  /** Set by the host. */
  hostIdentity?: HostIdentity;
  readonly startedAt = new Date();
  /** Set by the daemon: how many clients are connected right now. */
  clientCount: () => number = () => 0;

  private readonly claudeBudget: ApiCallBudget;
  private readonly log: (message: string) => void;
  private readonly now: () => number;
  private timer?: NodeJS.Timeout;
  private disposed = false;
  private disposing?: Promise<void>;
  /** Requests and background work admitted and not finished yet; `dispose` waits for them before stopping the runtime. */
  private readonly inflight = new Set<Promise<unknown>>();
  /** The request a piece of work runs for, so queued operations can be refused once that request was cancelled. */
  private readonly requestScope = new AsyncLocalStorage<{ method: string; signal?: AbortSignal }>();
  /** Set while a switched Claude login still has to be confirmed against the OAuth profile endpoint. */
  private claudeMetadataRetry?: { nextAttemptAt: number; attempts: number };
  /** The project folders each connected client declared; their union is what the store reads. */
  private readonly foldersByClient = new Map<number, string[]>();
  /** Bridge session directories each connection chose for its workspace. */
  private readonly sessionDirectories = new Map<number, Partial<Record<AuthProvider, string>>>();
  /** Checks requested by hand that may be cancelled, by the token the client chose. */
  private readonly cancels = new Map<string, AbortController>();

  constructor(private readonly options: AccountServiceOptions) {
    this.log = options.log;
    this.now = options.now ?? Date.now;
    this.configAuthority = new ConfigAuthority(configFileOf(options.home), { log: this.log,
      seed: { ...(options.initialConfig ?? {}), ...(options.seedConfig ?? {}) },
      // Only the owner persists; an engine without the lease keeps a seed in memory.
      persist: Boolean(options.ownership?.held()),
      assertWritable: () => options.ownership?.assertHeld() });
    this.store = new ProfileStore(profilesFile(options.home), this.log, options.identityOf, {
      projectFileName: () => this.config.projectProfiles.file,
      projectProfilesEnabled: () => this.config.projectProfiles.enabled,
      privateProfilesEnabled: () => this.config.privateProfiles.enabled,
      notice: (message) => this.emit({ event: 'notice', level: 'info', message }),
      privateProfiles: options.privateProfiles
    });
    this.store.verifyActivation = (provider, credential, expected) => this.verifyActivation(provider, credential, expected);
    const states = stateDir(options.home);
    this.claudeBudget = new ApiCallBudget(path.join(states, 'claude-api-budget.json'),
      () => Math.min(600, Math.max(0, this.config.claude.api.minIntervalSeconds)) * 1000);
    const probe = options.probe ?? probeAccount;
    const profiles: AutomationProfiles = {
      profiles: (provider) => this.store.profiles(provider),
      activeProfileId: (provider) => this.store.activeProfileId(provider),
      credential: (provider, id) => this.store.credential(provider, id),
      refreshedCredential: (provider, id, before, after) => this.store.refreshedCredential(provider, id, before, after),
      matchesNative: (provider, id) => this.store.matchesNative(provider, id),
      activateProfile: async (provider, id, automatic) => {
        try { await this.activate(provider, id, Boolean(automatic)); return true; }
        catch (error) { this.log(`${provider}: could not activate ${id}: ${error instanceof Error ? error.message : String(error)}`); return false; }
      }
    };
    this.automation = new AccountAutomation(path.join(states, 'account-usage'), profiles, (provider) => automationSettings(this.config, provider),
      async () => { /* The switch itself already announced the activation. */ }, this.log,
      (provider, credential, settings, keepAlive, signal) => probe(provider, credential, settings, keepAlive, signal, provider === 'claude' ? this.claudeBudget : undefined),
      this.now, options.reset);
    this.automation.resetContext = () => this.configAuthority.revision;
    this.automation.onResetConfirmation = decision => this.emit({ event: 'resetConfirmation', decision });
    this.automation.admit = () => this.admit();
    this.automation.onAccountProblem = (provider, id, reason, revoked) => {
      const profile = this.store.profile(provider, id);
      if (!profile) { return; }
      this.emit({ event: 'accountProblem', provider, id, name: profile.name, email: profile.email, reason, readable: readableProblem(reason), revoked });
      this.emit({ event: 'stateChanged', provider });
    };
    this.automation.onNoCandidate = (provider, detail) => this.emit({ event: 'noCandidate', provider, detail });
    this.automation.onEarnedReset = (id, outcome, available) => {
      this.emit({ event: 'stateChanged', provider: 'codex' });
      if (outcome === 'reset') {
        const name = this.store.profile('codex', id)?.name ?? id;
        this.emit({ event: 'notice', level: 'info', message: `Codex: used an earned rate-limit reset for "${name}"${available !== undefined ? ` (${available} available now)` : ''}.` });
      }
    };
    this.usageMonitor = new UsageMonitor({ directory: states, config: () => this.config, budget: this.claudeBudget,
      log: this.log, now: this.now, fetch: options.fetchUsage, identity: options.usageIdentity,
      runFetch: async (provider, fetch) => {
        if (provider === 'copilot') return fetch();
        if (this.automation.heldFor(provider)) return undefined;
        const lock = acquireAccountLock(path.join(states, 'account-usage', `${provider}.lock`));
        if (!lock) return undefined;
        try { return await fetch(); } finally { lock.release(); }
      },
      changed: provider => this.emit({ event: 'usageChanged', provider }),
      observe: async (provider, usage, attributable, identity) => {
        if (identity !== (options.usageIdentity ?? nativeUsageIdentity)(provider)) return;
        const id = this.store.activeProfileId(provider);
        if (attributable && id && await this.store.matchesNative(provider, id)) this.automation.observe(provider, id, usage);
        else if (!attributable) this.automation.hintLimit(provider, usage);
      } });
    this.runtime = new ServiceRuntime(options.home, () => this.config, options.version, this.log,
      message => this.emit({ event: 'notice', level: 'warning', message }),
      () => [...new Set([...this.foldersByClient.values()].flat())],
      () => this.automation.withAccountLock('codex', () => refreshCodexNativeLogin(this.config.codex.cliPath), { waitMs: MANUAL_CHECK_WAIT_MS }));
    this.runtime.ownership = options.ownership;
    this.history = new UsageHistory(this.historyDirectory(), this.historyOptions(), this.log, this.now);
    this.automation.history = this.history;
    this.log(`usage history: ${this.history.enabled ? this.history.location : 'off'}`);
  }

  /** Keep the active native login fresh even without a saved profile or a connected editor. */
  private pollUsage(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    return this.track(this.pollUsageNow());
  }

  private async pollUsageNow(): Promise<void> {
    const work: Promise<unknown>[] = PROVIDERS.map(provider => this.liveUsage(provider));
    for (const clientId of this.usageContexts.keys()) work.push(this.liveUsage('copilot', false, clientId));
    if (!this.usageContexts.size) work.push(this.liveUsage('copilot'));
    for (const result of await Promise.allSettled(work)) {
      if (result.status === 'rejected') this.log(`usage: ${String(result.reason)}`);
    }
  }

  async liveUsage(provider: ProviderId, force = false, clientId?: number): Promise<UsageStateView> {
    const statusContext = this.usageContexts.get(clientId ?? -1);
    const statusCopilotAccount = this.config.copilot.account;
    let context = statusContext;
    if (provider === 'copilot' && !context) {
      const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
      context = { accounts: token ? [{ login: this.config.copilot.account || 'GitHub', token }] : [] };
    }
    if (provider !== 'copilot') await this.followNative(provider);
    const active = provider === 'copilot' ? undefined : this.store.activeProfileId(provider);
    const state = await this.usageMonitor.read(provider, force, context);
    const rawReading = state.result.kind === 'ok' ? state.result.usage : state.lastGood;
    let accountAttributed = provider !== 'codex' || !(rawReading?.source === 'sessionLog' || ['both', 'sessionLog'].includes(this.config.codex.source) ||
      (this.config.codex.source === 'auto' && !rawReading?.source));
    const nativeMatches = provider !== 'copilot' && !!active && active === this.store.activeProfileId(provider) && await this.store.matchesNative(provider, active);
    if (nativeMatches) {
      const ownUsage = this.automation.usage(provider, active);
      const usage = newestValidUsage(state.lastGood, ownUsage, this.now());
      if (usage && usage === ownUsage) accountAttributed = true;
      if (usage) { state.lastGood = usage; if (state.result.kind === 'ok') state.result = { kind: 'ok', usage }; }
    }
    if (provider !== 'copilot' && active !== this.store.activeProfileId(provider)) {
      return this.retainStatus(provider, serializeUsageState({ identity: (this.options.usageIdentity ?? nativeUsageIdentity)(provider), result: { kind: 'unavailable', provider, reason: 'The active account changed; waiting for its reading.' } }), clientId);
    }
    return this.retainStatus(provider, { ...serializeUsageState(state), profileId: nativeMatches ? active : undefined }, clientId, statusContext, statusCopilotAccount, accountAttributed);
  }

  private statusKey(provider: ProviderId, clientId?: number): string {
    return provider === 'copilot' && clientId !== undefined && this.usageContexts.has(clientId) ? `${provider}:${clientId}` : provider;
  }

  private retainStatus(provider: ProviderId, state: UsageStateView, clientId?: number, context?: UsageContext, account?: string, attributed = false): UsageStateView {
    if (!this.disposed && (provider !== 'copilot' || (this.usageContexts.get(clientId ?? -1) === context && this.config.copilot.account === account))) {
      const key = this.statusKey(provider, clientId);
      this.retainedStatus.set(key, state);
      this.retainedAttribution.set(key, attributed);
      if (provider === 'copilot') this.retainedCopilotAccount.set(key, this.config.copilot.account);
      this.refreshStatus();
    }
    return state;
  }

  /** Cached facts only: no following/activating native accounts, locks or provider collection. */
  private buildStatus(now: number, clientId?: number, filter: StatusFilter = {}): Omit<StatusSnapshot, 'cursor'> {
    const providers: StatusProvider[] = [];
    for (const provider of filter.providers ?? ['claude', 'codex', 'copilot'] as const) {
      const interval = usageSettings(this.config, provider).apiCheckIntervalMs;
      const profiles = provider === 'copilot' ? [] : this.store.profiles(provider);
      const selected = provider === 'copilot' ? undefined : this.store.activeProfileId(provider);
      const key = this.statusKey(provider, clientId);
      const retained = this.retainedStatus.get(key);
      const identity = provider === 'copilot' ? retained?.identity : (this.options.usageIdentity ?? nativeUsageIdentity)(provider);
      const identityMatches = !!retained && retained.identity === identity &&
        (provider !== 'copilot' || this.retainedCopilotAccount.get(key) === this.config.copilot.account);
      const saved = provider !== 'copilot' && identityMatches && retained.profileId === selected && !this.store.nativeIsUnsaved(provider) &&
        !!selected && profiles.some(profile => profile.id === selected);
      const filtered = !!filter.accountIds && (!saved || !filter.accountIds.includes(selected!));
      const raw = identityMatches && !filtered ? retained.result.kind === 'ok' ? retained.result.usage : retained.lastGood : undefined;
      const accountAttributed = identityMatches && this.retainedAttribution.get(key) === true;
      const accounts = profiles.filter(profile => !filter.accountIds || filter.accountIds.includes(profile.id)).map(profile => {
        const reading = this.automation.accountState(provider as AuthProvider, profile.id).usage as SerializedUsage | undefined;
        // Cache hits after saving the native login still belong to that positively matched account.
        const matchedNative = saved && profile.id === selected && accountAttributed ? raw : undefined;
        const quotaReading = !reading || (matchedNative && Date.parse(matchedNative.fetchedAt) > Date.parse(reading.fetchedAt)) ? matchedNative : reading;
        return { id: profile.id, name: profile.name, selected: profile.id === selected, quota: projectQuota(quotaReading, now, interval),
          ...(provider === 'codex' ? { resetCredits: projectResetCredits(reading, now, matchedNative) } : {}) };
      });
      const native: StatusNative = { kind: filtered || !identityMatches ? identity === 'unsigned' ? 'none' : 'unknown'
        : provider === 'copilot' ? 'unsaved' : saved ? 'saved' : this.store.nativeIsUnsaved(provider) ? 'unsaved' : identity === 'unsigned' ? 'none' : 'unknown',
        ...(saved && !filtered ? { profileId: selected } : {}), quota: projectQuota(raw, now, interval, accountAttributed),
        ...(provider === 'codex' ? { resetCredits: projectResetCredits(raw, now) } : {}) };
      providers.push({ provider, savedAccountCount: profiles.length, accounts, native });
    }
    return { capturedAt: new Date(now).toISOString(), configRevision: this.configAuthority.revision, lifecycle: this.statusLifecycle, providers };
  }

  private refreshStatus(now = this.now()): StatusCursor {
    const contexts = [...this.usageContexts.keys()].sort((a, b) => a - b);
    const snapshots = [this.buildStatus(now), ...contexts.map(id => this.buildStatus(now, id))];
    const digest = createHash('sha256').update(JSON.stringify(snapshots.map(({ capturedAt: _time, ...snapshot }) => snapshot))).digest('hex');
    if (digest !== this.statusDigest) {
      this.statusDigest = digest;
      this.statusRevision++;
      this.events.emit('event', { event: 'statusChanged', cursor: { epoch: this.statusEpoch, revision: this.statusRevision } });
    }
    if (this.statusTimer) clearTimeout(this.statusTimer);
    this.statusTimer = undefined;
    if (!this.disposed) {
      const deadlines = snapshots.flatMap(snapshot => snapshot.providers.flatMap(provider => [...provider.accounts, provider.native].flatMap(row =>
        [row.quota.validUntil, row.resetCredits?.state !== 'unknown' ? row.resetCredits?.validUntil : undefined]
          .filter((value): value is string => !!value).map(Date.parse)))).filter(time => Number.isFinite(time) && time > now);
      if (deadlines.length) {
        this.statusTimer = setTimeout(() => this.refreshStatus(), Math.min(2_147_483_647, Math.max(1, Math.min(...deadlines) - now)));
        this.statusTimer.unref?.();
      }
    }
    return { epoch: this.statusEpoch, revision: this.statusRevision };
  }

  statusSnapshot(filter: StatusFilter = {}, clientId?: number): StatusRead {
    const now = this.now();
    const cursor = this.refreshStatus(now);
    if (filter.since?.epoch === cursor.epoch && filter.since.revision === cursor.revision) return { status: 'unchanged', cursor };
    return { status: 'snapshot', snapshot: { ...this.buildStatus(now, clientId, filter), cursor }, resync: !!filter.since && filter.since.epoch !== cursor.epoch };
  }

  private statusFilter(params: Record<string, unknown>): StatusFilter {
    const providers = params.providers;
    const accountIds = params.accountIds;
    const since = params.since;
    if (providers !== undefined && (!Array.isArray(providers) || providers.length > 3 || providers.some(value => !['claude', 'codex', 'copilot'].includes(String(value)))))
      throw new RpcError('Select up to three status providers.', 'invalid_params');
    if (accountIds !== undefined && (!Array.isArray(accountIds) || accountIds.length > 40 || accountIds.some(value => typeof value !== 'string' || !value.length || value.length > 128)))
      throw new RpcError('Select up to forty account ids.', 'invalid_params');
    if (since !== undefined && (typeof since !== 'object' || since === null || typeof (since as StatusCursor).epoch !== 'string' || (since as StatusCursor).epoch.length > 128 ||
      !Number.isSafeInteger((since as StatusCursor).revision) || (since as StatusCursor).revision < 0)) throw new RpcError('Invalid status cursor.', 'invalid_params');
    return { ...(providers === undefined ? {} : { providers: [...new Set(providers as ProviderId[])] }),
      ...(accountIds === undefined ? {} : { accountIds: [...new Set(accountIds as string[])] }), ...(since === undefined ? {} : { since: since as StatusCursor }) };
  }

  // --- usage history -----------------------------------------------------------------------------------------

  /** `history.directory`, with `~` expanded and relative paths resolved from the user home; empty is `usage-history` in the service home. */
  private historyDirectory(): string {
    const configured = (this.config.history?.directory ?? '').trim();
    if (!configured) { return path.join(this.options.home, 'usage-history'); }
    const expanded = configured === '~' ? os.homedir()
      : configured.startsWith('~/') || configured.startsWith('~\\') ? path.join(os.homedir(), configured.slice(2)) : configured;
    return path.resolve(os.homedir(), expanded);
  }

  private historyOptions(): { enabled: boolean; retentionMs: number } {
    const days = this.config.history?.retentionDays ?? 365;
    return { enabled: this.config.history?.enabled !== false, retentionMs: (Number.isFinite(days) ? Math.max(1, days) : 365) * 86_400_000 };
  }

  private applyHistoryConfig(): void {
    this.history.configure(this.historyDirectory(), this.historyOptions());
    this.history.prune();
    this.log(`usage history: ${this.history.enabled ? this.history.location : 'off'}`);
  }

  /** A switch made by hand or followed from outside; rotation records its own switches with more detail. */
  private recordSwitch(provider: AuthProvider, previous: string | undefined, id: string, reason: 'manual' | 'external'): void {
    if (previous === id) { return; }
    const stayedMs = previous ? this.automation.stayed(provider, previous) : undefined;
    this.history.record({ type: 'switch', provider, reason, automatic: false,
      ...(previous ? { from: this.automation.account(provider, previous) } : {}), to: this.automation.account(provider, id),
      ...(stayedMs !== undefined ? { stayedMs } : {}),
      fromUsage: previous ? usageSnapshot(this.automation.usage(provider, previous)) : undefined,
      toUsage: usageSnapshot(this.automation.usage(provider, id)) });
  }

  /** Follows a native login switched outside the service and records it; returns whether the active profile changed. */
  private async followNative(provider: AuthProvider): Promise<boolean> {
    const previous = this.store.activeProfileId(provider);
    const changed = await this.store.followNative(provider);
    if (changed) {
      const current = this.store.activeProfileId(provider);
      if (current) { this.recordSwitch(provider, previous, current, 'external'); }
    }
    return changed;
  }

  historyInfo(): HistoryInfo {
    const files = this.history.files();
    const oldest = files.length ? historyFileStart(path.basename(files[0])) : undefined;
    return { enabled: this.history.enabled, location: this.history.location, retentionDays: Math.round(this.history.retentionMs / 86_400_000), files,
      ...(oldest !== undefined ? { oldestAt: new Date(oldest).toISOString() } : {}) };
  }

  /** The last `days` days, or everything kept, summarized with the rotation thresholds in effect. */
  historySummary(days?: number): HistorySummaryResult {
    const files = this.history.files();
    const now = this.now();
    const oldest = files.length ? historyFileStart(path.basename(files[0])) : undefined;
    const since = days ? now - days * 86_400_000 : oldest ?? now;
    const thresholds: Partial<Record<AuthProvider, Thresholds>> = {};
    for (const provider of PROVIDERS) {
      const settings = automationSettings(this.config, provider);
      thresholds[provider] = { fiveHourThresholdPercent: settings.fiveHourThresholdPercent, weeklyThresholdPercent: settings.weeklyThresholdPercent };
    }
    const summary = summarizeHistory(this.history.events(since), { since, until: now, thresholds });
    const label = days ? `the last ${days} days` : 'everything kept';
    const markdown = renderHistoryReport(summary, { label, location: this.history.location, files: files.length, retentionDays: Math.round(this.history.retentionMs / 86_400_000) });
    return { markdown, since: new Date(since).toISOString(), until: new Date(now).toISOString(), label, summary };
  }

  historyExport(kind: HistoryExportKind): { text: string; extension: string } {
    if (kind === 'readings') { return { text: readingsCsv(this.history.events()), extension: 'csv' }; }
    if (kind === 'events') { return { text: eventsCsv(this.history.events()), extension: 'csv' }; }
    return { text: this.history.files().map((file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } }).join(''), extension: 'jsonl' };
  }

  /** Starts the periodic work; `tick` runs at once and then every minute. */
  start(): void {
    if (this.timer) { return; }
    // Background work writes credentials, native settings and state: only the owner of the home may run it.
    if (!this.options.ownership) { throw new Error('The account service engine needs the ownership of its home to start; start it through startServiceHost.'); }
    this.options.ownership.assertHeld();
    this.statusLifecycle = 'running';
    this.refreshStatus();
    this.history.prune();
    this.timer = setInterval(() => void this.tick().catch(() => undefined), TICK_MS);
    this.timer.unref?.();
    this.background(() => this.runtime.start());
    this.usageTimer = setInterval(() => void this.pollUsage(), 5_000);
    this.usageTimer.unref?.();
    void this.pollUsage();
    void this.tick();
  }

  /**
   * Stops admitting work, waits for every admitted request and background job to finish (queued ones are refused when
   * they reach the front), then stops the proxy and the bridge. Resolves once all of that is over; rejects when it
   * could not be proven within the drain timeout or the bridge did not exit, and may then be called again.
   */
  dispose(): Promise<void> {
    if (this.disposing) { return this.disposing; }
    this.disposed = true;
    this.statusLifecycle = 'stopping';
    if (this.statusTimer) clearTimeout(this.statusTimer);
    this.statusTimer = undefined;
    this.refreshStatus();
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    this.automation.dispose();
    this.usageMonitor.dispose();
    if (this.usageTimer) clearInterval(this.usageTimer);
    this.usageContexts.clear();
    for (const controller of this.cancels.values()) { controller.abort(); }
    const attempt = (async () => {
      await this.drain(this.options.drainTimeoutMs ?? 30_000);
      await this.runtime.dispose();
      this.statusLifecycle = 'stopped';
      this.retainedStatus.clear();
      this.retainedCopilotAccount.clear();
      this.retainedAttribution.clear();
      this.refreshStatus();
    })();
    this.disposing = attempt;
    attempt.catch(() => { if (this.disposing === attempt) { this.disposing = undefined; } });
    return attempt;
  }

  /** Waits until no admitted work is left, or throws after `timeoutMs`. */
  private async drain(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.inflight.size) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) { throw new Error(`${this.inflight.size} operation(s) of the account service did not finish within ${Math.round(timeoutMs / 1000)} s`); }
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([Promise.allSettled([...this.inflight]), new Promise((resolve) => { timer = setTimeout(resolve, remaining); })]);
      clearTimeout(timer);
    }
  }

  /**
   * Starts work that belongs to the engine rather than to the request that triggered it: outside that request's scope
   * (its cancellation does not stop a sweep), and tracked so `dispose` waits for it.
   */
  private background(work: () => Promise<unknown>): void {
    if (this.disposed) { return; }
    this.requestScope.exit(() => { void this.track(work()).catch((error: unknown) => this.log(`background: ${error instanceof Error ? error.message : String(error)}`)); });
  }

  /** Counts `work` as admitted until it settles. */
  private track<T>(work: Promise<T>): Promise<T> {
    this.inflight.add(work);
    const done = () => { this.inflight.delete(work); };
    work.then(done, done);
    return work;
  }

  /**
   * Whether queued work may still run: not when the engine is stopping, when the request it runs for was cancelled,
   * or (for a change) when this engine no longer owns its home.
   */
  private admit(): void {
    if (this.disposed) { throw new RpcError('the account service is stopping', 'closed'); }
    const scope = this.requestScope.getStore();
    if (scope?.signal?.aborted) { throw new RpcError(`${scope.method} was cancelled`, 'cancelled'); }
    if (this.options.ownership && (!scope || !READ_ONLY_METHODS.has(scope.method))) { this.options.ownership.assertHeld(); }
  }

  emit(event: ServiceEvent): void {
    this.events.emit('event', event);
    if (['usageChanged', 'stateChanged', 'configChanged'].includes(event.event) && this.store && this.automation) this.refreshStatus();
    if (event.event === 'stateChanged') {
      for (const provider of event.provider ? [event.provider] : PROVIDERS) this.events.emit('event', { event: 'usageChanged', provider });
    }
  }

  // --- project folders of the connected clients -----------------------------------------------------------------

  /** Replaces the folders a client declared (at its hello, or later); the store lists the union of all clients'. */
  declareFolders(clientId: number, folders: string[]): void {
    this.foldersByClient.set(clientId, folders);
    this.applyFolders();
  }

  forgetFolders(clientId: number): void {
    this.automation.forgetResetClient(clientId);
    this.usageContexts.delete(clientId);
    this.retainedStatus.delete(`copilot:${clientId}`);
    this.retainedCopilotAccount.delete(`copilot:${clientId}`);
    this.retainedAttribution.delete(`copilot:${clientId}`);
    this.refreshStatus();
    this.sessionDirectories.delete(clientId);
    if (this.foldersByClient.delete(clientId)) { this.applyFolders(); }
  }

  /** The workspace a connection declared, or undefined for none (the command line, background work). */
  workspaceContext(clientId: number | undefined): WorkspaceContext | undefined {
    if (clientId === undefined) { return undefined; }
    const folders = this.foldersByClient.get(clientId);
    const github = this.usageContexts.get(clientId);
    const sessionDirectory = this.sessionDirectories.get(clientId);
    if (!folders && !github && !sessionDirectory) { return undefined; }
    return { folders: [...(folders ?? [])], ...(github ? { github } : {}), ...(sessionDirectory ? { sessionDirectory: { ...sessionDirectory } } : {}) };
  }

  /** `workspace.context`: replaces the parts given; the rest of the connection's context stays. */
  private setWorkspaceContext(clientId: number, params: Record<string, unknown>): WorkspaceContext {
    if (Array.isArray(params.folders)) { this.declareFolders(clientId, params.folders.filter((folder): folder is string => typeof folder === 'string').slice(0, 100)); }
    if (params.github !== undefined) {
      this.usageContexts.set(clientId, githubContext(objectParams(params.github)));
      this.retainedStatus.delete(`copilot:${clientId}`);
      this.retainedCopilotAccount.delete(`copilot:${clientId}`);
      this.retainedAttribution.delete(`copilot:${clientId}`);
      this.refreshStatus();
    }
    if (params.sessionDirectory !== undefined) {
      const raw = objectParams(params.sessionDirectory);
      const directories: Partial<Record<AuthProvider, string>> = {};
      for (const provider of PROVIDERS) {
        const value = raw[provider];
        if (typeof value === 'string' && value.trim()) { directories[provider] = value; }
      }
      if (Object.keys(directories).length) { this.sessionDirectories.set(clientId, directories); } else { this.sessionDirectories.delete(clientId); }
    }
    return this.workspaceContext(clientId) ?? { folders: [] };
  }

  /** The bridge context of a request: the calling connection's workspace, or none for background work. */
  private bridgeContext(clientId: number | undefined): BridgeWorkspaceContext | undefined {
    const context = this.workspaceContext(clientId);
    return context ? { folders: context.folders, ...(context.sessionDirectory ? { sessionDirectory: context.sessionDirectory } : {}) } : undefined;
  }

  private applyFolders(): void {
    const union = [...new Set([...this.foldersByClient.values()].flat())];
    if (this.store.setProjectFolders(union)) {
      this.log(`project folders: ${union.length ? union.join(', ') : 'none'}`);
      for (const provider of PROVIDERS) { this.emit({ event: 'stateChanged', provider }); }
    }
  }

  // --- checks requested by hand -------------------------------------------------------------------------------------

  /** The lock wait a request asked for; a request with a token can be cancelled through `automation.cancel`. */
  private waitFor(provider: AuthProvider, params: Record<string, unknown>, request?: RequestContext): LockWait & { token?: string } {
    const token = typeof params.token === 'string' && params.token ? params.token : undefined;
    const controller = new AbortController();
    // Cancelling the request, or the connection closing, ends the wait like `automation.cancel` does.
    if (request?.signal) {
      if (request.signal.aborted) { controller.abort(); }
      else { request.signal.addEventListener('abort', () => controller.abort(), { once: true }); }
    }
    if (token) { this.cancels.get(token)?.abort(); this.cancels.set(token, controller); }
    const waitMs = typeof params.waitMs === 'number' && Number.isFinite(params.waitMs) ? Math.max(0, params.waitMs) : MANUAL_CHECK_WAIT_MS;
    return { token, waitMs, signal: controller.signal, onWait: () => this.emit({ event: 'waiting', provider, token }) };
  }

  private releaseWait(wait: { token?: string; signal?: AbortSignal }): void {
    if (wait.token && this.cancels.get(wait.token)?.signal === wait.signal) { this.cancels.delete(wait.token); }
  }

  /** One keep-alive sweep over `profiles` under one lock, spaced, stopping on cancel or on a sign-in's hold. */
  private async keepAliveAll(provider: AuthProvider, profiles: ProfileMetadata[], wait: LockWait & { token?: string }): Promise<KeepAliveAllResult> {
    const result: KeepAliveAllResult = { results: [], done: 0, total: profiles.length, cancelled: false };
    const signal = wait.signal;
    try {
      await this.automation.withAccountLock(provider, async () => {
        for (const [index, profile] of profiles.entries()) {
          if (signal?.aborted) { result.cancelled = true; break; }
          // Space the calls so a sweep of every account does not burst the provider's usage endpoint.
          if (index > 0) { await sleep(KEEP_ALIVE_ALL_SPACING_MS, signal); }
          if (signal?.aborted) { result.cancelled = true; break; }
          this.emit({ event: 'keepAliveProgress', provider, token: wait.token, index, total: profiles.length, id: profile.id, name: profile.name });
          try {
            const outcome = await this.automation.sendKeepAliveNow(provider, profile.id);
            result.results.push({ id: profile.id, name: profile.name, ...serializeKeepAlive(outcome) });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            // A sign-in started meanwhile holds every check of this service; the rest of the sweep would only fail the same way.
            if (/sign-in is in progress/i.test(message)) { result.blocked = message.replace(/\.$/, ''); break; }
            result.results.push({ id: profile.id, name: profile.name, error: message });
          }
          result.done++;
        }
      }, wait);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (signal?.aborted) { result.cancelled = true; }
      else if (/already running/i.test(message)) { result.blocked = `another ${TITLES[provider]} account check was still running after ${Math.round((wait.waitMs ?? 0) / 60_000)} minutes`; }
      else { throw error; }
    }
    return result;
  }

  /** One round of the periodic work: follow outside switches, sweep, retry the Claude identity sync. */
  tick(): Promise<void> {
    if (this.disposed) { return Promise.resolve(); }
    if (this.options.ownership && !this.options.ownership.held()) { return Promise.resolve(); }
    return this.track(this.tickNow());
  }

  private async tickNow(): Promise<void> {
    this.reloadConfigIfChanged();
    for (const provider of PROVIDERS) {
      try {
        if (await this.followNative(provider)) { this.emit({ event: 'stateChanged', provider }); }
      } catch (error) { this.log(`${provider}: could not follow the native login: ${error instanceof Error ? error.message : String(error)}`); }
    }
    await this.automation.tick();
    await this.retryClaudeAccountMetadata();
    this.history.pruneIfDue();
    await this.runtime.sync();
  }

  info(): ServiceInfo & Partial<HostIdentity> & { configRevision: number } {
    return { version: this.options.version, pid: process.pid, startedAt: this.startedAt.toISOString(), home: this.options.home,
      node: process.execPath, socket: '', clients: this.clientCount(), profileStore: this.store.privateBackend.kind,
      ...(this.hostIdentity ?? {}), configRevision: this.configAuthority.revision };
  }

  async snapshot(): Promise<Snapshot> {
    const providers = {} as Record<AuthProvider, ProviderView>;
    for (const provider of PROVIDERS) { providers[provider] = await this.providerView(provider); }
    return { service: this.info(), providers, config: this.config };
  }

  async providerView(provider: AuthProvider): Promise<ProviderView> {
    try { if (await this.followNative(provider)) { this.emit({ event: 'stateChanged', provider }); } } catch { /* Reported by tick. */ }
    const activeProfileId = this.store.activeProfileId(provider);
    const profiles = this.store.profiles(provider).map((profile, index) => this.profileView(provider, profile, index + 1, profile.id === activeProfileId));
    const settings = automationSettings(this.config, provider);
    return {
      provider, title: TITLES[provider], profiles, activeProfileId,
      activeNumber: this.store.activeProfileNumber(provider),
      nativeUnsaved: this.store.nativeIsUnsaved(provider),
      checkingActive: this.automation.isCheckingActive(provider),
      keepAlive: settings.enabled, autoRotate: settings.autoRotate,
      strategySummary: strategySummary(this.config, provider),
      scopes: this.store.scopes()
    };
  }

  private profileView(provider: AuthProvider, profile: ProfileMetadata, number: number, active: boolean): ProfileView {
    const state = this.automation.accountState(provider, profile.id);
    const problems: ProfileView['problems'] = [];
    for (const [check, raw] of [['keepAlive', state.keepAliveError], ['usage', state.lastError]] as const) {
      if (!raw) { continue; }
      const problem = explainAccountProblem(raw);
      problems.push({ check, raw, label: problem.label, advice: problem.advice, known: problem.known });
    }
    return {
      ...profile, active, number,
      usage: this.automation.usage(provider, profile.id) ? state.usage as SerializedUsage : undefined,
      checkedAt: isoOrUndefined(state.checkedAt),
      lastKeepAliveAt: isoOrUndefined(state.lastKeepAliveAt),
      problems,
      limit: this.automation.limitState(provider, profile.id),
      loginProblem: this.automation.loginProblem(provider, profile.id),
      hasCredential: this.store.hasCredential(provider, profile.id),
      folder: profile.folder
    };
  }

  // --- activation and its verification -------------------------------------------------------------------

  private async activate(provider: AuthProvider, id: string, automatic: boolean): Promise<ActivationOutcome> {
    const previous = this.store.activeProfileId(provider);
    const outcome = await this.store.activateProfile(provider, id, automatic);
    // Rotation records its switches itself, with the candidates it considered.
    if (!automatic) { this.recordSwitch(provider, previous, id, 'manual'); }
    this.emit({ event: 'activated', provider, id: outcome.profile.id, name: outcome.profile.name, email: outcome.profile.email, automatic,
      accountChanged: outcome.accountChanged, level: outcome.level, message: outcome.message });
    this.emit({ event: 'stateChanged', provider });
    return outcome;
  }

  private async verifyActivation(provider: AuthProvider, credential: StoredCredential, expected: CredentialIdentity) {
    if (provider === 'codex') {
      // A fresh app-server must see the login that was just written; report a mismatch instead of success.
      return (this.options.verifyCodex ?? verifyCodexNativeAccount)(credential, this.config.codex.cliPath || 'codex');
    }
    // Claude Code renders /status and /usage identity from its separate account file. Keep that metadata and its
    // account-bound caches aligned with the exact OAuth token that activation just wrote.
    const outcome = await (this.options.syncClaudeMetadata ?? activateClaudeAccountMetadata)(credential, expected);
    if (outcome.status === 'synced') {
      this.claudeMetadataRetry = undefined;
      return { status: 'match' as const, detail: outcome.detail, ...outcome.identity };
    }
    // The identity is unconfirmed, usually because the endpoint is rate-limiting this account. Keep asking in the
    // background so /status and /usage stop lagging behind the switch without anyone doing anything.
    this.claudeMetadataRetry = { nextAttemptAt: this.now() + Math.max(outcome.retryAfterMs ?? 0, CLAUDE_METADATA_RETRY_MS), attempts: 0 };
    return { status: 'unverified' as const, detail: outcome.detail };
  }

  /**
   * Retries the Claude identity sync for a switch whose profile lookup failed. The native credential is re-read every
   * attempt, so a token the CLI refreshed in the meantime is used, and a later switch simply retargets the retry.
   */
  private async retryClaudeAccountMetadata(): Promise<void> {
    const pending = this.claudeMetadataRetry;
    if (!pending || this.now() < pending.nextAttemptAt) { return; }
    const expected = this.store.activeIdentity('claude');
    // Claude Code refreshes its own profile after a switch; once it has, there is nothing left to correct.
    if (claudeAccountFileConfirms(expected)) {
      this.claudeMetadataRetry = undefined;
      this.log(`claude: account metadata already names the activated login (${expected.email ?? expected.accountId})`);
      return;
    }
    let credential: StoredCredential;
    try {
      credential = readNativeCredential('claude');
    } catch (error) {
      this.claudeMetadataRetry = undefined;
      this.log(`claude: stopped confirming the activated login, no readable native credential: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const outcome = await (this.options.syncClaudeMetadata ?? activateClaudeAccountMetadata)(credential, expected);
    if (outcome.status === 'synced') {
      this.claudeMetadataRetry = undefined;
      this.log(`claude: account metadata confirmed on retry — ${outcome.detail}`);
      return;
    }
    pending.attempts += 1;
    if (pending.attempts >= CLAUDE_METADATA_RETRY_LIMIT) {
      this.claudeMetadataRetry = undefined;
      this.log(`claude: gave up confirming the activated login after ${pending.attempts} attempts — ${outcome.detail}`);
      return;
    }
    // Back off linearly, and never sooner than the endpoint asked for.
    pending.nextAttemptAt = this.now() + Math.max(outcome.retryAfterMs ?? 0, CLAUDE_METADATA_RETRY_MS * Math.min(pending.attempts, 5));
    this.log(`claude: could not confirm the activated login (attempt ${pending.attempts}) — ${outcome.detail}`);
  }

  // --- configuration ----------------------------------------------------------------------------------------

  /** A hand-edited config.json is picked up on the next tick; an unreadable one keeps the current settings. */
  private reloadConfigIfChanged(): void {
    const changed = this.configAuthority.reloadIfChanged();
    if (!changed?.length) { return; }
    this.log(`config: reloaded config.json after it changed on disk (${changed.join(', ')})`);
    this.afterConfigChange(changed, 'file');
  }

  private afterConfigChange(changed: string[], source: string): void {
    if (changed.some((key) => key.startsWith('history.'))) { this.applyHistoryConfig(); }
    this.emit({ event: 'configChanged', config: this.config, revision: this.configAuthority.revision, changed, source } as ServiceEvent);
    this.background(() => this.runtime.sync());
    if (this.timer) this.background(() => this.pollUsage());
    // A switch that was just turned on should act now, not in a minute.
    if (this.timer) this.background(() => this.automation.tick());
  }

  /**
   * Applies `values` (dotted keys such as `claude.autoRotate.enabled`) and saves. With `baseRevision`, keys someone
   * else changed after it are refused (`config-conflict`) and nothing is applied. Unchanged values emit nothing.
   */
  patchConfig(values: Record<string, unknown>, options: { baseRevision?: number; source?: string; refuseLocal?: boolean } = {}): ConfigPatchResult {
    const result = this.configAuthority.patch(values, options);
    if (!result.changed.length) { return result; }
    this.log(`config: changed ${result.changed.map((key) => `${key} = ${JSON.stringify(getValue(result.config, key))}`).join(', ')}${options.source ? ` (${options.source})` : ''} → revision ${result.revision}`);
    this.afterConfigChange(result.changed, options.source ?? 'client');
    return result;
  }

  /** Unconditional change, as `ai-usage config` and older clients make it. */
  setConfig(values: Record<string, unknown>): ServiceConfig {
    return this.patchConfig(values, { source: 'set' }).config;
  }

  configView(): ConfigView { return this.configAuthority.view(); }

  // --- sign-in with the vendor CLI ------------------------------------------------------------------------------

  /** The command a client runs in a terminal to sign in for a profile, with a home that cannot touch the active login. */
  prepareSignIn(provider: AuthProvider): SignInPreparation {
    const settings = automationSettings(this.config, provider);
    const cli = resolveCli(settings.cliPath);
    if (!cli) { throw new Error(`${settings.cliPath} was not found. Check the ${provider} CLI path setting.`); }
    const home = loginHome(provider, settings.home);
    const file = stagedCredentialPath(provider, home);
    // A leftover from an earlier sign-in must not be mistaken for this one.
    fs.rmSync(file, { force: true });
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(isolatedEnvironment(provider, home))) {
      if (typeof value === 'string') { env[key] = value; }
    }
    // The user is about to attend a browser sign-in; keep-alives and sweeps of this service wait until it is over,
    // so no check competes with it and no notification about another account interrupts it.
    this.automation.hold(provider, `a ${TITLES[provider]} sign-in is in progress`);
    return { cli, args: loginArgs(provider), cwd: home, env, file };
  }

  /** Reads the login the vendor CLI wrote and stores it in the profile; the file is removed once it is taken. */
  async finishSignIn(provider: AuthProvider, id: string, allowOtherAccount: boolean): Promise<SignInResult> {
    const profile = this.store.profile(provider, id);
    if (!profile) { throw new Error('The profile no longer exists.'); }
    const settings = automationSettings(this.config, provider);
    const file = stagedCredentialPath(provider, loginHome(provider, settings.home));
    let credential: StoredCredential;
    try { credential = parseCredentialJson(provider, fs.readFileSync(file, 'utf8')); }
    catch { this.automation.resume(provider); throw new Error('The sign-in was not completed: the CLI wrote no login.'); }
    const identity = await this.store.identity(provider, credential);
    const otherAccount = (profile.accountId && identity.accountId && profile.accountId !== identity.accountId) ||
      (profile.email && identity.email && profile.email.toLowerCase() !== identity.email.toLowerCase());
    if (otherAccount && !allowOtherAccount) {
      return { status: 'otherAccount', identity,
        message: `You signed in as ${identity.email ?? identity.accountId}, but the profile “${profile.name}” holds ${profile.email ?? profile.accountId}.` };
    }
    const active = await this.automation.withPaused(() => this.store.replaceCredential(provider, id, credential));
    fs.rmSync(file, { force: true });
    this.automation.resume(provider);
    this.emit({ event: 'stateChanged', provider });
    // The login is saved either way; a busy check elsewhere only delays the usage reading.
    const result = await this.automation.credentialReplaced(provider, id).catch((error: unknown): KeepAliveNowResult =>
      ({ usage: undefined, usageError: error instanceof Error ? error.message : String(error) }));
    this.emit({ event: 'stateChanged', provider });
    const signedInAs = identity.email ? ` as ${identity.email}` : '';
    const usageNote = result.usage ? ' Usage statistics updated.' : result.usageError ? ` Usage could not be read yet: ${readableProblem(result.usageError)}` : '';
    return { status: 'replaced', active, identity, message: `${TITLES[provider]} profile “${profile.name}” signed in again${signedInAs}.${usageNote}` };
  }

  cancelSignIn(provider: AuthProvider): void {
    const settings = automationSettings(this.config, provider);
    fs.rmSync(stagedCredentialPath(provider, loginHome(provider, settings.home)), { force: true });
    this.automation.resume(provider);
  }

  // --- import and export ---------------------------------------------------------------------------------------

  private planViews(plans: Array<ImportPlan<ProfileMetadata>>): ImportPlanView[] {
    return plans.map((plan) => ({
      provider: plan.entry.provider, id: plan.entry.id, name: plan.entry.name, email: plan.entry.email, kind: plan.kind,
      target: plan.target ? { id: plan.target.id, name: plan.target.name } : undefined,
      outcome: importOutcome(plan), suggested: plan.kind === 'new' || plan.kind === 'restore'
    }));
  }

  private entriesParam(params: Record<string, unknown>): ExportedProfile[] {
    if (typeof params.text === 'string') { return parseProfileExport(params.text); }
    if (Array.isArray(params.entries)) { return parseProfileExport(JSON.stringify({ aiUsageProfiles: 1, profiles: params.entries })); }
    throw new Error('Nothing to import: pass the export text or its entries.');
  }

  // --- the method dispatcher -----------------------------------------------------------------------------------

  /**
   * Runs one request. It is admitted only while the engine runs and owns its home (for a change) and the request is
   * neither cancelled nor past its deadline; once admitted, `dispose` waits for it, and operations it queues behind a
   * sweep or the account lock check again before they run.
   */
  handle(method: string, rawParams: unknown, clientId?: number, request?: RequestContext): Promise<unknown> {
    if (request?.signal?.aborted) { return Promise.reject(new RpcError(`${method} was cancelled before it started`, 'cancelled')); }
    if (request?.deadlineAt !== undefined && Date.now() > request.deadlineAt) { return Promise.reject(new RpcError(`${method} arrived after its deadline`, 'timeout')); }
    if (this.disposed) { return Promise.reject(new RpcError('the account service is stopping', 'closed')); }
    // Every change goes through the owner of the home; an engine that lost its lease only answers reads.
    if (this.options.ownership && !READ_ONLY_METHODS.has(method)) {
      try { this.options.ownership.assertHeld(); } catch (error) { return Promise.reject(error); }
    }
    return this.track(this.requestScope.run({ method, signal: request?.signal }, () => this.dispatch(method, objectParams(rawParams), clientId, request)));
  }

  private async dispatch(method: string, params: Record<string, unknown>, clientId: number | undefined, request: RequestContext | undefined): Promise<unknown> {
    const paused = <T>(operation: () => Promise<T>) => this.automation.withPaused(operation);
    switch (method) {
      case 'status.snapshot': return this.statusSnapshot(this.statusFilter(params), clientId);
      case 'reset.confirmations': return this.automation.resetConfirmations();
      case 'reset.claim': {
        if (clientId === undefined) throw new RpcError('Confirmation needs a connected client.', 'invalid_params');
        return this.automation.claimReset(stringParam(params, 'id'), clientId);
      }
      case 'reset.resolve': {
        if (typeof params.approve !== 'boolean') throw new RpcError('Choose approve or cancel.', 'invalid_params');
        return this.automation.resolveReset(stringParam(params, 'id'), params.approve, clientId, { waitMs: MANUAL_CHECK_WAIT_MS, signal: request?.signal });
      }
      case 'service.info': return this.info();
      case 'runtime.staleCodex': return findStaleCodexProcesses(Number(params.switchedAt), Number(params.parentPid));
      case 'mcp.registration': {
        // The installed launcher, or the bundled adapter when nothing is installed; either only connects to the engine.
        const provider = providerParam(params), command = mcpCommand(this.options.home);
        return { launcher: command.command, command, ...mcpCli(provider, this.config[provider].cliPath), registration: readMcpRegistration(provider, command) };
      }
      case 'mcp.register':
      case 'mcp.unregister': {
        const provider = providerParam(params), resolved = mcpCli(provider, this.config[provider].cliPath);
        if (!resolved.cli) throw new Error(resolved.reason);
        return method === 'mcp.register' ? registerMcpServer(provider, resolved.cli, mcpCommand(this.options.home)) : unregisterMcpServer(provider, resolved.cli);
      }
      case 'runtime.status': return { codexProxyActive: this.runtime.proxy.active };
      // The calling connection's workspace goes with the request, never another window's or a union of them.
      case 'bridge.ensure': return this.runtime.bridge.ensure(this.bridgeContext(clientId));
      case 'bridge.connection': return this.runtime.bridge.connection(this.bridgeContext(clientId));
      case 'bridge.sync': await this.runtime.bridge.syncSettings(this.bridgeContext(clientId)); return { ok: true };
      case 'workspace.context': {
        if (clientId === undefined) throw new Error('A workspace context needs a connected client.');
        return this.setWorkspaceContext(clientId, params);
      }
      case 'usage.context': {
        if (clientId === undefined) throw new Error('Usage context needs a connected client.');
        this.usageContexts.set(clientId, githubContext(params));
        this.retainedStatus.delete(`copilot:${clientId}`);
        this.retainedCopilotAccount.delete(`copilot:${clientId}`);
        this.retainedAttribution.delete(`copilot:${clientId}`);
        this.refreshStatus();
        return { ok: true };
      }
      case 'usage.live': {
        const provider = params.provider;
        if (provider !== 'claude' && provider !== 'codex' && provider !== 'copilot') throw new RpcError('Unknown usage provider.', 'invalid_params');
        return this.liveUsage(provider, params.force === true, clientId);
      }
      case 'usage.sessionTokens': {
        const provider = providerParam(params);
        return readCurrentSessionTokens(provider, this.foldersByClient.get(clientId ?? -1) ?? []) ?? null;
      }
      case 'rotation.diagnostics': return this.automation.diagnostics(providerParam(params));
      case 'snapshot': return this.snapshot();
      case 'profiles.list': return this.providerView(providerParam(params));
      case 'session.folders': {
        if (clientId === undefined) { throw new Error('Only a connected client can declare project folders.'); }
        this.declareFolders(clientId, Array.isArray(params.folders) ? params.folders.filter((folder): folder is string => typeof folder === 'string') : []);
        return { ok: true };
      }
      case 'profiles.activate': {
        const provider = providerParam(params);
        const profile = this.resolveParam(provider, params);
        const outcome = await paused(() => this.automation.withAccountLock(provider, () => this.activate(provider, profile.id, false), { waitMs: MANUAL_CHECK_WAIT_MS }));
        const result: ActivationResult = { profile: { id: outcome.profile.id, name: outcome.profile.name, email: outcome.profile.email },
          verification: outcome.verification, level: outcome.level, message: outcome.message, accountChanged: outcome.accountChanged };
        this.background(() => this.automation.tick());
        return result;
      }
      case 'profiles.saveNative': {
        const provider = providerParam(params);
        const outcome = await paused(() => this.store.saveNative(provider, {
          name: typeof params.name === 'string' ? params.name : undefined,
          id: typeof params.id === 'string' ? params.id : undefined,
          allowDuplicate: params.allowDuplicate === true,
          folder: typeof params.folder === 'string' && params.folder ? params.folder : undefined
        }));
        if (outcome.status !== 'duplicate') { this.emit({ event: 'stateChanged', provider }); this.background(() => this.automation.tick()); }
        return outcome as SaveNativeResult;
      }
      case 'profiles.importCredential': {
        const provider = providerParam(params);
        const outcome = await paused(() => this.store.importCredential(provider, stringParam(params, 'name'), params.credential, params.allowDuplicate === true,
          typeof params.folder === 'string' && params.folder ? params.folder : undefined));
        if (outcome.status !== 'duplicate') { this.emit({ event: 'stateChanged', provider }); this.background(() => this.automation.tick()); }
        return outcome as SaveNativeResult;
      }
      case 'profiles.rename': {
        const provider = providerParam(params);
        const profile = this.resolveParam(provider, params);
        const renamed = await paused(async () => this.store.rename(provider, profile.id, stringParam(params, 'name')));
        this.emit({ event: 'stateChanged', provider });
        return renamed;
      }
      case 'profiles.reorder': {
        const provider = providerParam(params);
        const profile = this.resolveParam(provider, params);
        if (params.step !== -1 && params.step !== 1) { throw new Error('Step must be -1 or 1.'); }
        const profiles = await paused(async () => this.store.reorder(provider, profile.id, params.step as -1 | 1));
        this.emit({ event: 'stateChanged', provider });
        return profiles;
      }
      case 'profiles.delete': {
        const provider = providerParam(params);
        const profile = this.resolveParam(provider, params);
        const deleted = await paused(async () => this.store.delete(provider, profile.id));
        this.emit({ event: 'stateChanged', provider });
        return deleted;
      }
      case 'profiles.export': {
        const selection = Array.isArray(params.selection)
          ? params.selection.map((entry) => ({ provider: providerParam(objectParams(entry)), id: stringParam(objectParams(entry), 'id') })) : undefined;
        const { entries, missing } = this.store.exportEntries(selection);
        const result: ExportResult = { entries, missing, text: serializeProfileExport(entries) };
        this.log(`exported ${entries.length} authentication profiles`);
        return result;
      }
      case 'profiles.planImport': return this.planViews(this.store.planImport(this.entriesParam(params)));
      case 'profiles.applyImport': {
        const plans = this.store.planImport(this.entriesParam(params));
        const chosen = Array.isArray(params.chosen)
          ? plans.filter((plan) => (params.chosen as unknown[]).some((wanted) => {
            const entry = objectParams(wanted);
            return entry.provider === plan.entry.provider && entry.id === plan.entry.id;
          }))
          : plans.filter((plan) => plan.kind === 'new' || plan.kind === 'restore');
        if (!chosen.length) { return { imported: 0, counts: { new: 0, restore: 0, replace: 0, same: 0 }, summary: 'nothing to import' } satisfies ImportSummary; }
        const outcome = await paused(() => this.store.applyImport(chosen));
        for (const provider of PROVIDERS) { this.emit({ event: 'stateChanged', provider }); }
        this.background(() => this.automation.tick());
        return outcome satisfies ImportSummary;
      }
      case 'profiles.signIn.prepare': return this.prepareSignIn(providerParam(params));
      case 'profiles.signIn.finish': {
        const provider = providerParam(params);
        return this.finishSignIn(provider, this.resolveParam(provider, params).id, params.allowOtherAccount === true);
      }
      case 'profiles.signIn.cancel': this.cancelSignIn(providerParam(params)); return { ok: true };
      case 'automation.keepAliveNow': {
        const provider = providerParam(params);
        const profile = this.resolveParam(provider, params);
        const wait = this.waitFor(provider, params, request);
        try {
          const result = await this.automation.sendKeepAliveNow(provider, profile.id, { callerReports: params.callerReports === true, wait });
          this.emit({ event: 'stateChanged', provider });
          return serializeKeepAlive(result);
        } finally { this.releaseWait(wait); }
      }
      case 'automation.keepAliveAll': {
        const provider = providerParam(params);
        const saved = this.store.profiles(provider);
        const profiles = Array.isArray(params.ids)
          ? (params.ids as unknown[]).flatMap((id) => { const profile = saved.find((candidate) => candidate.id === id); return profile ? [profile] : []; })
          : saved;
        const wait = this.waitFor(provider, params, request);
        try {
          const result = await this.keepAliveAll(provider, profiles, wait);
          this.emit({ event: 'stateChanged', provider });
          return result;
        } finally { this.releaseWait(wait); }
      }
      case 'automation.cancel': {
        const token = stringParam(params, 'token');
        this.cancels.get(token)?.abort();
        return { ok: true };
      }
      case 'automation.rotateNow': {
        const provider = providerParam(params);
        const wait = this.waitFor(provider, params, request);
        try {
          const outcome = await this.automation.rotateNow(provider, wait);
          this.emit({ event: 'stateChanged', provider });
          return { ...outcome, activeProfileId: this.store.activeProfileId(provider), activeProfileName: this.store.activeProfileName(provider) };
        } finally { this.releaseWait(wait); }
      }
      case 'automation.tick': await this.tick(); return { ok: true };
      case 'usage.read': {
        const provider = providerParam(params);
        const profile = this.resolveParam(provider, params);
        const result = await this.automation.readUsageNow(provider, profile.id);
        this.emit({ event: 'stateChanged', provider });
        return { profile: { id: profile.id, name: profile.name, email: profile.email }, ...serializeKeepAlive(result) } satisfies UsageReadResult;
      }
      case 'usage.observe':
      case 'usage.hintLimit': throw new Error('Usage is collected by the service; use usage.live or usage.read.');
      case 'history.info': return this.historyInfo();
      case 'history.summary': return this.historySummary(typeof params.days === 'number' && params.days > 0 ? params.days : undefined);
      case 'history.export': {
        const kind = params.kind;
        if (kind !== 'readings' && kind !== 'events' && kind !== 'jsonl') { throw new Error('Choose what to export: readings, events or jsonl.'); }
        return this.historyExport(kind);
      }
      case 'config.get': return this.config;
      case 'config.read': return this.configView();
      case 'config.set': return this.setConfig(objectParams(params.values));
      case 'config.patch': {
        const base = params.baseRevision;
        if (base !== undefined && (typeof base !== 'number' || !Number.isInteger(base) || base < 0)) { throw new RpcError('baseRevision must be a revision number.', 'invalid_params'); }
        return this.patchConfig(objectParams(params.values), { baseRevision: base as number | undefined, refuseLocal: true,
          source: typeof params.source === 'string' && params.source ? params.source.slice(0, 80) : `client #${clientId ?? '?'}` });
      }
      default: throw new RpcError(`Unknown method ${method}.`, 'unknown_method');
    }
  }

  /** `id`, or a `ref` (name, number or id), must name a saved profile. */
  private resolveParam(provider: AuthProvider, params: Record<string, unknown>): ProfileMetadata {
    if (typeof params.id === 'string' && params.id) {
      const profile = this.store.profile(provider, params.id);
      if (!profile) { throw new Error('The profile no longer exists.'); }
      return profile;
    }
    const reference = stringParam(params, 'ref');
    const profile = this.store.resolve(provider, reference);
    if (!profile) { throw new Error(`No ${TITLES[provider]} profile matches "${reference}". Run "ai-usage list ${provider}" to see them.`); }
    return profile;
  }
}

/** GitHub sign-ins a connection supplies for Copilot, bounded. */
function githubContext(params: Record<string, unknown>): UsageContext {
  const accounts = Array.isArray(params.accounts) ? params.accounts.filter((a): a is { login: string; token: string } =>
    !!a && typeof a.login === 'string' && typeof a.token === 'string').slice(0, 20) : [];
  const workspaceOwners = Array.isArray(params.workspaceOwners) ? params.workspaceOwners.filter((o): o is string => typeof o === 'string').slice(0, 100) : [];
  return { accounts, workspaceOwners };
}

function getValue(config: ServiceConfig, dotted: string): unknown {
  let current: unknown = config;
  for (const key of dotted.split('.')) {
    current = typeof current === 'object' && current !== null ? (current as Record<string, unknown>)[key] : undefined;
  }
  return current;
}
