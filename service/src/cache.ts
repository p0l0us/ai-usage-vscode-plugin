import * as fs from 'fs';
import * as path from 'path';
import { LiveUsage, ProviderId } from './live';

/**
 * Shared on-disk cache so every VS Code window on this machine reuses one reading per provider
 * and respects one backoff schedule. Each provider has an independent entry; a failure for one
 * never affects the others. No `vscode` imports so it can be tested with plain Node.
 */

export type CacheEntry = {
  /** Last successful reading, serialised with ISO dates. */
  usage?: SerializedUsage;
  /** Epoch ms when the network must not be called before (backoff). */
  nextAllowedAt?: number;
  /** Consecutive failures that triggered a backoff. */
  failures?: number;
  lastError?: string;
  /** Epoch ms when some window started a fetch; lets other windows wait instead of duplicating it. */
  fetchingSince?: number;
};

type SerializedUsage = Omit<LiveUsage, 'fetchedAt' | 'windows'> & {
  fetchedAt: string;
  windows: Array<{ label: string; usedPercent: number; resetsAt?: string }>;
};

type CacheFile = { version: 1; entries: Record<string, CacheEntry> };

export const BACKOFF_MIN_MS = 60_000;
export const BACKOFF_MAX_MS = 30 * 60_000;
/** A fetch marker older than this is considered abandoned (crashed window, timeout). */
export const FETCH_LOCK_TTL_MS = 30_000;

export class SharedCache {
  constructor(private readonly file: string) {}

  /** Cache key for a provider; Copilot's result depends on the workspace's repository owners. */
  static key(provider: ProviderId, discriminator?: string): string {
    return discriminator ? `${provider}:${discriminator}` : provider;
  }

  read(key: string): CacheEntry | undefined {
    return this.readAll().entries[key];
  }

  /** Read-modify-write. The file is small and writes are atomic (temp file + rename). */
  update(key: string, mutate: (entry: CacheEntry) => CacheEntry | undefined): CacheEntry | undefined {
    const data = this.readAll();
    const next = mutate({ ...(data.entries[key] ?? {}) });
    if (next) {
      data.entries[key] = next;
    } else {
      delete data.entries[key];
    }
    this.writeAll(data);
    return next;
  }

  /** Marks the entry as being fetched by this window; returns false if another window holds a live lock. */
  tryLock(key: string, now = Date.now()): boolean {
    let acquired = false;
    this.update(key, (entry) => {
      if (entry.fetchingSince && now - entry.fetchingSince < FETCH_LOCK_TTL_MS) {
        return entry;
      }
      acquired = true;
      return { ...entry, fetchingSince: now };
    });
    return acquired;
  }

  recordSuccess(key: string, usage: LiveUsage): void {
    this.update(key, () => ({ usage: serializeUsage(usage) }));
  }

  /**
   * Records a failure that should back off (rate limit or server error). Returns the epoch ms
   * until which the network must not be called for this provider.
   */
  recordBackoff(key: string, message: string, retryAfterMs?: number, now = Date.now()): number {
    let nextAllowedAt = now;
    this.update(key, (entry) => {
      const failures = (entry.failures ?? 0) + 1;
      const wait = retryAfterMs ?? Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** (failures - 1));
      nextAllowedAt = now + Math.max(BACKOFF_MIN_MS, Math.min(BACKOFF_MAX_MS, wait));
      return { usage: entry.usage, failures, lastError: message, nextAllowedAt };
    });
    return nextAllowedAt;
  }

  /** Records a failure that should not back off (auth problems, bad payload) and releases the lock. */
  recordFailure(key: string, message: string): void {
    this.update(key, (entry) => ({ usage: entry.usage, failures: entry.failures, nextAllowedAt: entry.nextAllowedAt, lastError: message }));
  }

  release(key: string): void {
    this.update(key, (entry) => {
      const { fetchingSince: _ignored, ...rest } = entry;
      return rest;
    });
  }

  private readAll(): CacheFile {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<CacheFile>;
      if (parsed && parsed.version === 1 && parsed.entries && typeof parsed.entries === 'object') {
        return { version: 1, entries: parsed.entries };
      }
    } catch {
      // Missing or corrupt file: start fresh.
    }
    return { version: 1, entries: {} };
  }

  private writeAll(data: CacheFile): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data));
      fs.renameSync(tmp, this.file);
    } catch {
      // Cache is best effort; a failed write only costs an extra network call.
    }
  }
}

function serializeUsage(usage: LiveUsage): SerializedUsage {
  return {
    ...usage,
    fetchedAt: usage.fetchedAt.toISOString(),
    windows: usage.windows.map((window) => ({
      label: window.label,
      usedPercent: window.usedPercent,
      resetsAt: window.resetsAt?.toISOString()
    }))
  };
}

export function deserializeUsage(entry: CacheEntry | undefined): LiveUsage | undefined {
  const usage = entry?.usage;
  if (!usage) {
    return undefined;
  }
  const fetchedAt = new Date(usage.fetchedAt);
  if (Number.isNaN(fetchedAt.getTime())) {
    return undefined;
  }
  return {
    ...usage,
    fetchedAt,
    windows: usage.windows.map((window) => ({
      label: window.label,
      usedPercent: window.usedPercent,
      resetsAt: window.resetsAt ? new Date(window.resetsAt) : undefined
    }))
  };
}
