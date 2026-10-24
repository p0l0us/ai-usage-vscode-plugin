import * as path from 'path';
import { createHash } from 'crypto';
import { ApiCallBudget } from './apiBudget';
import { readNativeCredential, AuthProvider } from './authFiles';
import { SharedCache, deserializeUsage } from './cache';
import { ServiceConfig, UsageSource } from './configStore';
import { GitHubAccount, LiveResult, LiveUsage, ProviderId, fetchClaudeUsage, fetchClaudeUsageCli,
  fetchClaudeUsageFromAccountFile, fetchCodexUsage, fetchCodexUsageCli,
  fetchCodexUsageFromSessionLog, fetchCopilotUsage, fetchLocalThenApi, fetchAutoUsage, isFreshUsage, newestValidUsage } from './live';
import { SerializedUsage } from './protocol';
import { UsageCoordinator, usageAccountKey, credentialGeneration } from './usageCoordinator';

export type UsageContext = { accounts?: GitHubAccount[]; workspaceOwners?: string[] };
export type UsageState = { result: LiveResult; lastGood?: LiveUsage; identity: string };
export type UsageStateView = { profileId?: string; result: Exclude<LiveResult, { kind: 'ok' }> | { kind: 'ok'; usage: SerializedUsage }; lastGood?: SerializedUsage; identity: string };
export function serializeLiveUsage(usage: LiveUsage): SerializedUsage {
  return { ...usage, fetchedAt: usage.fetchedAt.toISOString(), windows: usage.windows.map(w => ({ ...w, resetsAt: w.resetsAt?.toISOString() })) };
}
export function serializeUsageState(state: UsageState): UsageStateView {
  return { ...state, result: state.result.kind === 'ok' ? { kind: 'ok', usage: serializeLiveUsage(state.result.usage) } : state.result,
    lastGood: state.lastGood ? serializeLiveUsage(state.lastGood) : undefined };
}
export function deserializeUsageState(state: UsageStateView): UsageState {
  return { ...state, result: state.result.kind === 'ok' ? { kind: 'ok', usage: deserializeUsage({ usage: state.result.usage })! } : state.result,
    lastGood: deserializeUsage({ usage: state.lastGood }) };
}
export function usageSettings(config: ServiceConfig, provider: ProviderId): { source: UsageSource; checkIntervalMs: number; apiCheckIntervalMs: number } {
  const own = config[provider];
  const configured = Math.max(provider === 'claude' ? 0.25 : 1, own.checkIntervalMinutes) * 60_000;
  // With a local source to fill in (`auto`, `both`), automatic endpoint reads are spaced at least
  // `api.minAccountIntervalMinutes`; an explicit `api` or `cli` source keeps the interval the user chose.
  const floor = provider !== 'copilot' && ['auto', 'both'].includes(own.source) ? Math.max(1, config[provider].api.minAccountIntervalMinutes) * 60_000 : 0;
  const apiCheckIntervalMs = Math.max(configured, floor);
  // `auto` reads the free local account file this often too, so rotation sees the active account within seconds.
  return { source: own.source, apiCheckIntervalMs, checkIntervalMs: provider === 'claude' && ['auto', 'both', 'accountFile'].includes(own.source)
    ? Math.max(5, config.claude.accountFile.checkIntervalSeconds) * 1000 : provider === 'codex' && ['auto', 'both', 'sessionLog'].includes(own.source) ? 5_000 : apiCheckIntervalMs };
}
function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
/** Opaque key, never a credential. Changes even for native logins that were never saved as profiles. */
export function nativeUsageIdentity(provider: AuthProvider): string {
  try { return hash(readNativeCredential(provider)); } catch { return 'unsigned'; }
}

/** Shared polling policy for the daemon, embedded service and standalone extension fallback. */
/** Credit read cadence is independent of the shorter display freshness. */
const CODEX_CREDITS_REUSE_MS = 60 * 60_000;

