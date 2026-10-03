import { windowKind } from './accountAutomation';
import type { AuthProvider } from './authFiles';
import type { HistoryAccount, HistoryEvent, HistoryUsage, SwitchEvent } from './usageHistory';

/**
 * Turns the usage history into figures that answer two questions: how much of each account's allowance is used,
 * and what rotation did. Plain Node, no `vscode` imports.
 */

export type Thresholds = { fiveHourThresholdPercent: number; weeklyThresholdPercent: number };
const DEFAULT_THRESHOLDS: Thresholds = { fiveHourThresholdPercent: 95, weeklyThresholdPercent: 99 };
/** Average weekly use above which an account set is considered fully loaded. */
const HEADROOM = 0.85;

export type WindowStats = {
  label: string;
  kind: 'short' | 'weekly' | 'modelWeekly';
  /** Reset cycles seen; `complete` ones had their reset before the end of the period, so their peak is final. */
  cycles: number;
  completeCycles: number;
  /** Mean of the complete cycles' peak usage, in percent. */
  meanPeak?: number;
  /** Complete cycles whose peak reached the threshold. */
  atLimit: number;
  threshold: number;
};

export type AccountSummary = {
  account: HistoryAccount;
  readings: number;
  firstSeen?: string;
  lastSeen?: string;
  /** Time as the active login within the period, from the switch events. */
  activeMs: number;
  windows: WindowStats[];
  switchedTo: number;
  switchedFrom: number;
  checkFailures: number;
  latest?: HistoryUsage;
};

export type SwitchStats = {
  total: number;
  limit: number;
  proactive: number;
  manual: number;
  external: number;
  /** Time between consecutive switches, oldest first; the last switch's stay is still open and not counted. */
  stays: number[];
  medianStayMs?: number;
  /** The newest switches, newest first. */
  recent: Array<SwitchEvent & { t: string }>;
};

export type ExhaustedStats = { episodes: number; totalMs: number; longestMs: number; open: boolean };

export type Estimate = {
  /** Accounts with at least one complete weekly cycle. */
  accounts: number;
  /** Average weekly use summed over those accounts: account-weeks of allowance used per week. */
  weeklyDemand: number;
  needed: number;
  notes: string[];
};

export type ProviderSummary = {
  provider: AuthProvider;
  readings: number;
  first?: string;
  last?: string;
  accounts: AccountSummary[];
  switches: SwitchStats;
  exhausted: ExhaustedStats;
  sweeps: { count: number; calls: number; byOutcome: Record<string, number> };
  /** Endpoint calls rotation spent, in switches and sweeps. */
  calls: number;
  estimate?: Estimate;
};

export type HistorySummary = { since: number; until: number; providers: ProviderSummary[] };

type Cycle = { peak: number; readings: number; complete: boolean };

