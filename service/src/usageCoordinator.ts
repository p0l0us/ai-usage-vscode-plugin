import { createHash } from 'crypto';
import { AuthProvider, StoredCredential } from './authFiles';
import { decodeJwtClaims } from './accountIdentity';
import { SharedCache, deserializeUsage } from './cache';
import { LiveResult, isFreshUsage } from './live';
import { RequestMetric, traceRequests } from './requestDiagnostics';
import { needsSignIn } from './accountProbe';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value) ?? 'null').digest('hex');
export const credentialGeneration = digest;
/** Workspace and user are both required. Unknown schemas are isolated, never merged by email or JWT sub. */
export function usageAccountKey(provider: AuthProvider, credential: StoredCredential | undefined, fallback?: string): string {
  const tokens = credential?.tokens as Record<string, unknown> | undefined;
  const claims = typeof tokens?.id_token === 'string' ? decodeJwtClaims(tokens.id_token) : undefined;
  const auth = claims?.['https://api.openai.com/auth'] as Record<string, unknown> | undefined;
  const user = auth?.chatgpt_user_id;
  const workspace = tokens?.account_id ?? auth?.chatgpt_account_id;
  const identity = provider === 'codex' && typeof user === 'string' && user && typeof workspace === 'string' && workspace
    ? ['chatgpt', user, workspace] : provider === 'claude' && typeof credential?.accountUuid === 'string'
      ? ['oauth', credential.accountUuid] : ['isolated', fallback ?? digest(credential ?? {})];
  return `${provider}:${digest(identity)}`;
}

/** Called under the service's account lock. The daemon lease owns writes; promises coalesce in-process reads. */
export class UsageCoordinator {
  private readonly cache: SharedCache;
  private readonly pending = new Map<string, Promise<LiveResult>>();
  constructor(file: string, private readonly now: () => number = Date.now,
    private readonly metric: (provider: AuthProvider, metric: RequestMetric) => void = () => {}) {
    this.cache = new SharedCache(file);
  }
  nextAllowedAt(key: string): number { return this.cache.read(key)?.nextAllowedAt ?? 0; }
  blocked(provider: AuthProvider, key: string): LiveResult | undefined {
    const entry = this.cache.read(key), deadline = entry?.nextAllowedAt ?? 0;
    if (deadline <= this.now()) return undefined;
    this.metric(provider, 'blocked');
    return { kind: 'error', provider, title: provider, transient: true, status: 429,
      retryAfterMs: deadline - this.now(), message: `Usage requests paused until ${new Date(deadline).toISOString()}.` };
  }
  observe(key: string, result: LiveResult, generation?: string): void {
    if (result.kind === 'error' && generation && needsSignIn(result.message)) {
      this.cache.update(key, entry => ({ ...entry, authGeneration: generation }));
    }
    if (result.kind === 'error' && (result.transient || result.retryAfterMs !== undefined || result.status === 429)) {
      this.cache.recordBackoff(key, result.message, result.retryAfterMs, this.now());
    } else if (result.kind === 'ok' && result.usage.source !== 'sessionLog') {
      // A successful local result, or concurrent completion, must never erase a server deadline.
      const deadline = this.cache.read(key)?.nextAllowedAt;
      this.cache.recordSuccess(key, result.usage);
      if (deadline && deadline > this.now()) this.cache.update(key, entry => ({ ...entry, nextAllowedAt: deadline }));
    }
  }
  async read(provider: AuthProvider, key: string, operation: () => Promise<LiveResult>,
    { reuseMs = 5_000, credits = false, generation, manual = false, isCurrent }:
    { reuseMs?: number; credits?: boolean; generation?: string; manual?: boolean; isCurrent?: () => boolean } = {}): Promise<LiveResult> {
    const blocked = this.blocked(provider, key);
    if (blocked) return blocked;
    if (!manual && generation && this.cache.read(key)?.authGeneration === generation) {
      this.metric(provider, 'blocked');
      return { kind: 'error', provider, title: provider, status: 401, message: 'Sign in again to resume automatic usage checks.' };
    }
    const existing = this.pending.get(key);
    if (existing) {
      this.metric(provider, 'joined');
      const result = await existing;
      if (!credits || result.kind !== 'ok' || result.usage.resetCredits) return result;
      return this.read(provider, key, operation, { reuseMs, credits, generation, manual, isCurrent });
    }
    const cached = deserializeUsage(this.cache.read(key));
    if (cached && isFreshUsage(cached, provider, manual ? 0 : reuseMs, this.now()) && (!credits || cached.resetCredits)) {
      this.metric(provider, 'cacheHit'); return { kind: 'ok', usage: cached };
    }
    const task = traceRequests(metric => this.metric(provider, metric), async () => {
      let result: LiveResult;
      try { result = await operation(); }
      catch { result = { kind: 'error', provider, title: provider, message: 'Usage request failed.', transient: true }; }
      if (isCurrent && !isCurrent()) {
        // Keep throttle evidence for the account whose request was admitted, even when its result is discarded.
        if (result.kind === 'error') this.observe(key, result, generation);
        return { kind: 'unavailable' as const, provider, reason: 'The login changed during the request; waiting for its reading.' };
      }
      this.observe(key, result, generation);
      return result;
    }).finally(() => this.pending.delete(key));
    this.pending.set(key, task);
    return task;
  }
  invalidate(key: string): void { this.cache.update(key, entry => ({ ...entry, usage: undefined })); }
}