export class UsageMonitor {
  private readonly cache: SharedCache;
  private readonly coordinator: UsageCoordinator;
  private readonly inFlight = new Map<string, Promise<UsageState>>();
  private readonly states = new Map<string, UsageState>();
  private readonly nextCheck = new Map<string, number>();
  private readonly lastPolicy = new Map<ProviderId, string>();
  private readonly fallbacks: Record<AuthProvider, ApiCallBudget>;
  private readonly cliFallbacks: Record<AuthProvider, ApiCallBudget>;
  private disposed = false;
  /** The last earned-reset count read for the native Codex login, reused for `CODEX_CREDITS_REUSE_MS`. */
  private codexCredits?: { identity: string; at: number; credits: LiveUsage['resetCredits'] };
  constructor(private readonly options: {
    directory: string; config: () => ServiceConfig; budget: ApiCallBudget; log: (message: string) => void;
    identity?: (provider: AuthProvider) => string;
    accountKey?: (provider: AuthProvider) => string;
    runFetch?: (provider: ProviderId, fetch: () => Promise<LiveResult | undefined>) => Promise<LiveResult | undefined>;
    fetch?: (provider: ProviderId, context: UsageContext, known?: LiveUsage) => Promise<LiveResult>;
    observe?: (provider: AuthProvider, usage: LiveUsage, attributable: boolean, identity: string) => Promise<void>;
    changed?: (provider: ProviderId) => void;
    storedActive?: (provider: AuthProvider) => Promise<LiveUsage | undefined>;
    remote?: (provider: AuthProvider, fetch: () => Promise<LiveResult>, credits: boolean, manual: boolean) => Promise<LiveResult>;
    now?: () => number;
    /** Reads the native Codex login's earned resets; defaults to the CLI unless `fetch` is stubbed. */
    codexCredits?: (cliPath: string) => Promise<LiveUsage['resetCredits']>;
  }) {
    this.cache = new SharedCache(path.join(options.directory, 'live-usage.json'));
    this.coordinator = new UsageCoordinator(path.join(options.directory, 'request-admission.json'), options.now);
    this.fallbacks = Object.fromEntries((['claude', 'codex'] as const).map(provider => [provider,
      new ApiCallBudget(path.join(options.directory, `${provider}-fallback-budget.json`), () => usageSettings(options.config(), provider).apiCheckIntervalMs, options.now)
    ])) as Record<AuthProvider, ApiCallBudget>;
    this.cliFallbacks = Object.fromEntries((['claude', 'codex'] as const).map(provider => [provider,
      new ApiCallBudget(path.join(options.directory, `${provider}-cli-fallback-budget.json`), () => usageSettings(options.config(), provider).apiCheckIntervalMs, options.now)
    ])) as Record<AuthProvider, ApiCallBudget>;
  }
  dispose(): void { this.disposed = true; }
  invalidateCredits(): void {
    this.codexCredits = undefined;
    this.cache.update(`credits:${this.requestAccountKey('codex')}`, () => undefined);
  }
  private requestAccountKey(provider: AuthProvider): string {
    if (this.options.accountKey) return this.options.accountKey(provider);
    let credential;
    try { credential = readNativeCredential(provider); } catch { /* No native login. */ }
    return usageAccountKey(provider, credential, this.options.identity?.(provider));
  }
  private identity(provider: ProviderId, context: UsageContext): string {
    return provider === 'copilot' ? hash({ accounts: context.accounts ?? [], owners: [...(context.workspaceOwners ?? [])].sort(), account: this.options.config().copilot.account })
      : (this.options.identity ?? nativeUsageIdentity)(provider);
  }
  async read(provider: ProviderId, force = false, context: UsageContext = {}): Promise<UsageState> {
    const settings = usageSettings(this.options.config(), provider);
    const identity = this.identity(provider, context);
    const creditsIdentity = provider === 'codex' ? this.requestAccountKey(provider) : identity;
    const policy = hash([settings, provider === 'copilot' ? '' : this.options.config()[provider].cliPath]);
    const policyChanged = this.lastPolicy.has(provider) && this.lastPolicy.get(provider) !== policy;
    this.lastPolicy.set(provider, policy);
    const key = `${provider}:${policy}:${identity}`;
    const unavailable: UsageState = { identity, result: { kind: 'unavailable', provider, reason: 'Waiting for a usage reading.' } };
    if (this.disposed || !this.options.config()[provider].enabled) return unavailable;
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    const now = (this.options.now ?? Date.now)();
    const entry = this.cache.read(key);
    const stored = !policyChanged && provider !== 'copilot' && !['sessionLog', 'accountFile'].includes(settings.source) && this.options.storedActive
      ? await this.options.storedActive(provider) : undefined;
    if (identity !== this.identity(provider, context)) return unavailable;
    const lastGood = newestValidUsage(newestValidUsage(this.states.get(key)?.lastGood, deserializeUsage(entry), now), stored, now);
    const previous = this.states.get(key);
    let current = previous ? { ...previous, lastGood, result: previous.result.kind === 'ok' && !lastGood ? unavailable.result : previous.result } :
      { ...unavailable, ...(lastGood ? { result: { kind: 'ok' as const, usage: lastGood }, lastGood } : {}) };
    if (stored && lastGood === stored && !force && isFreshUsage(stored, provider, settings.apiCheckIntervalMs, now)) {
      current = { identity, result: { kind: 'ok', usage: stored }, lastGood: stored };
      if (!['auto', 'both'].includes(settings.source)) return current;
    }
    const staleAuto = settings.source === 'auto' && current.result.kind === 'ok' &&
      !isFreshUsage(current.result.usage, provider, settings.apiCheckIntervalMs, now);
    if (staleAuto) current = { ...current, result: unavailable.result };
    if (!force && !staleAuto && (this.nextCheck.get(key) ?? (lastGood ? lastGood.fetchedAt.getTime() + settings.checkIntervalMs : 0)) > now) return current;
    if (!['auto', 'both', 'sessionLog', 'accountFile'].includes(settings.source) && entry?.nextAllowedAt && entry.nextAllowedAt > now) return { ...current, result: { kind: 'error', provider, title: provider,
      message: `${entry.lastError ?? 'Usage check failed'} — retrying after ${new Date(entry.nextAllowedAt).toISOString()}`, transient: true } };
    const joined = this.inFlight.get(key);
    if (joined) return joined;
    const task = (async (): Promise<UsageState> => {
      if (!this.cache.tryLock(key, now)) return current;
      let result: LiveResult;
      try {
        const collect = async () => {
          if (provider === 'claude' && ['api', 'cli'].includes(settings.source) && !this.options.budget.reserve(now)) return undefined;
          let value = this.options.fetch
            ? await (provider === 'copilot' || ['sessionLog', 'accountFile'].includes(settings.source)
              ? this.options.fetch(provider, context, lastGood)
              : this.remote(provider, () => this.options.fetch!(provider, context, lastGood), false, force))
            : await this.fetch(provider, context, lastGood, force);
          if (provider === 'codex' && identity === this.identity(provider, context) && value.kind === 'ok' && settings.source !== 'sessionLog' &&
            (force || this.options.config().codex.backgroundNetwork !== false)) {
            if (value.usage.resetCredits) {
              const at = value.usage.creditsObservedAt ?? value.usage.fetchedAt.getTime();
              const credits = value.usage.resetCredits;
              this.codexCredits = { identity: creditsIdentity, at, credits };
              this.cache.update(`credits:${creditsIdentity}`, entry => ({ ...entry, creditsCheckedAt: at, credits }));
            } else {
              const cached = await this.nativeCodexCredits(creditsIdentity, force);
              if (cached?.credits) value = { kind: 'ok', usage: { ...value.usage, resetCredits: cached.credits, creditsObservedAt: cached.at } };
            }
          }
          return value;
        };
        const value = await (this.options.runFetch ? this.options.runFetch(provider, collect) : collect());
        if (!value) { this.cache.release(key); return current; }
        result = value;
        if (settings.source === 'auto' && result.kind === 'ok' && !isFreshUsage(result.usage, provider, settings.apiCheckIntervalMs, (this.options.now ?? Date.now)())) {
          result = { kind: 'unavailable', provider, reason: 'No fresh valid usage reading is available.' };
        }

      }
      catch (error) { result = { kind: 'error', provider, title: provider, message: error instanceof Error ? error.message : String(error), transient: true }; }
      this.nextCheck.set(key, now + settings.checkIntervalMs);
      // A switch or a changed source during the request must never publish the old account's reading.
      if (this.disposed || identity !== this.identity(provider, context) || policy !== hash([usageSettings(this.options.config(), provider), provider === 'copilot' ? '' : this.options.config()[provider].cliPath])) {
        this.cache.release(key); return unavailable;
      }
      if (result.kind === 'ok') {
        this.cache.recordSuccess(key, result.usage);
        if (settings.source === 'auto') this.nextCheck.set(key, Math.min(
          (this.options.now ?? Date.now)() + settings.checkIntervalMs, result.usage.fetchedAt.getTime() + settings.apiCheckIntervalMs));
        const reset = result.usage.windows.map(w => w.resetsAt?.getTime()).filter((time): time is number => time !== undefined && time > now).sort((a,b) => a-b)[0];
        if (reset) this.nextCheck.set(key, Math.min(this.nextCheck.get(key) ?? now + settings.checkIntervalMs, reset + 1000));
        // Auto hands back the reading it already had while no newer one exists; that is nothing new to publish.
        if (result.usage === lastGood && previous?.result.kind === 'ok') {
          const state = { identity, result, lastGood }; this.states.set(key, state); return state;
        }
        if (provider !== 'copilot') await this.options.observe?.(provider, result.usage,
          !(provider === 'codex' && (['both', 'sessionLog'].includes(settings.source) ||
            (settings.source === 'auto' && (!result.usage.source || result.usage.source === 'sessionLog')))), identity);
      } else if (result.kind === 'error') {
        if (result.transient && !['both', 'accountFile'].includes(settings.source)) this.cache.recordBackoff(key, result.message, result.retryAfterMs, now);
        else this.cache.recordFailure(key, result.message);
      } else this.cache.release(key);
      const state = { identity, result, lastGood: result.kind === 'ok' ? result.usage : lastGood };
      this.states.set(key, state);
      this.options.changed?.(provider);
      return state;
    })().finally(() => { this.inFlight.delete(key); });
    this.inFlight.set(key, task);
    return task;
  }
  /** Earned resets of the native Codex login, read through the CLI at most every `CODEX_CREDITS_REUSE_MS` per login. */
  private async nativeCodexCredits(identity: string, force: boolean): Promise<{ identity: string; at: number; credits: LiveUsage['resetCredits'] } | undefined> {
    const generation = this.identity('codex', {});
    const now = (this.options.now ?? Date.now)();
    const saved = this.cache.read(`credits:${identity}`);
    const cached = this.codexCredits?.identity === identity ? this.codexCredits : saved?.creditsCheckedAt === undefined
      ? undefined : { identity, at: saved.creditsCheckedAt, credits: saved.credits };
    if (cached && cached.identity === identity && now - cached.at < CODEX_CREDITS_REUSE_MS) return cached;
    const read = this.options.codexCredits;
    if (!read && this.options.fetch) return undefined;
    let credits: LiveUsage['resetCredits'];
    try {
      if (read) credits = await read(this.options.config().codex.cliPath);
      else {
        const result = await this.remote('codex', () => fetchCodexUsageCli(this.options.config().codex.cliPath), true, force);
        credits = result.kind === 'ok' ? result.usage.resetCredits : undefined;
      }
    } catch { credits = undefined; }
    if (generation !== this.identity('codex', {})) return undefined;
    // A failed read is remembered too, so a missing CLI is not started again on every local reading.
    this.codexCredits = { identity, at: now, credits };
    this.cache.update(`credits:${identity}`, entry => ({ ...entry, creditsCheckedAt: now, credits }));
    return this.codexCredits;
  }

