const assert = require('node:assert/strict');
const test = require('node:test');
const { summarizeHistory, renderHistoryReport, estimateAccounts, formatDuration } = require('../out/usageHistoryReport');

const DAY = 86400000, HOUR = 3600000;
const T0 = Date.UTC(2026, 9, 1);
const iso = ms => new Date(ms).toISOString();
const A = { id: 'a', name: 'A' }, B = { id: 'b', name: 'B', email: 'b@example.com' };
const R1 = iso(T0 + 2 * DAY), R2 = iso(T0 + 9 * DAY);
const w = (label, usedPercent, resetsAt) => ({ label, usedPercent, ...(resetsAt ? { resetsAt } : {}) });
const reading = (t, account, active, windows, provider = 'claude') =>
  ({ t: iso(t), type: 'reading', provider, account, active, source: 'status', usage: { at: iso(t), windows } });
const THRESHOLDS = { claude: { fiveHourThresholdPercent: 95, weeklyThresholdPercent: 99 } };
const stats = (account, windows) => ({ account, readings: 1, activeMs: 0, windows, switchedTo: 0, switchedFrom: 0, checkFailures: 0 });
const weekly = (cycles, completeCycles, meanPeak) => ({ label: '7d', kind: 'weekly', cycles, completeCycles, ...(meanPeak === undefined ? {} : { meanPeak }), atLimit: 0, threshold: 99 });
const NEVER_EXHAUSTED = { episodes: 0, totalMs: 0, longestMs: 0, open: false };

function sample() {
  return [
    reading(T0, A, true, [w('5h', 20, iso(T0 + 5 * HOUR)), w('7d', 50, R1)]),
    reading(T0 + 4 * HOUR, A, true, [w('5h', 96, iso(T0 + 5 * HOUR)), w('7d', 90, R1)]),
    reading(T0 + 6 * HOUR, A, true, [w('5h', 10, iso(T0 + 11 * HOUR)), w('7d', 99.5, R1)]),
    reading(T0 + 3 * DAY, A, false, [w('5h', 0, iso(T0 + 3 * DAY + 5 * HOUR)), w('7d', 30, R2)]),
    reading(T0 + DAY, B, false, [w('7d', 40, R1)]),
    { t: iso(T0 + DAY), type: 'switch', provider: 'claude', from: A, to: B, reason: 'manual', automatic: false },
    { t: iso(T0 + 2 * DAY), type: 'switch', provider: 'claude', from: B, to: A, reason: 'limit', automatic: true, stayedMs: DAY, calls: 3,
      settings: { strategy: 'soonestReset', trigger: 'limit', fiveHourThresholdPercent: 95, weeklyThresholdPercent: 99 },
      candidates: [{ account: A, usable: true, outcome: 'chosen' }] },
    { t: iso(T0 + 3 * DAY), type: 'switch', provider: 'claude', from: A, to: B, reason: 'external', automatic: false },
    { t: iso(T0 + 4 * DAY), type: 'exhausted', provider: 'claude', active: B, usage: { at: iso(T0 + 4 * DAY), windows: [w('7d', 99.5, R2)] },
      reached: [{ label: '7d', usedPercent: 99.5, threshold: 99 }] },
    { t: iso(T0 + 4 * DAY + 3 * HOUR), type: 'recovered', provider: 'claude', active: B, by: 'reset', afterMs: 3 * HOUR },
    { t: iso(T0 + 5 * DAY), type: 'sweep', provider: 'claude', active: B, outcome: 'noBetterCandidate', calls: 2 },
    { t: iso(T0 + 5 * DAY), type: 'check', provider: 'claude', account: B, ok: false, keepAlive: true, error: 'x', problem: 'Insufficient credits' },
    { t: iso(T0 + 5 * DAY + HOUR), type: 'check', provider: 'claude', account: B, ok: true, keepAlive: true },
    reading(T0 + 5 * DAY, A, true, [w('5h', 5)], 'codex'),
    // After the period: ignored.
    { t: iso(T0 + 10 * DAY), type: 'switch', provider: 'claude', from: A, to: B, reason: 'manual', automatic: false }
  ];
}

