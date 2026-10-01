import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { ApiCallBudget } from './apiBudget';
import { AuthProvider, StoredCredential, parseCredentialJson, readNativeCredential } from './authFiles';
import { activateClaudeAccountMetadata, claudeAccountFileConfirms, CredentialIdentity } from './accountIdentity';
import { AccountAutomation, AutomationProfiles, KeepAliveNowResult } from './accountAutomation';
import {
  explainAccountProblem, isolatedEnvironment, loginArgs, loginHome, probeAccount, readableProblem, stagedCredentialPath
} from './accountProbe';
import { deserializeUsage } from './cache';
import { ServiceConfig, automationSettings, configFileOf, loadConfig, saveConfig, setConfigValue, strategySummary } from './configStore';
import { LiveUsage, resolveCli, verifyCodexNativeAccount } from './live';
import { ExportedProfile, ImportPlan, parseProfileExport, serializeProfileExport } from './profileTransfer';
import { ActivationOutcome, ProfileMetadata, ProfileStore, PROVIDERS, TITLES, importOutcome } from './profileStore';
import {
  ActivationResult, ExportResult, ImportPlanView, ImportSummary, ProfileView, ProviderView, SaveNativeResult, ServiceEvent, ServiceInfo,
  SerializedUsage, SignInPreparation, SignInResult, Snapshot, UsageReadResult, serializeKeepAlive
} from './protocol';
import { profilesFile, stateDir } from './paths';

/** Shortest gap between background attempts to confirm the activated Claude login. */
const CLAUDE_METADATA_RETRY_MS = 60_000;
/** Attempts before the background identity sync gives up until the next switch. */
const CLAUDE_METADATA_RETRY_LIMIT = 10;
/** Sweeps, keep-alives and the other periodic work run this often. */
export const TICK_MS = 60_000;

export type AccountServiceOptions = {
  home: string;
  version: string;
  log: (message: string) => void;
  /** Injected by tests. */
  probe?: typeof probeAccount;
  identityOf?: (provider: AuthProvider, credential: StoredCredential) => Promise<CredentialIdentity>;
  verifyCodex?: typeof verifyCodexNativeAccount;
  syncClaudeMetadata?: typeof activateClaudeAccountMetadata;
  now?: () => number;
};

function providerParam(params: Record<string, unknown>): AuthProvider {
  const provider = params.provider;
  if (provider !== 'claude' && provider !== 'codex') { throw new Error('Choose a service: claude or codex.'); }
  return provider;
}