function median(values: number[]): number | undefined {
  if (!values.length) { return undefined; }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Summarizes the events between `since` and `until` (epoch ms). Thresholds decide which cycles count as "at the
 * limit"; pass the provider's rotation thresholds so the report agrees with the Accounts menu.
 */
export function summarizeHistory(events: Iterable<HistoryEvent>, options: {
  since: number; until: number; thresholds?: Partial<Record<AuthProvider, Thresholds>>;
}): HistorySummary {
  const from = new Date(options.since).toISOString();
  const to = new Date(options.until).toISOString();
  const byProvider = new Map<AuthProvider, HistoryEvent[]>();
  for (const event of events) {
    if (event.t < from || event.t > to) { continue; }
    const list = byProvider.get(event.provider) ?? [];
    list.push(event);
    byProvider.set(event.provider, list);
  }
  const providers = [...byProvider.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([provider, list]) => summarizeProvider(provider, list, options.until, options.thresholds?.[provider] ?? DEFAULT_THRESHOLDS));
  return { since: options.since, until: options.until, providers };
}

function summarizeProvider(provider: AuthProvider, events: HistoryEvent[], until: number, thresholds: Thresholds): ProviderSummary {
  events.sort((a, b) => a.t.localeCompare(b.t));
  const untilIso = new Date(until).toISOString();
  const accounts = new Map<string, AccountSummary & { cycles: Map<string, Cycle> }>();
  const accountOf = (account: HistoryAccount) => {
    let summary = accounts.get(account.id);
    if (!summary) {
      summary = { account, readings: 0, activeMs: 0, windows: [], switchedTo: 0, switchedFrom: 0, checkFailures: 0, cycles: new Map() };
      accounts.set(account.id, summary);
    }
    // The newest name and email win: a renamed profile is one account.
    summary.account = { ...summary.account, ...account };
    return summary;
  };
  let readings = 0, first: string | undefined, last: string | undefined;
  const switches: SwitchStats = { total: 0, limit: 0, proactive: 0, manual: 0, external: 0, stays: [], recent: [] };
  const switchEvents: Array<SwitchEvent & { t: string }> = [];
  const exhausted: ExhaustedStats = { episodes: 0, totalMs: 0, longestMs: 0, open: false };
  let exhaustedSince: string | undefined;
  const sweeps = { count: 0, calls: 0, byOutcome: {} as Record<string, number> };
  let calls = 0;
  let lastActive: HistoryAccount | undefined;
  for (const event of events) {
    switch (event.type) {
      case 'reading': {
        readings++;
        first ??= event.t;
        last = event.t;
        const summary = accountOf(event.account);
        summary.readings++;
        summary.firstSeen ??= event.t;
        summary.lastSeen = event.t;
        if (!summary.latest || summary.latest.at <= event.usage.at) { summary.latest = event.usage; }
        if (event.active) { lastActive = event.account; }
        for (const window of event.usage.windows) {
          if (!Number.isFinite(window.usedPercent)) { continue; }
          const key = `${window.label}|${window.resetsAt ?? ''}`;
          const cycle = summary.cycles.get(key);
          const complete = window.resetsAt !== undefined && window.resetsAt <= untilIso;
          if (cycle) {
            cycle.peak = Math.max(cycle.peak, window.usedPercent);
            cycle.readings++;
            cycle.complete = complete;
          } else {
            summary.cycles.set(key, { peak: window.usedPercent, readings: 1, complete });
          }
        }
        break;
      }
      case 'switch':
        switches.total++;
        switches[event.reason]++;
        switchEvents.push(event);
        accountOf(event.to).switchedTo++;
        if (event.from) { accountOf(event.from).switchedFrom++; }
        calls += event.calls ?? 0;
        break;
      case 'sweep':
        sweeps.count++;
        sweeps.calls += event.calls;
        sweeps.byOutcome[event.outcome] = (sweeps.byOutcome[event.outcome] ?? 0) + 1;
        calls += event.calls;
        break;
      case 'exhausted':
        if (exhaustedSince === undefined) { exhausted.episodes++; exhaustedSince = event.t; }
        break;
      case 'recovered':
        if (exhaustedSince !== undefined) {
          const length = Date.parse(event.t) - Date.parse(exhaustedSince);
          exhausted.totalMs += length;
          exhausted.longestMs = Math.max(exhausted.longestMs, length);
          exhaustedSince = undefined;
        }
        break;
      case 'check':
        if (!event.ok) { accountOf(event.account).checkFailures++; }
        break;
      default:
        break;
    }
  }
  if (exhaustedSince !== undefined) {
    const length = Math.max(0, until - Date.parse(exhaustedSince));
    exhausted.totalMs += length;
    exhausted.longestMs = Math.max(exhausted.longestMs, length);
    exhausted.open = true;
  }
  // Time active: the account switched to holds the login until the next switch; before the first switch, the
  // account switched from did, and without any switch the account last read as active did, for the whole period.
  const periodStart = first ? Math.max(Date.parse(first), 0) : undefined;
  if (switchEvents.length) {
    const firstSwitch = Date.parse(switchEvents[0].t);
    if (switchEvents[0].from && periodStart !== undefined && periodStart < firstSwitch) {
      accountOf(switchEvents[0].from).activeMs += firstSwitch - periodStart;
    }
    switchEvents.forEach((event, index) => {
      const start = Date.parse(event.t);
      const end = index + 1 < switchEvents.length ? Date.parse(switchEvents[index + 1].t) : until;
      accountOf(event.to).activeMs += Math.max(0, end - start);
      if (index + 1 < switchEvents.length) { switches.stays.push(end - start); }
    });
  } else if (lastActive && periodStart !== undefined) {
    accountOf(lastActive).activeMs += Math.max(0, until - periodStart);
  }
  switches.medianStayMs = median(switches.stays);
  switches.recent = switchEvents.slice(-20).reverse();
  const summaries: AccountSummary[] = [...accounts.values()].map(({ cycles, ...summary }) => {
    const byLabel = new Map<string, Cycle[]>();
    for (const [key, cycle] of cycles) {
      const label = key.slice(0, key.indexOf('|'));
      byLabel.set(label, [...(byLabel.get(label) ?? []), cycle]);
    }
    const windows: WindowStats[] = [...byLabel.entries()].map(([label, list]) => {
      const kind = windowKind(label);
      const threshold = kind === 'short' ? thresholds.fiveHourThresholdPercent : thresholds.weeklyThresholdPercent;
      const complete = list.filter((cycle) => cycle.complete);
      return {
        label, kind, threshold, cycles: list.length, completeCycles: complete.length,
        meanPeak: complete.length ? complete.reduce((sum, cycle) => sum + cycle.peak, 0) / complete.length : undefined,
        atLimit: complete.filter((cycle) => cycle.peak >= threshold).length
      };
    }).sort((a, b) => a.label.localeCompare(b.label));
    return { ...summary, windows };
  }).sort((a, b) => b.activeMs - a.activeMs || b.readings - a.readings);
  return { provider, readings, first, last, accounts: summaries, switches, exhausted, sweeps, calls,
    estimate: estimateAccounts(summaries, exhausted) };
}

/**
 * How many accounts the observed weekly use would need: the accounts' average weekly peaks add up to the weekly
 * demand in account-weeks; with 15% headroom that many accounts are needed, and one more than were saved whenever
 * every account was at its limit at once. Weekly windows only: 5-hour bursts can still force switches.
 */
export function estimateAccounts(accounts: AccountSummary[], exhausted: ExhaustedStats): Estimate | undefined {
  const measured = accounts.flatMap((account) => {
    const weekly = account.windows.find((window) => window.kind === 'weekly' && window.meanPeak !== undefined);
    return weekly ? [{ account, weekly }] : [];
  });
  if (!measured.length) { return undefined; }
  const weeklyDemand = measured.reduce((sum, { weekly }) => sum + weekly.meanPeak! / 100, 0);
  let needed = Math.max(1, Math.ceil(weeklyDemand / HEADROOM));
  const notes: string[] = [];
  const cycles = measured.reduce((sum, { weekly }) => sum + weekly.completeCycles, 0);
  notes.push(`Based on ${cycles} complete weekly cycle${cycles === 1 ? '' : 's'} of ${measured.length} account${measured.length === 1 ? '' : 's'}: ` +
    `together they use ${weeklyDemand.toFixed(2)} account-weeks of allowance per week, and an account is counted as full at ${Math.round(HEADROOM * 100)}%.`);
  if (exhausted.episodes) {
    needed = Math.max(needed, accounts.length + 1);
    notes.push(`Every saved account was at its limit at once ${exhausted.episodes} time${exhausted.episodes === 1 ? '' : 's'}; ` +
      'one more account, or less use in those weeks, would have been needed then.');
  }
  if (measured.length < accounts.length) {
    notes.push(`${accounts.length - measured.length} account${accounts.length - measured.length === 1 ? '' : 's'} without a complete weekly cycle in the period ${accounts.length - measured.length === 1 ? 'is' : 'are'} not counted.`);
  }
  return { accounts: measured.length, weeklyDemand, needed, notes };
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) { return '?'; }
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) { return '<1m'; }
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  if (days) { return `${days}d${hours ? ` ${hours}h` : ''}`; }
  if (hours) { return `${hours}h${rest ? ` ${rest}m` : ''}`; }
  return `${rest}m`;
}

