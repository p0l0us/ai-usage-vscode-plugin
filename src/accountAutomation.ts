import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { AuthProvider, StoredCredential, writeJsonAtomically } from './authFiles';
import { CacheEntry, deserializeUsage } from './cache';
import { formatResetRemaining, LiveUsage, UsageWindow } from './live';
import { ProbeSettings, ProbeResult, acquireAccountLock, explainAccountProblem, isRevokedCredentialError, probeAccount } from './accountProbe';
import type { ActivationChange } from './authProfiles';

/** How rotation picks the next account; `sequential` is saved-profile order. */
export type RotationStrategy = 'sequential' | 'soonestReset' | 'evenPace' | 'leastWaste';
/** `limit`: switch only once the active account is exhausted; `proactive`: also when a clearly better one appears. */
export type RotationTrigger = 'limit' | 'proactive';

/**
 * Rotation thresholds per kind of window. An account is at its limit once any counted window's usage is at or
 * above its threshold, and can only be switched to while every counted window is below it.
 */
export type RotationLimits = {
  /** Windows measured in hours or minutes, such as "5h". */
  fiveHourThresholdPercent: number;
  /** Weekly windows: the all-models "7d" and model-scoped ones such as "7d Fable". */
  weeklyThresholdPercent: number;
  /** Whether a window counts at all; model-scoped windows can be left out when that model is not used. */
  countsWindow?: (label: string) => boolean;
};

export type AutomationSettings = ProbeSettings & RotationLimits & {
  enabled: boolean;
  autoRotate: boolean;
  strategy?: RotationStrategy;
  trigger?: RotationTrigger;
  /** Proactive switching leaves a newly active account alone for at least this long. */
  minStayMs?: number;
  intervalMs: number;
  checkIntervalMs: number;
};