  private async remote(provider: AuthProvider, fetch: () => Promise<LiveResult>, credits: boolean, force: boolean): Promise<LiveResult> {
    if (!force && this.options.config()[provider].backgroundNetwork === false) return { kind: 'unavailable', provider, reason: 'Background network requests are paused.' };
    const generation = this.identity(provider, {});
    let result: LiveResult;
    if (this.options.remote) result = await this.options.remote(provider, fetch, credits, force);
    else {
      let credential;
      try { credential = readNativeCredential(provider); } catch { /* No native login. */ }
      result = await this.coordinator.read(provider, usageAccountKey(provider, credential, this.options.identity?.(provider)), fetch,
        { credits, manual: force, generation: credentialGeneration(credential), reuseMs: this.options.fetch ? 0 : 5000,
          isCurrent: () => generation === this.identity(provider, {}) });
    }
    if (provider === 'codex' && generation === this.identity(provider, {}) && result.kind === 'ok' && result.usage.source !== 'sessionLog') {
      this.cache.recordSuccess(`authoritative:${generation}`, result.usage);
    }
    return result;
  }

  private async fetch(provider: ProviderId, context: UsageContext, known?: LiveUsage, force = false): Promise<LiveResult> {
    const config = this.options.config();
    const { source, apiCheckIntervalMs } = usageSettings(config, provider);
    if (provider === 'copilot') return fetchCopilotUsage(async () => context.accounts ?? [], {
      workspaceOwners: context.workspaceOwners ?? [], preferredLogin: config.copilot.account || undefined, log: this.options.log });
    if (source === 'auto') {
      // Session creation metadata cannot establish the authentication of a later turn. Display local hints, but
      // reconcile against an account-scoped reading at the configured deadline even while such hints arrive.
      const localCodex = provider === 'codex' ? await fetchCodexUsageFromSessionLog() : undefined;
      const authority = provider === 'codex' ? newestValidUsage(
        known?.source === 'api' || known?.source === 'cli' ? known : undefined,
        deserializeUsage(this.cache.read(`authoritative:${this.identity(provider, {})}`)), (this.options.now ?? Date.now)()) : known;
      const authorityFresh = authority && isFreshUsage(authority, provider, apiCheckIntervalMs, (this.options.now ?? Date.now)());
      const result = await fetchAutoUsage({ provider, known, intervalMs: apiCheckIntervalMs, now: this.options.now,
        ...(provider === 'codex' ? { known: authority } : {}),
        local: () => provider === 'claude' ? fetchClaudeUsageFromAccountFile() : Promise.resolve(authorityFresh ? localCodex! : { kind: 'unavailable', provider }),
        api: () => this.remote(provider, () => provider === 'claude' ? fetchClaudeUsage(undefined, this.options.budget) : fetchCodexUsage(), false, force),
        cli: () => this.remote(provider, () => provider === 'claude' ? fetchClaudeUsageCli(config.claude.cliPath) : fetchCodexUsageCli(config.codex.cliPath), true, force),
        apiSpacing: this.fallbacks[provider], cliSpacing: this.cliFallbacks[provider],
        budget: provider === 'claude' ? this.options.budget : undefined });
      // Only an endpoint's rate signal blocks it further; the spacing above already paces every other retry, and a
      // local source's transient error (read every few seconds) would otherwise keep pushing the endpoint out.
      if (result.kind === 'error' && result.transient && (result.status === 429 || result.retryAfterMs !== undefined)) {
        const retryAfterMs = result.retryAfterMs ?? Math.max(60_000, apiCheckIntervalMs);
        this.fallbacks[provider].observe({ retryAfterMs }, (this.options.now ?? Date.now)());
        this.cliFallbacks[provider].observe({ retryAfterMs }, (this.options.now ?? Date.now)());
        if (provider === 'claude') this.options.budget.observe({ retryAfterMs }, (this.options.now ?? Date.now)());
      }
      if (localCodex?.kind === 'ok' && isFreshUsage(localCodex.usage, provider, apiCheckIntervalMs, (this.options.now ?? Date.now)()) &&
        (result.kind !== 'ok' || localCodex.usage.fetchedAt > result.usage.fetchedAt)) return localCodex;
      return result;
    }
    if (provider === 'claude') {
      if (source === 'accountFile') return fetchClaudeUsageFromAccountFile();
      if (source === 'cli') return this.remote(provider, () => fetchClaudeUsageCli(config.claude.cliPath), false, force);
      if (source === 'both') return fetchLocalThenApi({ known, apiCheckIntervalMs, fallback: this.fallbacks.claude, budget: this.options.budget,
        local: () => fetchClaudeUsageFromAccountFile(), api: () => this.remote(provider, () => fetchClaudeUsage(undefined, this.options.budget), false, force) });
      return this.remote(provider, () => fetchClaudeUsage(undefined, this.options.budget), false, force);
    }
    if (source === 'cli') return this.remote(provider, () => fetchCodexUsageCli(config.codex.cliPath), true, force);
    const result = source === 'sessionLog' ? await fetchCodexUsageFromSessionLog() : source === 'both'
      ? await fetchLocalThenApi({ known, apiCheckIntervalMs, fallback: this.fallbacks.codex,
        local: () => fetchCodexUsageFromSessionLog(), api: () => this.remote(provider, () => fetchCodexUsage(), false, force) }) : await this.remote(provider, () => fetchCodexUsage(), false, force);
    return result;
  }
}
