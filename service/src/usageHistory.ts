import * as fs from 'fs';
import * as path from 'path';
import type { AuthProvider } from './authFiles';
import { writeJsonAtomically } from './authFiles';
import type { LiveUsage } from './live';

/**
 * Append-only usage history: every reading of every saved account, every account switch with what rotation
 * knew when it chose, the sweeps that switched nothing, and the stretches with every account at its limit. One
 * JSON object per line, one file per month (`history-YYYY-MM.jsonl`), kept for a configurable time. Plain Node,
 * no `vscode` imports, so it can be exercised directly. Every window on the host appends to the same files; a
 * small index file remembers what was last recorded so the same reading is not written by each of them.
 */

export type HistoryAccount = { id: string; name: string; email?: string };
export type HistoryWindow = { label: string; usedPercent: number; resetsAt?: string };
/** A reading as the history stores it: when the vendor produced it (`at`) and its windows. */
export type HistoryUsage = { at: string; plan?: string; windows: HistoryWindow[] };

/**
 * Where a reading came from: the status bar (`status`), a periodic or manual keep-alive (`keepAlive`), a rotation
 * sweep (`rotation`) or another check without a model call (`check`).
 */
export type ReadingSource = 'status' | 'keepAlive' | 'rotation' | 'check';
export type SwitchReason = 'limit' | 'proactive' | 'manual' | 'external';
/**
 * What rotation did with a candidate: `chosen`; `problem` (its last check failed, not read); `limited` (its stored
 * reading is at a threshold with the reset ahead, not read); `notBetter` (a proactive switch needs a clearly better
 * score); `ineligible` (its fresh reading is at a threshold or incomplete); `keepAliveFailed` (the pre-switch
 * model call failed); `notReached` (an earlier candidate was chosen).
 */
export type CandidateOutcome = 'chosen' | 'problem' | 'limited' | 'resetSoon' | 'notBetter' | 'ineligible' | 'keepAliveFailed' | 'notReached';
export type HistoryCandidate = {
  account: HistoryAccount;
  /** Looked usable by its stored reading when the sweep started. */
  usable: boolean;
  /** Strategy score from the stored reading (lower is better); none for `sequential` or without a reading. */
  score?: number;
  /** Score from the fresh reading taken during the sweep, when one was taken. */
  freshScore?: number;
  limitedUntil?: string;
  outcome: CandidateOutcome;
  usage?: HistoryUsage;
  detail?: string;
};
export type RotationSnapshot = {
  strategy: string;
  trigger: string;
  autoReset?: boolean;
  resetAware?: boolean;
  fiveHourThresholdPercent: number;
  weeklyThresholdPercent: number;
  minStayMinutes?: number;
};

export type ReadingEvent = {
  type: 'reading';
  provider: AuthProvider;
  account: HistoryAccount;
  /** Whether the account was the active login when it was read. */
  active: boolean;
  source: ReadingSource;
  usage: HistoryUsage;
};
export type SwitchEvent = {
  type: 'switch';
  provider: AuthProvider;
  from?: HistoryAccount;
  to: HistoryAccount;
  reason: SwitchReason;
  automatic: boolean;
  /** How long `from` had been active, as far as rotation watched it. */
  stayedMs?: number;
  fromUsage?: HistoryUsage;
  toUsage?: HistoryUsage;
  settings?: RotationSnapshot;
  candidates?: HistoryCandidate[];
  /** Endpoint calls the sweep spent. */
  calls?: number;
};
/** A rotation sweep that spent endpoint calls and switched nothing. */
export type SweepEvent = {
  type: 'sweep';
  provider: AuthProvider;
  active: HistoryAccount;
  outcome: 'activeRecovered' | 'noBetterCandidate' | 'noCandidate';
  usage?: HistoryUsage;
  settings?: RotationSnapshot;
  candidates?: HistoryCandidate[];
  calls: number;
};
/** The active account reached a threshold and no saved account could take over; once per such stretch. */
export type ExhaustedEvent = {
  type: 'exhausted';
  provider: AuthProvider;
  active: HistoryAccount;
  usage: HistoryUsage;
  reached: Array<{ label: string; usedPercent: number; threshold: number }>;
  settings?: RotationSnapshot;
  candidates?: HistoryCandidate[];
  /** When the first blocked candidate's window resets, if any is known. */
  nextCandidateAt?: string;
};
/** The stretch with every account at its limit ended: the active account's window reset, or a switch worked. */
export type RecoveredEvent = {
  type: 'recovered';
  provider: AuthProvider;
  active: HistoryAccount;
  by: 'reset' | 'switch';
  afterMs?: number;
};
/** An account check started failing, failed differently, or works again. */
export type CheckEvent = {
  type: 'check';
  provider: AuthProvider;
  account: HistoryAccount;
  ok: boolean;
  keepAlive: boolean;
  error?: string;
  /** The error in a few words, as the Accounts menu shows it. */
  problem?: string;
};

