const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { UsageMonitor, serializeUsageState, deserializeUsageState } = require('../out/usageMonitor');
const { defaultConfig } = require('../out/configStore');
const { ApiCallBudget } = require('../out/apiBudget');
function fixture(t, fetch) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-monitor-'));
  let time = Date.now(), identity = 'a'; const calls = [], observations = [];
  const config = defaultConfig(); config.claude.source = 'api'; config.codex.source = 'api';
  for (const provider of ['claude', 'codex', 'copilot']) config[provider].checkIntervalMinutes = 10;
  const reading = (provider, percent = 20, reset = time + 3600000) => ({ kind: 'ok', usage: { provider, title: provider, fetchedAt: new Date(time), windows: [{ label: '5h', usedPercent: percent, resetsAt: new Date(reset) }] } });
  const monitor = new UsageMonitor({ directory, config: () => config, now: () => time, identity: () => identity,
    budget: new ApiCallBudget(path.join(directory, 'budget'), () => 30000), log() {},
    fetch: async (...args) => { calls.push(args); return fetch ? fetch(...args, reading) : reading(args[0]); },
    observe: async (...args) => observations.push(args) });
  t.after(() => { monitor.dispose(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { monitor, config, calls, observations, reading, advance: ms => time += ms, identity: value => identity = value };
}
for (const provider of ['claude', 'codex', 'copilot']) test(`${provider}: concurrent clients share one fetch and refresh interval`, async t => {
  let release; const wait = new Promise(resolve => release = resolve);
  const f = fixture(t, async (provider, context, known, reading) => { await wait; return reading(provider); });
  const first = f.monitor.read(provider), second = f.monitor.read(provider, true); release();
  const [a,b] = await Promise.all([first, second]); assert.deepEqual(a,b); assert.equal(f.calls.length, 1);
  await f.monitor.read(provider); assert.equal(f.calls.length, 1);
  f.advance(11 * 60000); await f.monitor.read(provider); assert.equal(f.calls.length, 2);
});
test('a switch during a fetch discards the old account and never observes it', async t => {
  let release; const wait = new Promise(resolve => release = resolve);
  const f = fixture(t, async (provider, context, known, reading) => { await wait; return reading(provider); });
  const pending = f.monitor.read('codex'); f.identity('b'); release();
  assert.equal((await pending).result.kind, 'unavailable'); assert.equal(f.observations.length, 0);
  assert.equal((await f.monitor.read('codex')).result.kind, 'ok'); assert.equal(f.calls.length, 2);
});
test('source changes during a read discard it; disabled providers do not fetch', async t => {
  let release; const wait = new Promise(resolve => release = resolve);
  const f = fixture(t, async (provider, context, known, reading) => { await wait; return reading(provider); });
  const pending = f.monitor.read('codex'); f.config.codex.source = 'cli'; release();
  assert.equal((await pending).result.kind, 'unavailable');
  f.config.codex.enabled = false; await f.monitor.read('codex', true); assert.equal(f.calls.length, 1);
});
test('transient failure keeps the last good reading and manual refresh respects shared backoff', async t => {
  let fail = false;
  const f = fixture(t, async (provider, context, known, reading) => fail ? { kind: 'error', provider, title: provider, message: '429', transient: true, retryAfterMs: 120000 } : reading(provider));
  await f.monitor.read('codex'); fail = true;
  const failure = await f.monitor.read('codex', true); assert.equal(failure.lastGood.windows[0].usedPercent, 20);
  await f.monitor.read('codex', true); assert.equal(f.calls.length, 2);
  f.advance(120001); await f.monitor.read('codex', true); assert.equal(f.calls.length, 3);
});
test('known quota reset refreshes ahead of the normal interval and expired data is not reused', async t => {
  let first = true;
  const f = fixture(t, async (provider, context, known, reading) => {
    const result = reading(provider, first ? 100 : 0); if (first) result.usage.windows[0].resetsAt = new Date(result.usage.fetchedAt.getTime() + 10000);
    first = false; return result;
  });
  await f.monitor.read('codex'); f.advance(11001);
  const next = await f.monitor.read('codex'); assert.equal(next.result.usage.windows[0].usedPercent, 0); assert.equal(f.calls.length, 2);
});
test('session-log results are hints; API results are attributable, and wire dates round-trip', async t => {
  const f = fixture(t); f.config.codex.source = 'sessionLog';
  const state = await f.monitor.read('codex'); assert.equal(f.observations[0][2], false);
  f.config.codex.source = 'api'; await f.monitor.read('codex'); assert.equal(f.observations[1][2], true);
  assert.deepEqual(deserializeUsageState(serializeUsageState(state)), state);
});
test('Copilot account and workspace contexts cannot reuse another window’s quota', async t => {
  const f = fixture(t, async (provider, context, known, reading) => reading(provider, context.workspaceOwners[0] === 'a' ? 10 : 90));
  const a = { accounts: [{ login: 'first', token: 'secret-a' }], workspaceOwners: ['a'] };
  const b = { accounts: [{ login: 'second', token: 'secret-b' }], workspaceOwners: ['b'] };
  assert.equal((await f.monitor.read('copilot', false, a)).result.usage.windows[0].usedPercent, 10);
  assert.equal((await f.monitor.read('copilot', false, b)).result.usage.windows[0].usedPercent, 90);
  assert.equal((await f.monitor.read('copilot', false, a)).result.usage.windows[0].usedPercent, 10);
  assert.equal(f.calls.length, 2);
});
