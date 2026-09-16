import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { AuthProvider, StoredCredential, writeJsonAtomically } from './authFiles';
import { CacheEntry, deserializeUsage } from './cache';
import { LiveUsage } from './live';
import { ProbeSettings, ProbeResult, acquireAccountLock, probeAccount } from './accountProbe';

export type AutomationSettings = ProbeSettings & {
  enabled: boolean;
  autoRotate: boolean;
  thresholdPercent: number;
  intervalMs: number;
  checkIntervalMs: number;
};

type Profile = { id: string; name: string };
export interface AutomationProfiles {
  profiles(provider: AuthProvider): Profile[];
  activeProfileId(provider: AuthProvider): string | undefined;
  credential(provider: AuthProvider, id: string): Promise<StoredCredential | undefined>;
  refreshedCredential(provider: AuthProvider, id: string, before: StoredCredential, after: StoredCredential): Promise<void>;
  matchesNative(provider: AuthProvider, id: string): Promise<boolean>;
  activateProfile(provider: AuthProvider, id: string, automatic?: boolean): Promise<boolean>;
}

type AccountState = CacheEntry & { lastKeepAliveAt?: number; checkedAt?: number; keepAliveError?: string };

export function atLimit(usage: LiveUsage, thresholdPercent = 99.5): boolean {
  return usage.windows.some((window) => Number.isFinite(window.usedPercent) && window.usedPercent >= thresholdPercent);
}

export function eligibleAccount(usage: LiveUsage, now = Date.now(), thresholdPercent = 99.5): boolean {
  return usage.windows.length > 0 && usage.windows.every((window) =>
    Number.isFinite(window.usedPercent) && window.usedPercent >= 0 && window.usedPercent < thresholdPercent &&
    (!window.resetsAt || window.resetsAt.getTime() > now));
}

export function nextAccounts(profiles: Profile[], activeId: string): Profile[] {
  const index = profiles.findIndex((profile) => profile.id === activeId);
  return index < 0 ? [] : [...profiles.slice(index + 1), ...profiles.slice(0, index)];
}

/** Plain Node service: persistent per-account statistics, keep-alives and bounded rotation. */
export class AccountAutomation {
  private pending?: Promise<void>;
  private paused = 0;
  private disposed = false;
  private readonly checkingActive = new Set<AuthProvider>();
  private readonly abort = new AbortController();

  constructor(
    private readonly directory: string,
    private readonly profiles: AutomationProfiles,
    private readonly settings: (provider: AuthProvider) => AutomationSettings,
    private readonly afterActivate: (provider: AuthProvider) => Promise<void>,
    private readonly log: (message: string) => void,
    private readonly probe: typeof probeAccount = probeAccount,
    private readonly now: () => number = Date.now
  ) {}

  dispose(): void { this.disposed = true; this.abort.abort(); }

  isCheckingActive(provider: AuthProvider): boolean { return this.checkingActive.has(provider); }

  async withPaused<T>(operation: () => Promise<T>): Promise<T> {
    this.paused++;
    try { await this.pending; return await operation(); }
    finally { this.paused--; }
  }

  tick(): Promise<void> {
    if (this.disposed || this.paused) { return Promise.resolve(); }
    if (this.pending) { return this.pending; }
    this.pending = Promise.all((['claude', 'codex'] as const).map(async (provider) => {
      try { await this.checkProvider(provider); }
      catch (error) { this.log(`${provider}: account automation failed: ${error instanceof Error ? error.message : 'Unknown error'}`); }
    })).then(() => undefined).finally(() => { this.pending = undefined; });
    return this.pending;
  }

  usageDetail(provider: AuthProvider, id: string): string | undefined {
    const state = this.read(provider, id);
    const usage = deserializeUsage(state);
    const parts: string[] = [];
    if (usage) {
      parts.push(usage.windows.map((window) => `${window.label}: ${window.usedPercent}%`).join(' · '));
      parts.push(`Checked ${usage.fetchedAt.toLocaleString()}`);
    }
    if (state.lastError) { parts.push(`Usage check: ${state.lastError}`); }
    if (state.keepAliveError) { parts.push(state.keepAliveError); }
    return parts.join(' · ') || undefined;
  }

  /** Live reads belong to the profile captured before the request, never to a newly selected one. */
  observe(provider: AuthProvider, id: string, usage: LiveUsage): void {
    const state = this.read(provider, id);
    const previous = deserializeUsage(state);
    if (previous && previous.fetchedAt > usage.fetchedAt) { return; }
    this.write(provider, id, { ...state, usage: this.serialize(usage), checkedAt: usage.fetchedAt.getTime(), lastError: undefined });
  }

  private file(provider: AuthProvider, id: string): string {
    const key = createHash('sha256').update(id).digest('hex');
    return path.join(this.directory, `${provider}-${key}.json`);
  }

  private read(provider: AuthProvider, id: string): AccountState {
    try { return JSON.parse(fs.readFileSync(this.file(provider, id), 'utf8')); }
    catch { return {}; }
  }

  private write(provider: AuthProvider, id: string, state: AccountState): void {
    writeJsonAtomically(this.file(provider, id), state);
  }

  private serialize(usage: LiveUsage): NonNullable<CacheEntry['usage']> {
    return { ...usage, fetchedAt: usage.fetchedAt.toISOString(), windows: usage.windows.map((window) =>
      ({ ...window, resetsAt: window.resetsAt?.toISOString() })) };
  }