test('the summary counts readings, switches, exhausted time and per-account weekly cycles', () => {
  const summary = summarizeHistory(sample(), { since: T0, until: T0 + 6 * DAY, thresholds: THRESHOLDS });
  assert.deepEqual(summary.providers.map(p => p.provider), ['claude', 'codex']);
  const claude = summary.providers[0];
  assert.equal(claude.readings, 5);
  assert.deepEqual([claude.first, claude.last], [iso(T0), iso(T0 + 3 * DAY)]);
  const { switches } = claude;
  assert.deepEqual([switches.total, switches.limit, switches.proactive, switches.manual, switches.external], [3, 1, 0, 1, 1]);
  assert.deepEqual(switches.stays, [DAY, DAY]);
  assert.equal(switches.medianStayMs, DAY);
  assert.deepEqual(switches.recent.map(e => e.reason), ['external', 'limit', 'manual']);
  assert.deepEqual(claude.exhausted, { episodes: 1, totalMs: 3 * HOUR, longestMs: 3 * HOUR, open: false });
  assert.deepEqual(claude.sweeps, { count: 1, calls: 2, byOutcome: { noBetterCandidate: 1 } });
  assert.equal(claude.calls, 5);
  // B held the login longest: from the manual switch to the rotation, and from the external switch to the end.
  assert.deepEqual(claude.accounts.map(a => [a.account.id, a.activeMs / DAY]), [['b', 4], ['a', 2]]);
  const [b, a] = claude.accounts;
  assert.deepEqual([a.readings, a.switchedTo, a.switchedFrom, a.checkFailures], [4, 1, 2, 0]);
  assert.deepEqual([b.readings, b.switchedTo, b.switchedFrom, b.checkFailures], [1, 2, 1, 1]);
  assert.equal(b.account.email, 'b@example.com');
  // The first week's peak is final because its reset passed; the second week is still running.
  assert.deepEqual(a.windows.find(x => x.label === '7d'), { label: '7d', kind: 'weekly', threshold: 99, cycles: 2, completeCycles: 1, meanPeak: 99.5, atLimit: 1 });
  const short = a.windows.find(x => x.label === '5h');
  assert.deepEqual([short.cycles, short.completeCycles, short.atLimit, short.meanPeak], [3, 3, 1, (96 + 10 + 0) / 3]);
  assert.deepEqual(b.windows.find(x => x.label === '7d'), { label: '7d', kind: 'weekly', threshold: 99, cycles: 1, completeCycles: 1, meanPeak: 40, atLimit: 0 });
  // 1.395 account-weeks per week take 2 accounts at 85%, but every account was at its limit once: one more than saved.
  assert.deepEqual([claude.estimate.accounts, claude.estimate.needed, Math.round(claude.estimate.weeklyDemand * 1000)], [2, 3, 1395]);
  // Codex: a single active reading and no switch, so that account held the login for the rest of the period.
  const codex = summary.providers[1];
  assert.equal(codex.estimate, undefined);
  assert.equal(codex.accounts[0].activeMs, DAY);
  assert.deepEqual(codex.accounts[0].windows, [{ label: '5h', kind: 'short', threshold: 95, cycles: 1, completeCycles: 0, meanPeak: undefined, atLimit: 0 }]);
});

test('an exhausted stretch without a recovery runs to the end of the period', () => {
  const events = [{ t: iso(T0), type: 'exhausted', provider: 'codex', active: A, usage: { at: iso(T0), windows: [] }, reached: [] }];
  const summary = summarizeHistory(events, { since: T0, until: T0 + 2 * HOUR });
  assert.deepEqual(summary.providers[0].exhausted, { episodes: 1, totalMs: 2 * HOUR, longestMs: 2 * HOUR, open: true });
});

test('the estimate needs a complete weekly cycle and leaves out accounts without one', () => {
  assert.equal(estimateAccounts([stats(A, [weekly(1, 0)])], NEVER_EXHAUSTED), undefined);
  const estimate = estimateAccounts([stats(A, [weekly(2, 2, 30)]), stats(B, [weekly(2, 2, 20)]), stats({ id: 'c', name: 'C' }, [])], NEVER_EXHAUSTED);
  // Half an account-week per week fits in one account.
  assert.deepEqual([estimate.accounts, estimate.needed], [2, 1]);
  assert.match(estimate.notes[0], /4 complete weekly cycles of 2 accounts.*0\.50 account-weeks/);
  assert.match(estimate.notes[1], /1 account without a complete weekly cycle/);
  assert.equal(estimate.notes.length, 2);
});

test('the report renders the figures and says when there is nothing to show', () => {
  const empty = renderHistoryReport({ since: T0, until: T0 + DAY, providers: [] }, { label: 'the last 7 days', location: '/tmp/h', files: 0, retentionDays: 365 });
  assert.match(empty, /^# AI Usage history · the last 7 days/);
  assert.match(empty, /No events in this period/);
  const summary = summarizeHistory(sample(), { since: T0, until: T0 + 6 * DAY, thresholds: THRESHOLDS });
  const report = renderHistoryReport(summary, { label: 'everything kept', location: '/tmp/h', files: 1, retentionDays: 365 });
  assert.match(report, /## Claude/);
  assert.match(report, /\*\*Switches:\*\* 3 \(automatic 1: 1 at a limit, 0 proactive; by hand 1; outside this window 1\)\. Median stay 1d\./);
  assert.match(report, /\*\*Every account at its limit:\*\* 1 time, 3h in total, longest 3h\./);
  assert.match(report, /\*\*Rotation sweeps that switched nothing:\*\* 1 \(1 no clearly better account\)\. Endpoint calls spent by rotation: 5\./);
  assert.match(report, /\| B \(b@example\.com\) \| 4d \| 1 of 1 \| 40% \| 0 \(≥ 99%\) \| — \| 1 \| /);
  assert.match(report, /\| A \| 2d \| 1 of 2 \| 100% \| 1 \(≥ 99%\) \| 1 of 3 \(≥ 95%\) \| 4 \| /);
  assert.match(report, /\*\*Accounts needed, estimated: 3\*\* \(2 saved\)/);
  assert.match(report, /### Recent switches/);
  assert.match(report, /\| B \| A \| at its limit \(soonestReset\) \| — \| — \| 1d \| — \|/);
  assert.match(report, /## Codex/);
  assert.match(report, /No complete weekly cycle yet/);
});

test('durations read as days, hours and minutes', () => {
  assert.deepEqual([0, 30000, 5 * 60000, 125 * 60000, 26 * HOUR, 49 * HOUR + 30 * 60000, 2 * DAY].map(formatDuration),
    ['<1m', '1m', '5m', '2h 5m', '1d 2h', '2d 1h', '2d']);
});