function formatTime(iso: string | number | undefined): string {
  if (iso === undefined) { return '—'; }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) { return '—'; }
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function percent(value: number | undefined): string {
  return value === undefined ? '—' : `${Math.round(value)}%`;
}

function usageCell(usage: HistoryUsage | undefined): string {
  return usage ? usage.windows.map((window) => `${window.label} ${Math.round(window.usedPercent)}%`).join(', ') : '—';
}

const TITLES: Record<AuthProvider, string> = { claude: 'Claude', codex: 'Codex' };
const REASONS: Record<SwitchEvent['reason'], string> = { limit: 'at its limit', proactive: 'proactive', manual: 'by hand', external: 'outside this window' };
const SWEEP_OUTCOMES: Record<string, string> = {
  activeRecovered: 'the active account had recovered', noBetterCandidate: 'no clearly better account', noCandidate: 'no account below its thresholds'
};

/** The summary as a Markdown document. `label` names the period ("the last 30 days"); `location` the files. */
export function renderHistoryReport(summary: HistorySummary, options: { label: string; location: string; files: number; retentionDays: number }): string {
  const lines: string[] = [];
  lines.push(`# AI Usage history · ${options.label}`, '');
  lines.push(`${formatTime(summary.since)} to ${formatTime(summary.until)}. Data: \`${options.location}\` ` +
    `(${options.files} month file${options.files === 1 ? '' : 's'}, kept for ${options.retentionDays} days).`, '');
  if (!summary.providers.length) {
    lines.push('No events in this period. Readings are recorded while the status bar or the account checks read a saved account; ' +
      'switches and rotation sweeps as they happen.', '');
    return lines.join('\n');
  }
  for (const provider of summary.providers) {
    const { switches, exhausted, sweeps } = provider;
    lines.push(`## ${TITLES[provider.provider] ?? provider.provider}`, '');
    lines.push(`- **Readings:** ${provider.readings}${provider.first ? ` from ${formatTime(provider.first)} to ${formatTime(provider.last)}` : ''}.`);
    const automatic = switches.limit + switches.proactive;
    lines.push(`- **Switches:** ${switches.total}` + (switches.total
      ? ` (automatic ${automatic}: ${switches.limit} at a limit, ${switches.proactive} proactive; by hand ${switches.manual}; outside this window ${switches.external}).` +
        (switches.medianStayMs !== undefined ? ` Median stay ${formatDuration(switches.medianStayMs)}.` : '')
      : '.'));
    lines.push(`- **Every account at its limit:** ${exhausted.episodes
      ? `${exhausted.episodes} time${exhausted.episodes === 1 ? '' : 's'}, ${formatDuration(exhausted.totalMs)} in total, longest ${formatDuration(exhausted.longestMs)}${exhausted.open ? ', still going' : ''}.`
      : 'never.'}`);
    lines.push(`- **Rotation sweeps that switched nothing:** ${sweeps.count}` + (sweeps.count
      ? ` (${Object.entries(sweeps.byOutcome).map(([outcome, count]) => `${count} ${SWEEP_OUTCOMES[outcome] ?? outcome}`).join(', ')}).`
      : '.') + ` Endpoint calls spent by rotation: ${provider.calls}.`);
    lines.push('');
    if (provider.accounts.length) {
      lines.push('| Account | Active | Weekly cycles | Weekly peak, mean | Weeks at the limit | 5h cycles at the limit | Readings | Last seen | Failed checks |');
      lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
      for (const account of provider.accounts) {
        const weekly = account.windows.find((window) => window.kind === 'weekly');
        const short = account.windows.find((window) => window.kind === 'short');
        const model = account.windows.filter((window) => window.kind === 'modelWeekly');
        const who = account.account.email ? `${account.account.name} (${account.account.email})` : account.account.name;
        const peak = weekly ? percent(weekly.meanPeak) + (model.length ? `; ${model.map((window) => `${window.label} ${percent(window.meanPeak)}`).join(', ')}` : '') : '—';
        lines.push(`| ${who} | ${formatDuration(account.activeMs)} | ${weekly ? `${weekly.completeCycles} of ${weekly.cycles}` : '—'} | ${peak} | ` +
          `${weekly ? `${weekly.atLimit} (≥ ${weekly.threshold}%)` : '—'} | ${short ? `${short.atLimit} of ${short.completeCycles} (≥ ${short.threshold}%)` : '—'} | ` +
          `${account.readings} | ${formatTime(account.lastSeen)} | ${account.checkFailures} |`);
      }
      lines.push('');
      lines.push('Cycles are counted per reset of the window; a cycle is complete once its reset has passed, and its peak is the ' +
        'highest usage read in it. Time active is measured between switches, whether or not VS Code was running.', '');
    }
    if (provider.estimate) {
      const { estimate } = provider;
      lines.push(`**Accounts needed, estimated: ${estimate.needed}** (${provider.accounts.length} saved).`, '');
      for (const note of estimate.notes) { lines.push(`- ${note}`); }
      lines.push('- Weekly windows only: when 5-hour cycles reach their limit often while weekly peaks stay low, bursts drive the switches, ' +
        'and a proactive strategy spreads use over accounts, so each one\'s peak understates what a single account would have used.', '');
    } else if (provider.readings) {
      lines.push('No complete weekly cycle yet, so the number of accounts needed cannot be estimated; the first estimate comes after a weekly reset.', '');
    }
    if (switches.recent.length) {
      lines.push(`### Recent switches${switches.total > switches.recent.length ? ` (last ${switches.recent.length} of ${switches.total})` : ''}`, '');
      lines.push('| When | From | To | Reason | From usage | To usage | Previous stay | Candidates |');
      lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
      for (const event of switches.recent) {
        const candidates = event.candidates?.filter((candidate) => candidate.outcome !== 'chosen')
          .map((candidate) => `${candidate.account.name}: ${candidate.outcome}`).join(', ');
        lines.push(`| ${formatTime(event.t)} | ${event.from?.name ?? '—'} | ${event.to.name} | ${REASONS[event.reason] ?? event.reason}` +
          `${event.settings ? ` (${event.settings.strategy})` : ''} | ${usageCell(event.fromUsage)} | ${usageCell(event.toUsage)} | ` +
          `${event.stayedMs === undefined ? '—' : formatDuration(event.stayedMs)} | ${candidates || '—'} |`);
      }
      lines.push('');
    }
  }
  return lines.join('\n');
}
