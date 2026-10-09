/** Round quota percentages for display without changing the underlying usage reading. */
export function formatUsagePercent(usedPercent: number): string {
  return `${Math.round(usedPercent)}%`;
}

/** Availability is supplied by the service; missing data must not look like a zero balance. */
export function formatEarnedResetCount(availableCount: number | undefined, enabled = true): string {
  return enabled && availableCount !== undefined ? `$(refresh) ${availableCount}` : '';
}