export type HistoryEventBody = ReadingEvent | SwitchEvent | SweepEvent | ExhaustedEvent | RecoveredEvent | CheckEvent;
/** `t`: when the event was written, ISO 8601. */
export type HistoryEvent = HistoryEventBody & { t: string };

export type HistoryOptions = {
  enabled: boolean;
  /** Files whose month ended longer ago than this are deleted. */
  retentionMs: number;
};

/** An unchanged reading is recorded again after this long, so the log shows the account was still being watched. */
export const HEARTBEAT_MS = 60 * 60_000;
/** A switch to the same account seen within this long of the recorded one is the same switch seen from another window. */
const SAME_SWITCH_MS = 2 * 60_000;
const PRUNE_EVERY_MS = 24 * 60 * 60_000;
const FILE_PREFIX = 'history-';
const INDEX_FILE = 'index.json';

type Index = {
  readings?: Record<string, { signature: string; at: string; recordedAt: number }>;
  switches?: Partial<Record<AuthProvider, { to: string; recordedAt: number }>>;
};

export function usageSnapshot(usage: LiveUsage): HistoryUsage;
export function usageSnapshot(usage: LiveUsage | undefined): HistoryUsage | undefined;
export function usageSnapshot(usage: LiveUsage | undefined): HistoryUsage | undefined {
  if (!usage) { return undefined; }
  return {
    at: usage.fetchedAt.toISOString(),
    ...(usage.plan ? { plan: usage.plan } : {}),
    windows: usage.windows.map((window) => ({
      label: window.label, usedPercent: window.usedPercent,
      ...(window.resetsAt ? { resetsAt: window.resetsAt.toISOString() } : {})
    }))
  };
}

/** The month file an event written at `now` goes to. */
export function historyFileName(now: number): string {
  return `${FILE_PREFIX}${new Date(now).toISOString().slice(0, 7)}.jsonl`;
}

/** Epoch ms of the start of the month a history file covers; undefined for a file not named like one. */
export function historyFileStart(name: string): number | undefined {
  const match = new RegExp(`^${FILE_PREFIX}(\\d{4})-(\\d{2})\\.jsonl$`).exec(name);
  return match ? Date.UTC(Number(match[1]), Number(match[2]) - 1, 1) : undefined;
}

/** Epoch ms of the first instant after the month a history file covers; undefined for a file not named like one. */
export function historyFileEnd(name: string): number | undefined {
  const match = new RegExp(`^${FILE_PREFIX}(\\d{4})-(\\d{2})\\.jsonl$`).exec(name);
  if (!match) { return undefined; }
  return Date.UTC(Number(match[1]), Number(match[2]), 1);
}

export class UsageHistory {
  private options: HistoryOptions;
  private lastPruneAt = 0;
  private writeFailed = false;

  constructor(private directory: string, options: HistoryOptions,
    private readonly log: (message: string) => void = () => undefined,
    private readonly now: () => number = Date.now) {
    this.options = { ...options };
  }

  get enabled(): boolean { return this.options.enabled; }
  get retentionMs(): number { return this.options.retentionMs; }
  get location(): string { return this.directory; }

  /** Applies changed settings; a changed directory is used from the next event on, nothing is moved. */
  configure(directory: string, options: HistoryOptions): void {
    if (directory !== this.directory) { this.lastPruneAt = 0; }
    this.directory = directory;
    this.options = { ...options };
  }

