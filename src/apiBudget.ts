import * as fs from 'fs';
import * as path from 'path';
import { RateLimitHint } from './live';

/**
 * One spacing rule for a remote endpoint, shared by every VS Code window on this machine. The Claude
 * usage endpoint is called for the active login, once per saved account during keep-alive and
 * rotation sweeps, and again whenever the details panel is refreshed by hand; counted per account
 * each path looks harmless, but together they exceed what the service allows. The ledger lives in a
 * file next to the usage cache so other windows and later sessions see the same last-call time.
 * No `vscode` imports so it can be exercised with plain Node.
 */

type BudgetFile = {
  version: 1;
  /** Epoch ms when the most recent call started, in any window. */
  lastCallAt?: number;
  /** Epoch ms before which no call may start, from what the service last reported. */
  blockedUntil?: number;
  /** Spacing implied by the service's own rate-limit headers, when it sends them. */
  advertisedIntervalMs?: number;
};

/** Upper bound for a derived spacing, so one odd header cannot stall usage readings for hours. */
export const MAX_ADVERTISED_INTERVAL_MS = 15 * 60_000;

export class ApiCallBudget {
  constructor(
    private readonly file: string,
    private readonly minIntervalMs: () => number,
    private readonly now: () => number = Date.now
  ) {}

  /** Epoch ms when the next call may start; at or before now means it may start immediately. */
  nextAllowedAt(now = this.now()): number {
    return this.allowedFrom(this.read(), now);
  }

  /**
   * Claims the next call slot. Returns false when a call would be too early, in which case the
   * caller must serve its cached reading instead. Read-modify-write keeps concurrent windows from
   * claiming the same slot; a torn read at worst costs one extra call.
   */
  reserve(now = this.now()): boolean {
    const state = this.read();
    if (this.allowedFrom(state, now) > now) {
      return false;
    }
    this.write({ ...state, lastCallAt: now });
    return true;
  }

  /** Waits for a slot and claims it. Returns false when that would take longer than `maxWaitMs`. */
  async waitForSlot(maxWaitMs: number, signal?: AbortSignal): Promise<boolean> {
    const deadline = this.now() + maxWaitMs;
    while (!signal?.aborted) {
      if (this.reserve()) {
        return true;
      }
      const wait = this.nextAllowedAt() - this.now();
      if (this.now() + wait > deadline) {
        return false;
      }
      // Re-check at least once a second: another window's call moves the slot further out.
      await sleep(Math.min(Math.max(wait, 25), 1_000), signal);
    }
    return false;
  }

  /** Applies the limit the service reported about itself. */
  observe(hint: RateLimitHint | undefined, now = this.now()): void {
    if (!hint) {
      return;
    }
    const state = this.read();
    let blockedUntil = state.blockedUntil && state.blockedUntil > now ? state.blockedUntil : undefined;
    if (hint.retryAfterMs !== undefined) {
      blockedUntil = Math.max(blockedUntil ?? 0, now + hint.retryAfterMs);
    }
    if (hint.remaining !== undefined && hint.remaining <= 0 && hint.resetAt !== undefined) {
      blockedUntil = Math.max(blockedUntil ?? 0, hint.resetAt);
    }
    // Spread what is left of the quota over the rest of its window, so a sweep across several
    // accounts cannot spend it all at once and leave the next reading rate-limited.
    const remaining = hint.remaining;
    const advertisedIntervalMs = remaining !== undefined && remaining > 0 && hint.resetAt !== undefined && hint.resetAt > now
      ? Math.min(MAX_ADVERTISED_INTERVAL_MS, Math.ceil((hint.resetAt - now) / remaining))
      : undefined;
    this.write({ ...state, blockedUntil, advertisedIntervalMs });
  }

  private allowedFrom(state: BudgetFile, now: number): number {
    const spacing = Math.max(0, this.minIntervalMs(), state.advertisedIntervalMs ?? 0);
    const afterLastCall = state.lastCallAt === undefined ? 0 : state.lastCallAt + spacing;
    // A clock change or a hand-edited ledger must not block calls forever.
    return Math.min(Math.max(state.blockedUntil ?? 0, afterLastCall), now + MAX_ADVERTISED_INTERVAL_MS);
  }

  private read(): BudgetFile {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<BudgetFile>;
      if (parsed && parsed.version === 1) {
        return { ...parsed, version: 1 };
      }
    } catch {
      // Missing or corrupt ledger: start fresh.
    }
    return { version: 1 };
  }

  private write(state: BudgetFile): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state));
      fs.renameSync(tmp, this.file);
    } catch {
      // Best effort: a failed write only costs an extra call.
    }
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    let timer: NodeJS.Timeout;
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}