  private async checkProvider(provider: AuthProvider): Promise<void> {
    const settings = this.settings(provider);
    if (!settings.enabled && !settings.autoRotate) { return; }
    const unlock = acquireAccountLock(path.join(this.directory, `${provider}.lock`));
    if (!unlock) { return; }
    try {
      // Rotate first so a long keep-alive sweep does not delay an exhausted active account.
      if (settings.autoRotate) { await this.rotate(provider, settings); }
      if (settings.enabled) {
        for (const profile of this.profiles.profiles(provider)) {
          if (this.disposed || this.paused || !this.settings(provider).enabled) { break; }
          const state = this.read(provider, profile.id);
          if (state.lastKeepAliveAt !== undefined && this.now() - state.lastKeepAliveAt < settings.intervalMs) { continue; }
          // Persist before starting so a failed call or window restart cannot create a retry storm.
          this.write(provider, profile.id, { ...state, lastKeepAliveAt: this.now() });
          await this.checkAccount(provider, profile.id, settings, true);
        }
      }
      if (settings.autoRotate && !this.disposed && !this.paused) { await this.rotate(provider, settings); }
    } finally { unlock(); }
  }

  private async checkAccount(provider: AuthProvider, id: string, settings: AutomationSettings, keepAlive: boolean): Promise<LiveUsage | undefined> {
    const previous = this.read(provider, id);
    if (previous.nextAllowedAt && previous.nextAllowedAt > this.now()) { return undefined; }
    let outcome: ProbeResult;
    const active = this.profiles.activeProfileId(provider) === id;
    if (active) { this.checkingActive.add(provider); }
    try {
      const credential = await this.profiles.credential(provider, id);
      if (!credential) { throw new Error('Saved credential is missing.'); }
      outcome = await this.probe(provider, credential, settings, keepAlive, this.abort.signal);
      await this.profiles.refreshedCredential(provider, id, credential, outcome.credential);
    } catch (error) {
      outcome = { credential: {}, result: { kind: 'error', provider, title: provider,
        message: error instanceof Error ? error.message : 'Account check failed.' } };
    } finally {
      if (active) { this.checkingActive.delete(provider); }
    }
    const state = this.read(provider, id);
    const result = outcome.result;
    this.write(provider, id, { ...state, checkedAt: this.now(),
      usage: result.kind === 'ok' ? this.serialize(result.usage) : state.usage,
      nextAllowedAt: result.kind === 'error' && result.transient
        ? this.now() + Math.max(settings.checkIntervalMs, result.retryAfterMs ?? 0) : undefined,
      lastError: result.kind === 'ok' ? undefined : result.kind === 'error' ? result.message : result.reason ?? 'Usage unavailable.',
      keepAliveError: keepAlive ? outcome.keepAliveError : state.keepAliveError });
    this.log(`${provider}: account ${id} ${keepAlive ? 'keep-alive / ' : ''}usage: ${result.kind}${outcome.keepAliveError ? ` (${outcome.keepAliveError})` : ''}`);
    return result.kind === 'ok' ? result.usage : undefined;
  }

  private async rotate(provider: AuthProvider, settings: AutomationSettings): Promise<void> {
    if (this.disposed || this.paused || !this.settings(provider).autoRotate) { return; }
    const active = this.profiles.activeProfileId(provider);
    if (!active || this.profiles.profiles(provider).length < 2 || !await this.profiles.matchesNative(provider, active)) { return; }
    const state = this.read(provider, active);
    const usage = deserializeUsage(state);
    if (!usage || !atLimit(usage, settings.thresholdPercent)) { return; }
    // The sweep timestamp also throttles all-exhausted and error cases across windows/restarts.
    const rotationId = 'rotation-sweep';
    const sweep = this.read(provider, rotationId);
    if (sweep.checkedAt !== undefined && this.now() - sweep.checkedAt < settings.checkIntervalMs) { return; }
    this.write(provider, rotationId, { checkedAt: this.now() });
    // Never rotate based on a stale cache, offline log, expired reset or a failed refresh.
    const current = await this.checkAccount(provider, active, settings, false);
    if (!current || !atLimit(current, settings.thresholdPercent)) { return; }
    const requiredWindows = current.windows.map((window) => window.label);
    for (const candidate of nextAccounts(this.profiles.profiles(provider), active)) {
      if (this.disposed || this.paused || !this.settings(provider).autoRotate) { return; }
      const candidateUsage = await this.checkAccount(provider, candidate.id, settings, false);
      if (!candidateUsage || !eligibleAccount(candidateUsage, this.now(), settings.thresholdPercent) ||
        candidateUsage.windows.length < current.windows.length ||
        !requiredWindows.every((label) => candidateUsage.windows.some((window) => window.label === label))) { continue; }
      if (this.profiles.activeProfileId(provider) !== active || !await this.profiles.matchesNative(provider, active)) { return; }
      if (await this.profiles.activateProfile(provider, candidate.id, true)) {
        this.log(`${provider}: automatically rotated to "${candidate.name}" (${settings.thresholdPercent}% limit)`);
        await this.afterActivate(provider);
      }
      return; // At most one switch per sweep, including when every account is exhausted.
    }
    this.log(`${provider}: no account below ${settings.thresholdPercent}% in every usage window; keeping the active account`);
  }
}
