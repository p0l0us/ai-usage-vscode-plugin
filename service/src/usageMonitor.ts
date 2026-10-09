import * as path from 'path';
import { createHash } from 'crypto';
import { ApiCallBudget } from './apiBudget';
import { readNativeCredential, AuthProvider } from './authFiles';
import { SharedCache, deserializeUsage } from './cache';
import { ServiceConfig, UsageSource } from './configStore';
import { GitHubAccount, LiveResult, LiveUsage, ProviderId, fetchClaudeUsage, fetchClaudeUsageCli,
  fetchClaudeUsageFromAccountFile, fetchCodexUsage, fetchCodexUsageCli, fetchCodexResetCreditsCli,
  fetchCodexUsageFromSessionLog, fetchCopilotUsage, fetchLocalThenApi, fetchAutoUsage, isFreshUsage, newestValidUsage } from './live';
import { SerializedUsage } from './protocol';

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
  const apiCheckIntervalMs = Math.max(provider === 'claude' ? 0.25 : 1, own.checkIntervalMinutes) * 60_000;
  return { source: own.source, apiCheckIntervalMs, checkIntervalMs: provider === 'claude' && ['both', 'accountFile'].includes(own.source)
    ? Math.max(5, config.claude.accountFile.checkIntervalSeconds) * 1000 : apiCheckIntervalMs };
}
function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
/** Opaque key, never a credential. Changes even for native logins that were never saved as profiles. */
export function nativeUsageIdentity(provider: AuthProvider): string {
  try { return hash(readNativeCredential(provider)); } catch { return 'unsigned'; }
}

