import type { SerializedUsage, LifecycleState } from './protocol';
import type { ProviderId } from './live';

/** Conservative local display policy, not a provider-guaranteed credit TTL. */
export const RESET_CREDIT_FRESHNESS_MS = 15 * 60_000;
export type CreditReading = { fetchedAt: string | Date; resetCredits?: { availableCount: number; earliestExpiresAt?: number; totalCount?: number } };
type CreditFacts = { observedAt: string; validUntil: string; earliestExpiresAt?: number; totalCount?: number };
export type ResetCreditProjection =
  | ({ state: 'known'; availableCount: number } & CreditFacts)
  | ({ state: 'stale'; lastReportedAvailableCount: number } & CreditFacts)
  | { state: 'unknown' };

function timestamp(value: string | Date): number { return value instanceof Date ? value.getTime() : typeof value === 'string' ? Date.parse(value) : NaN; }
function count(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }

/** Identity-matched readings only: callers must not supply another account's fallback. */
export function projectResetCredits(primary?: CreditReading, now = Date.now(), fallback?: CreditReading): ResetCreditProjection {
  const readings = [primary, fallback].filter((reading): reading is CreditReading => !!reading?.resetCredits);
  if (!readings.length || !Number.isFinite(now)) return { state: 'unknown' };
  // An invalid report time cannot be safely ordered behind an older usable report.
  if (readings.some(reading => !Number.isFinite(timestamp(reading.fetchedAt)))) return { state: 'unknown' };
  const latest = readings.reduce((a, b) => timestamp(a.fetchedAt) >= timestamp(b.fetchedAt) ? a : b);
  const observed = timestamp(latest.fetchedAt), credits = latest.resetCredits!;
  if (observed > now || !count(credits.availableCount) ||
    (credits.earliestExpiresAt !== undefined && (!Number.isFinite(credits.earliestExpiresAt) || credits.earliestExpiresAt <= 0 || !Number.isFinite(credits.earliestExpiresAt * 1000) || credits.earliestExpiresAt * 1000 > 8.64e15))) return { state: 'unknown' };
  const validUntil = Math.min(observed + RESET_CREDIT_FRESHNESS_MS, credits.earliestExpiresAt === undefined ? Infinity : credits.earliestExpiresAt * 1000);
  if (!Number.isFinite(validUntil) || Math.abs(validUntil) > 8.64e15) return { state: 'unknown' };
  const facts: CreditFacts = { observedAt: new Date(observed).toISOString(), validUntil: new Date(validUntil).toISOString(),
    ...(credits.earliestExpiresAt === undefined ? {} : { earliestExpiresAt: credits.earliestExpiresAt }),
    ...(count(credits.totalCount) ? { totalCount: credits.totalCount } : {}) };
  return now < validUntil ? { state: 'known', availableCount: credits.availableCount, ...facts }
    : { state: 'stale', lastReportedAvailableCount: credits.availableCount, ...facts };
}

export type StatusCursor = { epoch: string; revision: number };
export type StatusWindow = { label: string; kind: 'general' | 'model'; usedPercent: number; displayUsedPercent: number; resetsAt?: string; reportedAvailability: 'available' | 'exhausted' };
export type QuotaProjection = { state: 'fresh' | 'stale' | 'unknown'; fetchedAt?: string; validUntil?: string; windows: StatusWindow[];
  accountAttributed: boolean; source?: SerializedUsage['source']; availability: 'available' | 'general-exhausted' | 'model-limited' | 'unknown' };
export type StatusAccount = { id: string; name: string; selected: boolean; quota: QuotaProjection; resetCredits?: ResetCreditProjection };
export type StatusNative = { kind: 'saved' | 'unsaved' | 'unknown' | 'none'; profileId?: string; quota: QuotaProjection; resetCredits?: ResetCreditProjection };
export type StatusProvider = { provider: ProviderId; savedAccountCount: number; accounts: StatusAccount[]; native: StatusNative };
export type StatusSnapshot = { cursor: StatusCursor; capturedAt: string; configRevision: number; lifecycle: LifecycleState; providers: StatusProvider[] };
export type StatusFilter = { providers?: ProviderId[]; accountIds?: string[]; since?: StatusCursor };
export type StatusRead = { status: 'snapshot'; snapshot: StatusSnapshot; resync: boolean } | { status: 'unchanged'; cursor: StatusCursor };

/** Raw percentages stay unchanged; whole percentages match toolbar display rounding. */
export function projectQuota(usage: SerializedUsage | undefined, now: number, intervalMs: number, accountAttributed = true): QuotaProjection {
  const unknown: QuotaProjection = { state: 'unknown', windows: [], accountAttributed, availability: 'unknown' };
  if (!usage || !Array.isArray(usage.windows) || !usage.windows.length) return unknown;
  const observed = timestamp(usage.fetchedAt);
  if (!Number.isFinite(observed) || observed > now || usage.windows.some(window => !window || typeof window.label !== 'string' || !Number.isFinite(window.usedPercent) || window.usedPercent < 0 || window.usedPercent > 100 ||
    (window.resetsAt !== undefined && !Number.isFinite(Date.parse(window.resetsAt))))) return unknown;
  const validUntil = Math.min(observed + intervalMs, ...usage.windows.map(window => window.resetsAt === undefined ? Infinity : Date.parse(window.resetsAt)));
  if (!Number.isFinite(validUntil) || Math.abs(validUntil) > 8.64e15) return unknown;
  const windows: StatusWindow[] = usage.windows.map(window => ({ label: window.label, kind: /^\d+d\s/.test(window.label) ? 'model' : 'general',
    usedPercent: window.usedPercent, displayUsedPercent: Math.round(window.usedPercent), ...(window.resetsAt ? { resetsAt: window.resetsAt } : {}),
    reportedAvailability: window.usedPercent >= 100 ? 'exhausted' : 'available' }));
  const fresh = now < validUntil;
  return { state: fresh ? 'fresh' : 'stale', fetchedAt: new Date(observed).toISOString(), validUntil: new Date(validUntil).toISOString(), windows, accountAttributed, ...(usage.source ? { source: usage.source } : {}),
    availability: !fresh || !windows.some(window => window.kind === 'general') ? 'unknown' : windows.some(window => window.kind === 'general' && window.reportedAvailability === 'exhausted') ? 'general-exhausted'
      : windows.some(window => window.kind === 'model' && window.reportedAvailability === 'exhausted') ? 'model-limited' : 'available' };
}