  /** The month files in place, oldest first. */
  files(): string[] {
    let names: string[];
    try { names = fs.readdirSync(this.directory); } catch { return []; }
    return names.filter((name) => historyFileEnd(name) !== undefined).sort().map((name) => path.join(this.directory, name));
  }

  /**
   * Records a reading unless it repeats the last one recorded for the account: same windows and plan within the
   * last hour, or older than the one already recorded. Returns whether a line was written.
   */
  reading(provider: AuthProvider, account: HistoryAccount, usage: LiveUsage, source: ReadingSource, active: boolean): boolean {
    if (!this.options.enabled) { return false; }
    const snapshot = usageSnapshot(usage);
    const signature = JSON.stringify([snapshot.plan, snapshot.windows]);
    const key = `${provider}:${account.id}`;
    const index = this.readIndex();
    const last = index.readings?.[key];
    const now = this.now();
    if (last) {
      if (snapshot.at < last.at) { return false; }
      if (last.signature === signature && now - last.recordedAt < HEARTBEAT_MS) { return false; }
    }
    if (!this.append({ type: 'reading', provider, account, active, source, usage: snapshot })) { return false; }
    index.readings = { ...index.readings, [key]: { signature, at: snapshot.at, recordedAt: now } };
    this.writeIndex(index);
    return true;
  }

  /**
   * Appends any other event. A switch seen from outside (`external`) that repeats the switch recorded moments ago,
   * by this or another window, is dropped: it is the same switch, followed. Returns whether a line was written.
   */
  record(event: HistoryEventBody): boolean {
    if (!this.options.enabled) { return false; }
    const index = event.type === 'switch' ? this.readIndex() : undefined;
    if (event.type === 'switch' && index) {
      const last = index.switches?.[event.provider];
      if (event.reason === 'external' && last && last.to === event.to.id && this.now() - last.recordedAt < SAME_SWITCH_MS) { return false; }
    }
    if (!this.append(event)) { return false; }
    if (event.type === 'switch' && index) {
      index.switches = { ...index.switches, [event.provider]: { to: event.to.id, recordedAt: this.now() } };
      this.writeIndex(index);
    }
    return true;
  }

