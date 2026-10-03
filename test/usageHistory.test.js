const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { UsageHistory, HEARTBEAT_MS, historyFileName, historyFileEnd, historyFileStart, readingsCsv, eventsCsv, usageSnapshot } = require('../out/usageHistory');

const DAY = 86400000;
const BASE = Date.UTC(2026, 9, 1, 12); // 2026-10-01T12:00:00Z
const RESETS = [new Date(BASE + 3 * 3600000), new Date(BASE + 5 * DAY)];
/** A Claude reading taken at `at` with fixed resets, so only the figures decide whether it changed. */
const usage = (percents, at, plan) => ({ provider: 'claude', title: 'Claude', ...(plan ? { plan } : {}), fetchedAt: new Date(at),
  windows: percents.map((usedPercent, i) => ({ label: i ? '7d' : '5h', usedPercent, resetsAt: RESETS[i] })) });
const A = { id: 'a', name: 'Claude 1', email: 'one@example.com' };
const B = { id: 'b', name: 'Claude, 2' };

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-history-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, 'history');
  let now = BASE;
  const messages = [];
  const make = () => new UsageHistory(directory, { enabled: true, retentionMs: 365 * DAY, ...options }, m => messages.push(m), () => now);
  const history = make();
  return { history, make, directory, messages, events: () => [...history.events()],
    advance: ms => { now += ms; }, set: at => { now = at; }, at: () => now };
}

test('a reading is recorded when it changes, once an hour otherwise, and never when older than the recorded one', t => {
  const f = fixture(t);
  assert.equal(f.history.reading('claude', A, usage([10, 20], f.at()), 'status', true), true);
  assert.equal(f.history.reading('claude', A, usage([10, 20], f.at()), 'status', true), false);
  f.advance(60000);
  // A newer reading with the same figures (the account file read again) adds nothing.
  assert.equal(f.history.reading('claude', A, usage([10, 20], f.at()), 'status', true), false);
  assert.equal(f.history.reading('claude', A, usage([11, 20], f.at()), 'keepAlive', false), true);
  // An older reading than the recorded one is stale, whatever it says.
  assert.equal(f.history.reading('claude', A, usage([50, 50], f.at() - 120000), 'check', true), false);
  f.advance(HEARTBEAT_MS);
  assert.equal(f.history.reading('claude', A, usage([11, 20], f.at()), 'status', true), true);
  // A plan change is a change; another account is tracked on its own.
  assert.equal(f.history.reading('claude', A, usage([11, 20], f.at(), 'max'), 'status', true), true);
  assert.equal(f.history.reading('claude', B, usage([11, 20], f.at()), 'status', false), true);
  const events = f.events();
  assert.deepEqual(events.map(e => [e.type, e.account.id, e.active, e.source, e.usage.windows[0].usedPercent]), [
    ['reading', 'a', true, 'status', 10], ['reading', 'a', false, 'keepAlive', 11], ['reading', 'a', true, 'status', 11],
    ['reading', 'a', true, 'status', 11], ['reading', 'b', false, 'status', 11]]);
  assert.deepEqual(events[0].account, A);
  assert.equal(events[0].t, new Date(BASE).toISOString());
  assert.deepEqual(events[0].usage, { at: new Date(BASE).toISOString(), windows: [
    { label: '5h', usedPercent: 10, resetsAt: RESETS[0].toISOString() }, { label: '7d', usedPercent: 20, resetsAt: RESETS[1].toISOString() }] });
  assert.equal(events[3].usage.plan, 'max');
  // Every window on the host appends to the same files and shares the index, so another instance records nothing new.
  const other = f.make();
  assert.equal(other.reading('claude', A, usage([11, 20], f.at(), 'max'), 'status', true), false);
});

test('nothing is written while the history is off', t => {
  const f = fixture(t, { enabled: false });
  assert.equal(f.history.reading('claude', A, usage([10, 20], f.at()), 'status', true), false);
  assert.equal(f.history.record({ type: 'switch', provider: 'claude', to: A, reason: 'manual', automatic: false }), false);
  assert.equal(fs.existsSync(f.directory), false);
  assert.deepEqual(f.history.files(), []);
  assert.deepEqual(f.events(), []);
  f.history.configure(f.directory, { enabled: true, retentionMs: DAY });
  assert.equal(f.history.record({ type: 'switch', provider: 'claude', to: A, reason: 'manual', automatic: false }), true);
  assert.equal(f.history.retentionMs, DAY);
  assert.equal(f.history.enabled, true);
});

test('events go to one file per month, and files older than the retention are deleted once a day', t => {
  const f = fixture(t);
  f.history.record({ type: 'recovered', provider: 'claude', active: A, by: 'reset', afterMs: 5 });
  f.set(Date.UTC(2026, 10, 15));
  f.history.record({ type: 'recovered', provider: 'claude', active: A, by: 'reset', afterMs: 6 });
  assert.deepEqual(f.history.files().map(file => path.basename(file)), ['history-2026-10.jsonl', 'history-2026-11.jsonl']);
  assert.equal(historyFileName(BASE), 'history-2026-10.jsonl');
  assert.equal(historyFileStart('history-2026-10.jsonl'), Date.UTC(2026, 9, 1));
  assert.equal(historyFileEnd('history-2026-10.jsonl'), Date.UTC(2026, 10, 1));
  assert.equal(historyFileEnd('index.json'), undefined);
  // 2026-10 ended on 2026-11-01; it is kept until a whole year has passed since then.
  f.set(Date.UTC(2027, 9, 2));
  assert.deepEqual(f.history.prune(), []);
  f.set(Date.UTC(2027, 10, 2));
  assert.deepEqual(f.history.prune().map(file => path.basename(file)), ['history-2026-10.jsonl']);
  assert.match(f.messages.at(-1), /deleted 1 file\(s\) older than 365 days/);
  // pruneIfDue runs once a day: an old file that appears in between waits for the next day.
  fs.writeFileSync(path.join(f.directory, 'history-2025-01.jsonl'), '');
  f.advance(3600000);
  f.history.pruneIfDue();
  assert.equal(fs.existsSync(path.join(f.directory, 'history-2025-01.jsonl')), true);
  f.advance(24 * 3600000);
  f.history.pruneIfDue();
  assert.equal(fs.existsSync(path.join(f.directory, 'history-2025-01.jsonl')), false);
  assert.deepEqual(f.events().map(e => e.afterMs), [6]);
});