/** Shared polling policy for the daemon, embedded service and standalone extension fallback. */
export class UsageMonitor {
  private readonly cache: SharedCache;
  private readonly inFlight = new Map<string, Promise<UsageState>>();
  private readonly states = new Map<string, UsageState>();
  private readonly nextCheck = new Map<string, number>();
  private readonly fallbacks: Record<AuthProvider, ApiCallBudget>;
  private readonly cliFallbacks: Record<AuthProvider, ApiCallBudget>;
  private disposed = false;
  constructor(private readonly options: {
    directory: string; config: () => ServiceConfig; budget: ApiCallBudget; log: (message: string) => void;
    identity?: (provider: AuthProvider) => string;
    runFetch?: (provider: ProviderId, fetch: () => Promise<LiveResult | undefined>) => Promise<LiveResult | undefined>;
    fetch?: (provider: ProviderId, context: UsageContext, known?: LiveUsage) => Promise<LiveResult>;
    observe?: (provider: AuthProvider, usage: LiveUsage, attributable: boolean, identity: string) => Promise<void>;
    changed?: (provider: ProviderId) => void;
    now?: () => number;
  }) {
    this.cache = new SharedCache(path.join(options.directory, 'live-usage.json'));
    this.fallbacks = Object.fromEntries((['claude', 'codex'] as const).map(provider => [provider,
      new ApiCallBudget(path.join(options.directory, `${provider}-fallback-budget.json`), () => usageSettings(options.config(), provider).apiCheckIntervalMs, options.now)
    ])) as Record<AuthProvider, ApiCallBudget>;
    this.cliFallbacks = Object.fromEntries((['claude', 'codex'] as const).map(provider => [provider,
      new ApiCallBudget(path.join(options.directory, `${provider}-cli-fallback-budget.json`), () => usageSettings(options.config(), provider).apiCheckIntervalMs, options.now)
    ])) as Record<AuthProvider, ApiCallBudget>;
  }
  dispose(): void { this.disposed = true; }
  private identity(provider: ProviderId, context: UsageContext): string {
    return provider === 'copilot' ? hash({ accounts: context.accounts ?? [], owners: [...(context.workspaceOwners ?? [])].sort(), account: this.options.config().copilot.account })
      : (this.options.identity ?? nativeUsageIdentity)(provider);
  }
  async read(provider: ProviderId, force = false, context: UsageContext = {}): Promise<UsageState> {
    const settings = usageSettings(this.options.config(), provider);
    const identity = this.identity(provider, context);
    const policy = hash([settings, provider === 'copilot' ? '' : this.options.config()[provider].cliPath]);
    const key = `${provider}:${policy}:${identity}`;
    const unavailable: UsageState = { identity, result: { kind: 'unavailable', provider, reason: 'Waiting for a usage reading.' } };
    if (this.disposed || !this.options.config()[provider].enabled) return unavailable;
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    const now = (this.options.now ?? Date.now)();
    const entry = this.cache.read(key);
    const lastGood = newestValidUsage(this.states.get(key)?.lastGood, deserializeUsage(entry), now);
    const previous = this.states.get(key);
    let current = previous ? { ...previous, lastGood, result: previous.result.kind === 'ok' && !lastGood ? unavailable.result : previous.result } :
      { ...unavailable, ...(lastGood ? { result: { kind: 'ok' as const, usage: lastGood }, lastGood } : {}) };
    const staleAuto = settings.source === 'auto' && current.result.kind === 'ok' &&
      !isFreshUsage(current.result.usage, provider, settings.apiCheckIntervalMs, now);
    if (staleAuto) current = { ...current, result: unavailable.result };
    if (!force && !staleAuto && (this.nextCheck.get(key) ?? (lastGood ? lastGood.fetchedAt.getTime() + settings.checkIntervalMs : 0)) > now) return current;
    if (settings.source !== 'auto' && entry?.nextAllowedAt && entry.nextAllowedAt > now) return { ...current, result: { kind: 'error', provider, title: provider,
      message: `${entry.lastError ?? 'Usage check failed'} — retrying after ${new Date(entry.nextAllowedAt).toISOString()}`, transient: true } };
    const task = (async (): Promise<UsageState> => {
      if (!this.cache.tryLock(key, now)) return current;
      let result: LiveResult;
      try {
        const collect = async () => {
          if (provider === 'claude' && ['api', 'cli'].includes(settings.source) && !this.options.budget.reserve(now)) return undefined;
          return this.options.fetch ? this.options.fetch(provider, context, lastGood) : this.fetch(provider, context, lastGood);
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
  private async fetch(provider: ProviderId, context: UsageContext, known?: LiveUsage): Promise<LiveResult> {
    const config = this.options.config();
    const { source, apiCheckIntervalMs } = usageSettings(config, provider);
    if (provider === 'copilot') return fetchCopilotUsage(async () => context.accounts ?? [], {
      workspaceOwners: context.workspaceOwners ?? [], preferredLogin: config.copilot.account || undefined, log: this.options.log });
    if (source === 'auto') {
      const result = await fetchAutoUsage({ provider, known, intervalMs: apiCheckIntervalMs, now: this.options.now,
        local: () => provider === 'claude' ? fetchClaudeUsageFromAccountFile() : fetchCodexUsageFromSessionLog(),
        api: () => provider === 'claude' ? fetchClaudeUsage(undefined, this.options.budget) : fetchCodexUsage(),
        cli: () => provider === 'claude' ? fetchClaudeUsageCli(config.claude.cliPath) : fetchCodexUsageCli(config.codex.cliPath),
        apiSpacing: this.fallbacks[provider], cliSpacing: this.cliFallbacks[provider],
        budget: provider === 'claude' ? this.options.budget : undefined });
      if (result.kind === 'error' && result.transient) {
        const retryAfterMs = result.retryAfterMs ?? Math.max(60_000, apiCheckIntervalMs);
        this.fallbacks[provider].observe({ retryAfterMs }, (this.options.now ?? Date.now)());
        this.cliFallbacks[provider].observe({ retryAfterMs }, (this.options.now ?? Date.now)());
        if (provider === 'claude') this.options.budget.observe({ retryAfterMs }, (this.options.now ?? Date.now)());
      }
      return result;
    }
    if (provider === 'claude') {
      if (source === 'accountFile') return fetchClaudeUsageFromAccountFile();
      if (source === 'cli') return fetchClaudeUsageCli(config.claude.cliPath);
      if (source === 'both') return fetchLocalThenApi({ known, apiCheckIntervalMs, fallback: this.fallbacks.claude, budget: this.options.budget,
        local: () => fetchClaudeUsageFromAccountFile(), api: () => fetchClaudeUsage(undefined, this.options.budget) });
      return fetchClaudeUsage(undefined, this.options.budget);
    }
    if (source === 'cli') return fetchCodexUsageCli(config.codex.cliPath);
    const result = source === 'sessionLog' ? await fetchCodexUsageFromSessionLog() : source === 'both'
      ? await fetchLocalThenApi({ known, apiCheckIntervalMs, fallback: this.fallbacks.codex,
        local: () => fetchCodexUsageFromSessionLog(), api: () => fetchCodexUsage() }) : await fetchCodexUsage();
    if (result.kind === 'ok' && source !== 'sessionLog') {
      const credits = await fetchCodexResetCreditsCli(config.codex.cliPath);
      if (credits) result.usage.resetCredits = credits;
    }
    return result;
  }
}