export type KeepAliveNowResult = {
  usage?: LiveUsage;
  keepAliveError?: string;
  usageError?: string;
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

type AccountState = CacheEntry & {
  lastKeepAliveAt?: number;
  checkedAt?: number;
  keepAliveError?: string;
  /** Fingerprint of the credential and problem last announced, so each broken login is reported once. */
  problemNotified?: string;
  /** Rotation bookkeeping only: the account `checkedAt` started counting the stay of. */
  activeId?: string;
};

function fingerprint(credential: StoredCredential): string {
  return createHash('sha256').update(JSON.stringify(credential)).digest('hex');
}

type WindowKind = 'short' | 'weekly' | 'modelWeekly';

export function windowKind(label: string): WindowKind {
  return /^\d+d$/.test(label) ? 'weekly' : /^\d+d\s/.test(label) ? 'modelWeekly' : 'short';
}

function windowMs(label: string): number | undefined {
  const match = /^(\d+)([dhm])/.exec(label);
  return match ? Number(match[1]) * { d: 86_400_000, h: 3_600_000, m: 60_000 }[match[2] as 'd' | 'h' | 'm'] : undefined;
}

export function windowThreshold(label: string, limits: number | RotationLimits): number {
  if (typeof limits === 'number') { return limits; }
  return windowKind(label) === 'short' ? limits.fiveHourThresholdPercent : limits.weeklyThresholdPercent;
}

function counted(usage: LiveUsage, limits: number | RotationLimits): UsageWindow[] {
  const counts = typeof limits === 'number' ? undefined : limits.countsWindow;
  return counts ? usage.windows.filter((window) => counts(window.label)) : usage.windows;
}

/**
 * `auto` counts a model-scoped window ("7d Fable") only when the configured model is that one, or is unknown;
 * `always` counts every window and `never` ignores model-scoped ones.
 */
export function modelWindowFilter(mode: string, model?: string): ((label: string) => boolean) | undefined {
  if (mode !== 'auto' && mode !== 'never') { return undefined; }
  const known = model && model.toLowerCase() !== 'default' ? model.toLowerCase() : undefined;
  return (label) => {
    const scoped = /^\d+d\s+(.+)$/.exec(label);
    if (!scoped) { return true; }
    return mode === 'auto' && (!known || known.includes(scoped[1].toLowerCase()));
  };
}

export function atLimit(usage: LiveUsage, limits: number | RotationLimits = 99.5): boolean {
  return counted(usage, limits).some((window) =>
    Number.isFinite(window.usedPercent) && window.usedPercent >= windowThreshold(window.label, limits));
}

export function eligibleAccount(usage: LiveUsage, now = Date.now(), limits: number | RotationLimits = 99.5): boolean {
  const windows = counted(usage, limits);
  return windows.length > 0 && windows.every((window) =>
    Number.isFinite(window.usedPercent) && window.usedPercent >= 0 && window.usedPercent < windowThreshold(window.label, limits) &&
    (!window.resetsAt || window.resetsAt.getTime() > now));
}

/** Ahead of an even spend by more than this many points, with over half the week to go, is spending too early. */
const PACE_MARGIN = 10;
/** An active-account reading at most this old decides rotation without reading the account again. */
const RECENT_READING_MS = 2 * 60_000;
/** How much better a candidate must score before proactive rotation leaves a working account. */
const SWITCH_MARGIN: Record<Exclude<RotationStrategy, 'sequential'>, number> = { soonestReset: 3, evenPace: 5, leastWaste: 0.1 };

/**
 * Lower is better. A window whose reset has already passed counts as fresh, so an old cached reading ranks an
 * account by what it will have; a switch is still only made on a fresh reading. Undefined: no weekly window.
 */
export function rotationScore(strategy: RotationStrategy, usage: LiveUsage, now: number, limits: RotationLimits): number | undefined {
  if (strategy === 'sequential') { return undefined; }
  let binding: { remaining: number; hoursLeft: number } | undefined;
  let paceGap = -Infinity, rate = Infinity, early = false, shortExpiring = false;
  for (const window of counted(usage, limits)) {
    if (!Number.isFinite(window.usedPercent)) { continue; }
    const duration = windowMs(window.label) ?? 7 * 86_400_000;
    let resetsAt = window.resetsAt?.getTime() ?? now + duration;
    let used = window.usedPercent;
    if (resetsAt <= now) {
      used = 0;
      resetsAt += Math.ceil((now - resetsAt + 1) / duration) * duration;
    }
    const remaining = Math.max(0, windowThreshold(window.label, limits) - used);
    if (windowKind(window.label) === 'short') {
      // Unused 5h allowance that is about to reset is lost too.
      shortExpiring ||= remaining > 0 && resetsAt - now <= 3_600_000;
      continue;
    }
    const hoursLeft = Math.max(0.25, (resetsAt - now) / 3_600_000);
    const elapsed = Math.min(1, Math.max(0, 1 - (resetsAt - now) / duration));
    const gap = used - 100 * elapsed;
    paceGap = Math.max(paceGap, gap);
    rate = Math.min(rate, remaining / hoursLeft);
    early ||= gap > PACE_MARGIN && elapsed < 0.5;
    if (!binding || remaining < binding.remaining) { binding = { remaining, hoursLeft }; }
  }
  if (!binding) { return undefined; }
  if (strategy === 'soonestReset') { return binding.hoursLeft + (early ? 10_000 : 0); }
  if (strategy === 'evenPace') { return paceGap; }
  return -rate * (shortExpiring ? 1.1 : 1);
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
    private readonly afterActivate: (provider: AuthProvider, change: ActivationChange) => Promise<void>,
    private readonly log: (message: string) => void,
    private readonly probe: typeof probeAccount = probeAccount,
    private readonly now: () => number = Date.now
  ) {}

  /**
   * Set by extension.ts: told once per credential and problem when a saved login is broken — `revoked` when only a
   * new sign-in can fix it (from any check), otherwise when rotation's keep-alive refused a switch candidate.
   */
  onAccountProblem?: (provider: AuthProvider, id: string, reason: string, revoked: boolean) => void;

  /**
   * Set by extension.ts: told once while the active account is at its limit and no saved account is below its
   * thresholds, so rotation keeping the active account is not silent. Told again after a switch or a recovery.
   */
  onNoCandidate?: (provider: AuthProvider, detail: string) => void;

  /** A reading that belongs to no known profile (Codex session logs) showed the limit; the next sweep reads the active account. */
  private readonly limitHint = new Set<AuthProvider>();

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
      parts.push(usage.windows.map((window) => {
        const reset = formatResetRemaining(window.resetsAt);
        return `${window.label}: ${window.usedPercent}%${reset ? ` (${reset})` : ''}`;
      }).join(' · '));
      parts.push(`Checked ${usage.fetchedAt.toLocaleString()}`);
    }
    // Known errors read as a few words ("Insufficient credits"); the vendor's own text stays in the log.
    const problems = new Set<string>();
    for (const [check, error] of [['Keep-alive', state.keepAliveError], ['Usage check', state.lastError]] as const) {
      if (!error) { continue; }
      const problem = explainAccountProblem(error);
      problems.add(problem.known ? problem.label : `${check} failed: ${problem.label}`);
    }
    parts.push(...[...problems].map((problem) => `$(warning) ${problem}`));
    return parts.join(' · ') || undefined;
  }

  /** Live reads belong to the profile captured before the request, never to a newly selected one. */
  observe(provider: AuthProvider, id: string, usage: LiveUsage): void {
    const state = this.read(provider, id);
    const previous = deserializeUsage(state);
    if (previous && previous.fetchedAt > usage.fetchedAt) { return; }
    this.write(provider, id, { ...state, usage: this.serialize(usage), checkedAt: usage.fetchedAt.getTime(), lastError: undefined });
    // A reading that reaches a threshold starts rotation now, not on the next minute's tick.
    const settings = this.settings(provider);
    if (settings.autoRotate && this.profiles.activeProfileId(provider) === id && atLimit(usage, settings)) { void this.tick(); }
  }

  /**
   * A reading that cannot be attributed to a profile, such as Codex's session logs (they carry no account), still
   * tells when the active account has probably reached its limit. It never becomes a profile's reading; it only
   * makes the next sweep read the active account itself instead of trusting its older stored reading.
   */
  hintLimit(provider: AuthProvider, usage: LiveUsage): void {
    const settings = this.settings(provider);
    if (!settings.autoRotate || !atLimit(usage, settings)) { this.limitHint.delete(provider); return; }
    if (!this.limitHint.has(provider)) { this.log(`${provider}: the status bar reading is at a rotation threshold; checking the active account`); }
    this.limitHint.add(provider);
    void this.tick();
  }

  /** Run an explicitly requested keep-alive regardless of the periodic feature state or current backoff. */
  sendKeepAliveNow(provider: AuthProvider, id: string): Promise<KeepAliveNowResult> {
    // A manual call counts as this account's latest keep-alive for the periodic schedule.
    return this.checkNow(provider, id, true, (state) => ({ ...state, lastKeepAliveAt: this.now() }));
  }

  /** After a new sign-in replaced a profile's login: forget the dead one's errors and read its usage right away. */
  credentialReplaced(provider: AuthProvider, id: string): Promise<KeepAliveNowResult> {
    return this.checkNow(provider, id, false, (state) =>
      ({ ...state, lastError: undefined, keepAliveError: undefined, nextAllowedAt: undefined, problemNotified: undefined }));
  }

  private async checkNow(provider: AuthProvider, id: string, keepAlive: boolean,
    prepare: (state: AccountState) => AccountState): Promise<KeepAliveNowResult> {
    if (this.disposed) { throw new Error('Account automation is no longer running.'); }
    if (!this.profiles.profiles(provider).some((profile) => profile.id === id)) {
      throw new Error('The selected account no longer exists.');
    }
    const unlock = acquireAccountLock(path.join(this.directory, `${provider}.lock`));
    if (!unlock) { throw new Error(`Another ${provider} account check is already running.`); }
    try {
      this.write(provider, id, prepare(this.read(provider, id)));
      return await this.checkAccount(provider, id, this.settings(provider), keepAlive, true);
    } finally { unlock(); }
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

  /** `verifying`: rotation's pre-switch keep-alive, where any failure is worth telling the user about. */
  private async checkAccount(provider: AuthProvider, id: string, settings: AutomationSettings,
    keepAlive: boolean, ignoreBackoff = false, verifying = false): Promise<KeepAliveNowResult> {
    const previous = this.read(provider, id);
    if (!ignoreBackoff && previous.nextAllowedAt && previous.nextAllowedAt > this.now()) {
      return { usageError: 'Account usage check is temporarily paused after a provider error.' };
    }
    let outcome: ProbeResult;
    let credential: StoredCredential | undefined;
    const active = this.profiles.activeProfileId(provider) === id;
    if (active) { this.checkingActive.add(provider); }
    try {
      credential = await this.profiles.credential(provider, id);
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
    const usageError = result.kind === 'ok' ? undefined
      : result.kind === 'error' ? result.message : result.reason ?? 'Usage unavailable.';
    this.write(provider, id, { ...state, checkedAt: this.now(),
      usage: result.kind === 'ok' ? this.serialize(result.usage) : state.usage,
      nextAllowedAt: result.kind === 'error' && result.transient
        ? this.now() + Math.max(settings.checkIntervalMs, result.retryAfterMs ?? 0) : undefined,
      lastError: usageError,
      keepAliveError: keepAlive ? outcome.keepAliveError : state.keepAliveError });
    const revoked = [outcome.keepAliveError, usageError].find(isRevokedCredentialError);
    const problem = revoked ?? (verifying ? outcome.keepAliveError : undefined);
    if (problem && credential) {
      // Fingerprint the login as it was sent: a refresh written back afterwards must not re-announce it.
      const key = `${fingerprint(credential)}:${revoked ? 'revoked' : problem}`;
      if (state.problemNotified !== key) {
        this.write(provider, id, { ...this.read(provider, id), problemNotified: key });
        this.log(`${provider}: account ${id} ${revoked ? 'login was revoked' : 'failed its pre-switch keep-alive'}: ${problem}`);
        this.onAccountProblem?.(provider, id, problem, Boolean(revoked));
      }
    }
    this.log(`${provider}: account ${id} ${keepAlive ? 'keep-alive / ' : ''}usage: ${result.kind}${usageError ? ` (${usageError})` : ''}${outcome.keepAliveError ? `; keep-alive: ${outcome.keepAliveError}` : ''}`);
    return { usage: result.kind === 'ok' ? result.usage : undefined, keepAliveError: outcome.keepAliveError, usageError };
  }

  /**
   * Candidates in the order the strategy prefers, by their cached readings: accounts that look usable first
   * (best score first), then those that look exhausted, then those never read. Ties keep saved-profile order.
   */
  private ranked(provider: AuthProvider, active: string, settings: AutomationSettings): Array<Profile & { score?: number; usable: boolean }> {
    const strategy = settings.strategy ?? 'sequential';
    const now = this.now();
    const group = (entry: { score?: number; usable: boolean; cached: boolean }) =>
      !entry.cached ? 3 : !entry.usable ? 2 : entry.score === undefined ? 1 : 0;
    return nextAccounts(this.profiles.profiles(provider), active).map((profile, index) => {
      const usage = deserializeUsage(this.read(provider, profile.id));
      // A window that has reset since the reading no longer blocks the account.
      const usable = Boolean(usage) && counted(usage!, settings).length > 0 && counted(usage!, settings).every((window) =>
        (window.resetsAt !== undefined && window.resetsAt.getTime() <= now) || window.usedPercent < windowThreshold(window.label, settings));
      return { ...profile, index, usable, cached: Boolean(usage), score: usage ? rotationScore(strategy, usage, now, settings) : undefined };
    }).sort((a, b) => strategy === 'sequential' ? a.index - b.index
      : group(a) - group(b) || (a.score ?? 0) - (b.score ?? 0) || a.index - b.index);
  }

  /** How long `active` has been the active account, as far as rotation has watched; manual switches restart it. */
  private stayedMs(provider: AuthProvider, active: string): number {
    const state = this.read(provider, 'rotation-stay');
    if (state.activeId === active && state.checkedAt !== undefined) { return this.now() - state.checkedAt; }
    this.write(provider, 'rotation-stay', { activeId: active, checkedAt: this.now() });
    return 0;
  }

  private async rotate(provider: AuthProvider, settings: AutomationSettings): Promise<void> {
    if (this.disposed || this.paused || !this.settings(provider).autoRotate) { return; }
    const active = this.profiles.activeProfileId(provider);
    if (!active || this.profiles.profiles(provider).length < 2 || !await this.profiles.matchesNative(provider, active)) { return; }
    const strategy = settings.strategy ?? 'sequential';
    const proactive = settings.trigger === 'proactive' && strategy !== 'sequential';
    const margin = strategy === 'sequential' ? 0 : SWITCH_MARGIN[strategy];
    const usage = deserializeUsage(this.read(provider, active));
    const hinted = this.limitHint.has(provider);
    if (!usage && !hinted) { return; }
    if (!hinted && !atLimit(usage!, settings)) {
      if (!proactive || this.stayedMs(provider, active) < (settings.minStayMs ?? 30 * 60_000)) { return; }
      // Only spend endpoint calls when the cached readings already show a clearly better account.
      const own = rotationScore(strategy, usage!, this.now(), settings);
      if (own === undefined || !this.ranked(provider, active, settings).some((candidate) =>
        candidate.usable && candidate.score !== undefined && candidate.score + margin < own)) { return; }
    }
    // The sweep record throttles all-exhausted and error cases across windows/restarts. Records from before
    // `nextAllowedAt` was kept wait a full interval after `checkedAt`.
    const rotationId = 'rotation-sweep';
    const sweep = this.read(provider, rotationId);
    const retryAt = sweep.nextAllowedAt ?? (sweep.checkedAt !== undefined ? sweep.checkedAt + settings.checkIntervalMs : undefined);
    if (retryAt !== undefined && this.now() < retryAt) { return; }
    const sweepStart = this.now();
    this.write(provider, rotationId, { checkedAt: sweepStart, nextAllowedAt: sweepStart + settings.checkIntervalMs });
    this.limitHint.delete(provider);
    // Never rotate based on a stale cache, offline log, expired reset or a failed refresh. A reading taken moments
    // ago (the status bar's) is as good as a new one and spares the rate-limited endpoint, unless a reset has passed.
    const recent = !hinted && usage !== undefined && this.now() - usage.fetchedAt.getTime() <= RECENT_READING_MS &&
      usage.windows.every((window) => !window.resetsAt || window.resetsAt.getTime() > this.now());
    const current = recent ? usage : (await this.checkAccount(provider, active, settings, false)).usage;
    if (!current) {
      // Not a real sweep: try again as soon as the active account can be read, not a full interval later.
      const readableAt = this.read(provider, active).nextAllowedAt;
      if (readableAt !== undefined) { this.write(provider, rotationId, { checkedAt: sweepStart, nextAllowedAt: readableAt }); }
      return;
    }
    const exhausted = atLimit(current, settings);
    if (!exhausted) { this.write(provider, 'rotation-exhausted', {}); }
    if (!exhausted && !proactive) {
      // The cached reading was out of date and has now been replaced; nothing was spent on candidates.
      this.write(provider, rotationId, { checkedAt: sweepStart });
      return;
    }
    // A working account is only left for one that scores clearly better on a fresh reading too.
    const own = exhausted ? undefined : rotationScore(strategy, current, this.now(), settings);
    if (!exhausted && (!proactive || own === undefined)) { return; }
    const requiredWindows = counted(current, settings).map((window) => window.label);
    for (const candidate of this.ranked(provider, active, settings)) {
      if (this.disposed || this.paused || !this.settings(provider).autoRotate) { return; }
      if (own !== undefined && !(candidate.usable && candidate.score !== undefined && candidate.score + margin < own)) { continue; }
      const candidateUsage = (await this.checkAccount(provider, candidate.id, settings, false)).usage;
      if (!candidateUsage || !eligibleAccount(candidateUsage, this.now(), settings) ||
        !requiredWindows.every((label) => candidateUsage.windows.some((window) => window.label === label))) { continue; }
      const score = rotationScore(strategy, candidateUsage, this.now(), settings);
      if (own !== undefined && !(score !== undefined && score + margin < own)) { continue; }
      if (this.disposed || this.paused || !this.settings(provider).autoRotate) { return; }
      // A usage reading does not prove that the login still works; a real model call does. Never switch to a
      // broken login: report it and try the next account. The call counts as the account's periodic keep-alive.
      this.write(provider, candidate.id, { ...this.read(provider, candidate.id), lastKeepAliveAt: this.now() });
      const verified = await this.checkAccount(provider, candidate.id, settings, true, true, true);
      if (verified.keepAliveError || !verified.usage) {
        this.log(`${provider}: not rotating to "${candidate.name}": ${verified.keepAliveError ?? verified.usageError ?? 'usage unavailable'}`);
        continue;
      }
      if (this.profiles.activeProfileId(provider) !== active || !await this.profiles.matchesNative(provider, active)) { return; }
      if (await this.profiles.activateProfile(provider, candidate.id, true)) {
        this.write(provider, 'rotation-stay', { activeId: candidate.id, checkedAt: this.now() });
        this.write(provider, 'rotation-exhausted', {});
        this.log(`${provider}: automatically rotated to "${candidate.name}" (${strategy}, ${exhausted ? 'active account at its limit' : 'better account available'})`);
        await this.afterActivate(provider, { kind: 'activated', accountChanged: true });
      }
      return; // At most one switch per sweep, including when every account is exhausted.
    }
    if (exhausted) {
      const reached = counted(current, settings).filter((window) => window.usedPercent >= windowThreshold(window.label, settings))
        .map((window) => `${window.label} ${window.usedPercent}% ≥ ${windowThreshold(window.label, settings)}%`).join(', ');
      const detail = `the active account is at its limit (${reached}), but no other saved account is below its rotation thresholds in every usage window`;
      this.log(`${provider}: ${detail}; keeping the active account`);
      if (this.read(provider, 'rotation-exhausted').checkedAt === undefined) {
        this.write(provider, 'rotation-exhausted', { checkedAt: this.now() });
        this.onNoCandidate?.(provider, detail);
      }
    }
  }
}