  /** Deletes month files older than the retention; returns the deleted paths. */
  prune(): string[] {
    this.lastPruneAt = this.now();
    const removed: string[] = [];
    for (const file of this.files()) {
      const end = historyFileEnd(path.basename(file))!;
      if (this.now() - end <= this.options.retentionMs) { continue; }
      try { fs.unlinkSync(file); removed.push(file); }
      catch (error) { this.log(`usage history: could not delete ${file}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    if (removed.length) { this.log(`usage history: deleted ${removed.length} file(s) older than ${Math.round(this.options.retentionMs / 86_400_000)} days`); }
    return removed;
  }

  /** Prunes once a day at most. */
  pruneIfDue(): void {
    if (this.now() - this.lastPruneAt >= PRUNE_EVERY_MS) { this.prune(); }
  }

  /** Every retained event written at or after `since`, oldest first; unreadable lines are skipped. */
  *events(since = 0): Generator<HistoryEvent> {
    const from = new Date(since).toISOString();
    for (const file of this.files()) {
      if (historyFileEnd(path.basename(file))! <= since) { continue; }
      let text: string;
      try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
      for (const line of text.split('\n')) {
        if (!line.trim()) { continue; }
        let event: HistoryEvent;
        try { event = JSON.parse(line); } catch { continue; }
        if (!event || typeof event !== 'object' || typeof event.t !== 'string' || typeof event.type !== 'string') { continue; }
        if (event.t < from) { continue; }
        yield event;
      }
    }
  }

  private append(body: HistoryEventBody): boolean {
    const now = this.now();
    const line = `${JSON.stringify({ t: new Date(now).toISOString(), ...body })}\n`;
    try {
      fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      fs.appendFileSync(path.join(this.directory, historyFileName(now)), line, { mode: 0o600 });
      this.writeFailed = false;
      return true;
    } catch (error) {
      // Reported once per run of failures: a full disk must not fill the log too.
      if (!this.writeFailed) { this.log(`usage history: could not write to ${this.directory}: ${error instanceof Error ? error.message : String(error)}`); }
      this.writeFailed = true;
      return false;
    }
  }

  private readIndex(): Index {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(this.directory, INDEX_FILE), 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed as Index : {};
    } catch { return {}; }
  }

  private writeIndex(index: Index): void {
    try { writeJsonAtomically(path.join(this.directory, INDEX_FILE), index); }
    catch { /* The next reading is recorded once more at worst. */ }
  }
}

function csvCell(value: unknown): string {
  if (value === undefined || value === null) { return ''; }
  const text = typeof value === 'number' ? String(value) : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csv(rows: unknown[][]): string {
  return rows.map((row) => row.map(csvCell).join(',')).join('\n') + '\n';
}

/** Readings as a long table: one row per account, reading and window. */
export function readingsCsv(events: Iterable<HistoryEvent>): string {
  const rows: unknown[][] = [['time', 'provider', 'account', 'email', 'active', 'source', 'read_at', 'plan', 'window', 'used_percent', 'resets_at']];
  for (const event of events) {
    if (event.type !== 'reading') { continue; }
    for (const window of event.usage.windows) {
      rows.push([event.t, event.provider, event.account.name, event.account.email, event.active, event.source,
        event.usage.at, event.usage.plan, window.label, window.usedPercent, window.resetsAt]);
    }
  }
  return csv(rows);
}

function windowSummary(usage: HistoryUsage | undefined): string {
  return usage ? usage.windows.map((window) => `${window.label} ${window.usedPercent}%`).join(' ') : '';
}

/** Switches, sweeps, exhausted stretches, recoveries and check changes, one row each. */
export function eventsCsv(events: Iterable<HistoryEvent>): string {
  const rows: unknown[][] = [['time', 'provider', 'type', 'reason', 'from', 'to', 'stayed_minutes', 'from_usage', 'to_usage', 'calls', 'strategy', 'trigger', 'detail']];
  for (const event of events) {
    switch (event.type) {
      case 'switch':
        rows.push([event.t, event.provider, event.type, event.reason, event.from?.name, event.to.name,
          event.stayedMs === undefined ? undefined : Math.round(event.stayedMs / 60_000), windowSummary(event.fromUsage), windowSummary(event.toUsage),
          event.calls, event.settings?.strategy, event.settings?.trigger,
          event.candidates?.map((candidate) => `${candidate.account.name}: ${candidate.outcome}`).join('; ')]);
        break;
      case 'sweep':
        rows.push([event.t, event.provider, event.type, event.outcome, event.active.name, undefined, undefined, windowSummary(event.usage), undefined,
          event.calls, event.settings?.strategy, event.settings?.trigger,
          event.candidates?.map((candidate) => `${candidate.account.name}: ${candidate.outcome}`).join('; ')]);
        break;
      case 'exhausted':
        rows.push([event.t, event.provider, event.type, event.reached.map((window) => `${window.label} ${window.usedPercent}% >= ${window.threshold}%`).join(' '),
          event.active.name, undefined, undefined, windowSummary(event.usage), undefined, undefined, event.settings?.strategy, event.settings?.trigger,
          [event.nextCandidateAt ? `next candidate at ${event.nextCandidateAt}` : undefined,
            event.candidates?.map((candidate) => `${candidate.account.name}: ${candidate.outcome}`).join('; ')].filter(Boolean).join(' · ')]);
        break;
      case 'recovered':
        rows.push([event.t, event.provider, event.type, event.by, event.active.name, undefined,
          event.afterMs === undefined ? undefined : Math.round(event.afterMs / 60_000)]);
        break;
      case 'check':
        rows.push([event.t, event.provider, event.type, event.ok ? 'ok' : (event.keepAlive ? 'keep-alive failed' : 'usage check failed'),
          event.account.name, undefined, undefined, undefined, undefined, undefined, undefined, undefined, event.problem ?? event.error]);
        break;
      default:
        break;
    }
  }
  return csv(rows);
}
