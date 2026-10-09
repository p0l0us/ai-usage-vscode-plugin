import { formatResetRemaining } from '../service/out';
import type { ResetCreditProjection } from '../service/out';

/** Round quota percentages for display without changing the underlying usage reading. */
export function formatUsagePercent(usedPercent: number): string {
  return `${Math.round(usedPercent)}%`;
}

/** Availability is supplied by the service; missing data must not look like a zero balance. */
export function formatEarnedResetCount(availableCount: number | undefined, enabled = true): string {
  return enabled && availableCount !== undefined ? `$(refresh) ${availableCount}` : '';
}
/** Compact menu balance against the observed total, followed by the next reported credit expiry. */
export function formatEarnedResetSummary(credits: ResetCreditProjection, now = new Date()): string {
  if (credits.state === 'unknown') { return '$(refresh) ?/?'; }
  const available = credits.state === 'known' ? credits.availableCount : credits.lastReportedAvailableCount;
  const remaining = credits.earliestExpiresAt !== undefined && credits.earliestExpiresAt * 1000 > now.getTime()
    ? formatResetRemaining(new Date(credits.earliestExpiresAt * 1000), now) : '';
  return `$(refresh) ${available}/${credits.totalCount ?? '?'}${remaining ? ` (${remaining})` : ''}${credits.state === 'stale' ? ' (stale)' : ''}`;
}