test('events() reads across files from a point in time and skips lines it cannot parse', t => {
  const f = fixture(t);
  f.history.record({ type: 'recovered', provider: 'claude', active: A, by: 'reset', afterMs: 1 });
  f.advance(DAY);
  f.history.record({ type: 'recovered', provider: 'claude', active: A, by: 'reset', afterMs: 2 });
  fs.appendFileSync(path.join(f.directory, historyFileName(f.at())), 'not json\n{"t":1}\n\n');
  f.set(Date.UTC(2026, 10, 3));
  f.history.record({ type: 'recovered', provider: 'claude', active: A, by: 'reset', afterMs: 3 });
  assert.deepEqual(f.events().map(e => e.afterMs), [1, 2, 3]);
  assert.deepEqual([...f.history.events(BASE + DAY)].map(e => e.afterMs), [2, 3]);
  assert.deepEqual([...f.history.events(Date.UTC(2026, 10, 1))].map(e => e.afterMs), [3]);
});

test('a switch followed from outside this window is the switch another window recorded moments ago', t => {
  const f = fixture(t);
  assert.equal(f.history.record({ type: 'switch', provider: 'claude', from: A, to: B, reason: 'manual', automatic: false }), true);
  const other = f.make();
  assert.equal(other.record({ type: 'switch', provider: 'claude', from: A, to: B, reason: 'external', automatic: false }), false);
  // A different account, or the same one later, is a switch of its own; Codex is tracked apart from Claude.
  assert.equal(other.record({ type: 'switch', provider: 'claude', from: B, to: A, reason: 'external', automatic: false }), true);
  f.advance(3 * 60000);
  assert.equal(other.record({ type: 'switch', provider: 'claude', from: B, to: A, reason: 'external', automatic: false }), true);
  assert.equal(other.record({ type: 'switch', provider: 'codex', from: B, to: A, reason: 'external', automatic: false }), true);
  assert.deepEqual(f.events().map(e => [e.provider, e.reason, e.to.id]),
    [['claude', 'manual', 'b'], ['claude', 'external', 'a'], ['claude', 'external', 'a'], ['codex', 'external', 'a']]);
});

test('a directory that cannot be written is reported once', t => {
  const f = fixture(t);
  fs.writeFileSync(f.directory, 'in the way');
  assert.equal(f.history.reading('claude', A, usage([1, 1], f.at()), 'status', true), false);
  assert.equal(f.history.record({ type: 'recovered', provider: 'claude', active: A, by: 'reset' }), false);
  assert.equal(f.messages.filter(m => /could not write/.test(m)).length, 1);
});

test('CSV exports: one row per reading and window, one per other event, with quoting', t => {
  const f = fixture(t);
  const at = new Date(BASE).toISOString();
  f.history.reading('claude', B, usage([10, 20], f.at(), 'max'), 'status', true);
  f.history.record({ type: 'switch', provider: 'claude', from: A, to: B, reason: 'limit', automatic: true, stayedMs: 90 * 60000,
    fromUsage: usageSnapshot(usage([99.5, 20], f.at())), toUsage: usageSnapshot(usage([10, 20], f.at())), calls: 2,
    settings: { strategy: 'soonestReset', trigger: 'limit', fiveHourThresholdPercent: 95, weeklyThresholdPercent: 99.5 },
    candidates: [{ account: A, usable: false, outcome: 'ineligible' }, { account: B, usable: true, outcome: 'chosen' }] });
  f.history.record({ type: 'check', provider: 'claude', account: A, ok: false, keepAlive: true, error: 'exit 1', problem: 'Insufficient credits' });
  const readings = readingsCsv(f.events()).split('\n');
  assert.equal(readings[0], 'time,provider,account,email,active,source,read_at,plan,window,used_percent,resets_at');
  assert.equal(readings[1], `${at},claude,"Claude, 2",,true,status,${at},max,5h,10,${RESETS[0].toISOString()}`);
  assert.equal(readings[2], `${at},claude,"Claude, 2",,true,status,${at},max,7d,20,${RESETS[1].toISOString()}`);
  assert.deepEqual(readings.slice(3), ['']);
  const events = eventsCsv(f.events()).split('\n');
  assert.equal(events[0], 'time,provider,type,reason,from,to,stayed_minutes,from_usage,to_usage,calls,strategy,trigger,detail');
  assert.equal(events[1], `${at},claude,switch,limit,Claude 1,"Claude, 2",90,5h 99.5% 7d 20%,5h 10% 7d 20%,2,soonestReset,limit,"Claude 1: ineligible; Claude, 2: chosen"`);
  assert.equal(events[2], `${at},claude,check,keep-alive failed,Claude 1,,,,,,,,Insufficient credits`);
  assert.deepEqual(events.slice(3), ['']);
});