function stringParam(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== 'string' || !value) { throw new Error(`Missing ${key}.`); }
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
  readonly automation: AccountAutomation;
  readonly events = new EventEmitter();
  config: ServiceConfig;
  readonly startedAt = new Date();
  /** Set by the daemon: how many clients are connected right now. */
  clientCount: () => number = () => 0;

  private readonly configFile: string;
  private configStamp?: string;
  private readonly claudeBudget: ApiCallBudget;
  private readonly log: (message: string) => void;
  private readonly now: () => number;
  private timer?: NodeJS.Timeout;
  private disposed = false;
  /** Set while a switched Claude login still has to be confirmed against the OAuth profile endpoint. */
  private claudeMetadataRetry?: { nextAttemptAt: number; attempts: number };

  constructor(private readonly options: AccountServiceOptions) {
    this.log = options.log;
    this.now = options.now ?? Date.now;
    this.configFile = configFileOf(options.home);
    this.config = loadConfig(this.configFile);
    this.configStamp = this.stampOfConfigFile();
    this.store = new ProfileStore(profilesFile(options.home), this.log, options.identityOf);
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
      this.now);
    this.automation.onAccountProblem = (provider, id, reason, revoked) => {
      const profile = this.store.profile(provider, id);
      if (!profile) { return; }
      this.emit({ event: 'accountProblem', provider, id, name: profile.name, email: profile.email, reason, readable: readableProblem(reason), revoked });
      this.emit({ event: 'stateChanged', provider });
    };
    this.automation.onNoCandidate = (provider, detail) => this.emit({ event: 'noCandidate', provider, detail });
  }

  /** Starts the periodic work; `tick` runs at once and then every minute. */
  start(): void {
    if (this.timer) { return; }
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref?.();
    void this.tick();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    this.automation.dispose();
  }

  emit(event: ServiceEvent): void {
    this.events.emit('event', event);
  }

  /** One round of the periodic work: follow outside switches, sweep, retry the Claude identity sync. */
  async tick(): Promise<void> {
    if (this.disposed) { return; }
    this.reloadConfigIfChanged();
    for (const provider of PROVIDERS) {
      try {
        if (await this.store.followNative(provider)) { this.emit({ event: 'stateChanged', provider }); }
      } catch (error) { this.log(`${provider}: could not follow the native login: ${error instanceof Error ? error.message : String(error)}`); }
    }
    await this.automation.tick();
    await this.retryClaudeAccountMetadata();
  }

  info(): ServiceInfo {
    return { version: this.options.version, pid: process.pid, startedAt: this.startedAt.toISOString(), home: this.options.home,
      node: process.execPath, socket: '', clients: this.clientCount() };
  }

  async snapshot(): Promise<Snapshot> {
    const providers = {} as Record<AuthProvider, ProviderView>;
    for (const provider of PROVIDERS) { providers[provider] = await this.providerView(provider); }
    return { service: this.info(), providers, config: this.config };
  }

  async providerView(provider: AuthProvider): Promise<ProviderView> {
    try { if (await this.store.followNative(provider)) { this.emit({ event: 'stateChanged', provider }); } } catch { /* Reported by tick. */ }
    const activeProfileId = this.store.activeProfileId(provider);
    const profiles = this.store.profiles(provider).map((profile, index) => this.profileView(provider, profile, index + 1, profile.id === activeProfileId));
    const settings = automationSettings(this.config, provider);
    return {
      provider, title: TITLES[provider], profiles, activeProfileId,
      activeNumber: this.store.activeProfileNumber(provider),
      nativeUnsaved: this.store.nativeIsUnsaved(provider),
      checkingActive: this.automation.isCheckingActive(provider),
      keepAlive: settings.enabled, autoRotate: settings.autoRotate,
      strategySummary: strategySummary(this.config, provider)
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
      usage: state.usage as SerializedUsage | undefined,
      checkedAt: isoOrUndefined(state.checkedAt),
      lastKeepAliveAt: isoOrUndefined(state.lastKeepAliveAt),
      problems,
      limit: this.automation.limitState(provider, profile.id),
      loginProblem: this.automation.loginProblem(provider, profile.id),
      hasCredential: this.store.hasCredential(provider, profile.id)
    };
  }

  // --- activation and its verification -------------------------------------------------------------------

  private async activate(provider: AuthProvider, id: string, automatic: boolean): Promise<ActivationOutcome> {
    const outcome = await this.store.activateProfile(provider, id, automatic);
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

  private stampOfConfigFile(): string | undefined {
    try { const stat = fs.statSync(this.configFile); return `${stat.mtimeMs}:${stat.size}`; } catch { return undefined; }
  }

  /** A hand-edited config.json is picked up on the next tick. */
  private reloadConfigIfChanged(): void {
    const stamp = this.stampOfConfigFile();
    if (stamp === this.configStamp) { return; }
    this.configStamp = stamp;
    const next = loadConfig(this.configFile);
    if (JSON.stringify(next) === JSON.stringify(this.config)) { return; }
    this.config = next;
    this.log('config: reloaded config.json after it changed on disk');
    this.emit({ event: 'configChanged', config: this.config });
  }

  /** Applies `values` (dotted keys such as `claude.autoRotate.enabled`) and saves; unchanged values emit nothing. */
  setConfig(values: Record<string, unknown>): ServiceConfig {
    let next = this.config;
    for (const [key, value] of Object.entries(values)) { next = setConfigValue(next, key, value); }
    if (JSON.stringify(next) === JSON.stringify(this.config)) { return this.config; }
    saveConfig(this.configFile, next);
    this.configStamp = this.stampOfConfigFile();
    const changed = Object.keys(values).filter((key) => JSON.stringify(getValue(this.config, key)) !== JSON.stringify(getValue(next, key)));
    this.config = next;
    this.log(`config: changed ${changed.map((key) => `${key} = ${JSON.stringify(getValue(next, key))}`).join(', ')}`);
    this.emit({ event: 'configChanged', config: this.config });
    // A switch that was just turned on should act now, not in a minute.
    void this.automation.tick();
    return this.config;
  }

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

  async handle(method: string, rawParams: unknown): Promise<unknown> {
    const params = objectParams(rawParams);
    const paused = <T>(operation: () => Promise<T>) => this.automation.withPaused(operation);
    switch (method) {
      case 'service.info': return this.info();
      case 'snapshot': return this.snapshot();
      case 'profiles.list': return this.providerView(providerParam(params));
      case 'profiles.activate': {
        const provider = providerParam(params);
        const profile = this.resolveParam(provider, params);
        const outcome = await paused(() => this.activate(provider, profile.id, false));
        const result: ActivationResult = { profile: { id: outcome.profile.id, name: outcome.profile.name, email: outcome.profile.email },
          verification: outcome.verification, level: outcome.level, message: outcome.message, accountChanged: outcome.accountChanged };
        void this.automation.tick();
        return result;
      }
      case 'profiles.saveNative': {
        const provider = providerParam(params);
        const outcome = await paused(() => this.store.saveNative(provider, {
          name: typeof params.name === 'string' ? params.name : undefined,
          id: typeof params.id === 'string' ? params.id : undefined,
          allowDuplicate: params.allowDuplicate === true
        }));
        if (outcome.status !== 'duplicate') { this.emit({ event: 'stateChanged', provider }); void this.automation.tick(); }
        return outcome as SaveNativeResult;
      }
      case 'profiles.importCredential': {
        const provider = providerParam(params);
        const outcome = await paused(() => this.store.importCredential(provider, stringParam(params, 'name'), params.credential, params.allowDuplicate === true));
        if (outcome.status !== 'duplicate') { this.emit({ event: 'stateChanged', provider }); void this.automation.tick(); }
        return outcome as SaveNativeResult;
      }
      case 'profiles.rename': {
        const provider = providerParam(params);
        const profile = this.resolveParam(provider, params);
        const renamed = await paused(async () => this.store.rename(provider, profile.id, stringParam(params, 'name')));
        this.emit({ event: 'stateChanged', provider });
        return renamed;
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
        void this.automation.tick();
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
        const result = await this.automation.sendKeepAliveNow(provider, profile.id, { callerReports: params.callerReports === true });
        this.emit({ event: 'stateChanged', provider });
        return serializeKeepAlive(result);
      }
      case 'automation.rotateNow': {
        const provider = providerParam(params);
        const outcome = await this.automation.rotateNow(provider);
        this.emit({ event: 'stateChanged', provider });
        return { ...outcome, activeProfileId: this.store.activeProfileId(provider), activeProfileName: this.store.activeProfileName(provider) };
      }
      case 'automation.tick': await this.tick(); return { ok: true };
      case 'usage.read': {
        const provider = providerParam(params);
        const profile = this.resolveParam(provider, params);
        const result = await this.automation.readUsageNow(provider, profile.id);
        this.emit({ event: 'stateChanged', provider });
        return { profile: { id: profile.id, name: profile.name, email: profile.email }, ...serializeKeepAlive(result) } satisfies UsageReadResult;
      }
      case 'usage.observe': {
        const provider = providerParam(params);
        const id = stringParam(params, 'id');
        const usage = deserializeUsage({ usage: params.usage as SerializedUsage });
        if (!usage) { throw new Error('Missing usage.'); }
        // Live reads belong to the profile captured before the request, never to a newly selected one.
        if (this.store.activeProfileId(provider) === id && await this.store.matchesNative(provider, id)) {
          this.automation.observe(provider, id, usage as LiveUsage);
        }
        return { ok: true };
      }
      case 'usage.hintLimit': {
        const provider = providerParam(params);
        const usage = deserializeUsage({ usage: params.usage as SerializedUsage });
        if (usage) { this.automation.hintLimit(provider, usage as LiveUsage); }
        return { ok: true };
      }
      case 'config.get': return this.config;
      case 'config.set': return this.setConfig(objectParams(params.values));
      default: throw new Error(`Unknown method ${method}.`);
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

function getValue(config: ServiceConfig, dotted: string): unknown {
  let current: unknown = config;
  for (const key of dotted.split('.')) {
    current = typeof current === 'object' && current !== null ? (current as Record<string, unknown>)[key] : undefined;
  }
  return current;
}
