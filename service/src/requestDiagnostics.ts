import { AsyncLocalStorage } from 'async_hooks';
import * as fs from 'fs';
import { writeJsonAtomically } from './authFiles';

/** Counts observable operations, never inferred HTTP traffic inside a vendor CLI. */
export type RequestMetric = 'http' | 'rpc' | 'process' | 'model' | 'cacheHit' | 'blocked' | 'joined';
const scope = new AsyncLocalStorage<(metric: RequestMetric) => void>();
export function countRequest(metric: RequestMetric): void { scope.getStore()?.(metric); }
export function traceRequests<T>(record: (metric: RequestMetric) => void, operation: () => T): T {
  return scope.run(record, operation);
}

/** Seventy-two hourly buckets; provider-level counts only, no account identifiers or request bodies. */
export class RequestDiagnostics {
  private buckets: Record<string, Record<string, Partial<Record<RequestMetric, number>>>> = {};
  constructor(private readonly file: string, private readonly now: () => number = Date.now) {
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const [hour, providers] of Object.entries(saved ?? {})) {
        if (!/^\d+$/.test(hour) || typeof providers !== 'object' || !providers) continue;
        for (const [provider, counts] of Object.entries(providers)) {
          if (!['claude', 'codex'].includes(provider) || typeof counts !== 'object' || !counts) continue;
          for (const [metric, count] of Object.entries(counts)) {
            if (!['http', 'rpc', 'process', 'model', 'cacheHit', 'blocked', 'joined'].includes(metric) || typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) continue;
            ((this.buckets[hour] ??= {})[provider] ??= {})[metric as RequestMetric] = count;
          }
        }
      }
    } catch { /* Start fresh. */ }
  }
  record(provider: string, metric: RequestMetric): void {
    const hour = String(Math.floor(this.now() / 3_600_000));
    const bucket = this.buckets[hour] ??= {};
    const own = bucket[provider] ??= {};
    own[metric] = (own[metric] ?? 0) + 1;
    for (const key of Object.keys(this.buckets)) if (Number(key) < Number(hour) - 71 || Number(key) > Number(hour)) delete this.buckets[key];
    try { writeJsonAtomically(this.file, this.buckets); } catch { /* Diagnostics must not interrupt a request. */ }
  }
  summary(provider: string): string {
    const own = this.buckets[String(Math.floor(this.now() / 3_600_000))]?.[provider] ?? {};
    return `Requests this UTC hour: ${own.http ?? 0} direct HTTP, ${own.rpc ?? 0} RPC, ${own.process ?? 0} CLI starts, ${own.model ?? 0} model attempts; ${own.cacheHit ?? 0} cache hits, ${own.blocked ?? 0} suppressed. CLI upstream HTTP is not measured.`;
  }
}
