/** Round quota percentages for display without changing the underlying usage reading. */
export function formatUsagePercent(usedPercent: number): string {
  return `${Math.round(usedPercent)}%`;
}
