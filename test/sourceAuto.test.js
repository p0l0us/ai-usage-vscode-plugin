require('./helpers/fixtureNetwork');
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { fetchAutoUsage, isFreshUsage } = require('../service/out/live');
const { UsageMonitor, usageSettings } = require('../service/out/usageMonitor');
const { ApiCallBudget } = require('../service/out/apiBudget');
const { defaultConfig } = require('../service/out/configStore');
const { isolateHomes } = require('./helpers/runtimeHost');
const now = 1800000000000;
const intervalMs = 30 * 60000;
const reading = (provider, age = 0) => ({ kind: 'ok', usage: { provider, title: provider,
  fetchedAt: new Date(now - age), windows: [{ label: '5h', usedPercent: 20, resetsAt: new Date(now + intervalMs) }] } });
const missing = provider => ({ kind: 'unavailable', provider });
const ledger = (blocked = false) => ({ nextAllowedAt: () => blocked ? now + intervalMs : 0, reserve: () => !blocked });
function options(provider, responses, calls = []) {
  return { provider, intervalMs, now: () => now, apiSpacing: ledger(), cliSpacing: ledger(),
    ...Object.fromEntries(['local', 'api', 'cli'].map(source => [source, async () => { calls.push(source); const value = responses[source]; if (value instanceof Error) throw value; return value || missing(provider); }])) };
}
for (const provider of ['claude', 'codex']) {
  test(`${provider}: auto retains fresh cache and local timestamps without network`, async () => {
    const calls = []; const local = reading(provider, 1000);
    const cached = await fetchAutoUsage({ ...options(provider, { local }, calls), known: local.usage });
    assert.equal(cached.usage, local.usage); assert.deepEqual(calls, ['local']); calls.length = 0;
    const result = await fetchAutoUsage(options(provider, { local, api: reading(provider) }, calls));
    assert.deepEqual(calls, ['local']); assert.equal(result.usage.fetchedAt, local.usage.fetchedAt);
    assert.equal(result.usage.source, provider === 'claude' ? 'accountFile' : 'sessionLog');
  });
  test(`${provider}: a fresh known reading still follows newer local readings but never calls an endpoint`, async () => {
    const known = reading(provider, 60000).usage;
    for (const local of [reading(provider, 1000), missing(provider), reading(provider, 120000), new Error('fixture read failure')]) {
      const calls = [];
      const result = await fetchAutoUsage({ ...options(provider, { local, api: reading(provider), cli: reading(provider) }, calls), known });
      assert.deepEqual(calls, ['local']); assert.equal(result.kind, 'ok');
      assert.equal(result.usage.fetchedAt, local.kind === 'ok' && local.usage.fetchedAt > known.fetchedAt ? local.usage.fetchedAt : known.fetchedAt);
    }
  });
  test(`${provider}: unavailable, failed, stale and invalid sources fall through in cost order`, async () => {
    for (const local of [missing(provider), new Error('fixture read failure'), reading(provider, intervalMs),
      reading(provider, -1), { ...reading(provider), usage: { ...reading(provider).usage, windows: [] } }]) {
      const calls = [];
      const result = await fetchAutoUsage(options(provider, { local, api: missing(provider), cli: reading(provider) }, calls));
      assert.deepEqual(calls, ['local', 'api', 'cli']); assert.equal(result.kind, 'ok'); assert.equal(result.usage.source, 'cli');
    }
    const calls = []; const result = await fetchAutoUsage(options(provider, { local: missing(provider), api: reading(provider) }, calls));
    assert.deepEqual(calls, ['local', 'api']); assert.equal(result.usage.source, 'api');
  });
  test(`${provider}: 429, Retry-After and shared budget stop redundant endpoint transports`, async () => {
    for (const rateError of [{ status: 429 }, { retryAfterMs: 1000 }]) {
      const calls = []; const error = { kind: 'error', provider, title: provider, message: 'slow down', transient: true, ...rateError };
      assert.equal(await fetchAutoUsage(options(provider, { api: error, cli: reading(provider) }, calls)), error);
      assert.deepEqual(calls, ['local', 'api']);
    }
    const calls = []; const result = await fetchAutoUsage({ ...options(provider, { api: reading(provider), cli: reading(provider) }, calls), budget: ledger(true) });
    assert.equal(result.kind, 'unavailable'); assert.deepEqual(calls, ['local']);
  });
}
test('auto freshness rejects invalid, expired, foreign and out-of-range quota readings', () => {
  const good = reading('codex').usage;
  for (const usage of [{ ...good, fetchedAt: new Date(NaN) }, { ...good, provider: 'claude' },
    { ...good, windows: [{ usedPercent: 20, resetsAt: new Date(now) }] },
    { ...good, windows: [{ usedPercent: NaN }] }, { ...good, windows: [{ usedPercent: 101 }] }]) {
    assert.equal(isFreshUsage(usage, 'codex', intervalMs, now), false);
  }
});
test('monitor auto respects minute policy, deduplicates and preserves conservative Codex attribution', async t => {
  const f = isolateHomes(t); const config = defaultConfig(); config.codex.source = config.claude.source = 'auto';
  config.codex.checkIntervalMinutes = config.claude.checkIntervalMinutes = 30;
  config.claude.accountFile.checkIntervalSeconds = 5;
  assert.equal(usageSettings(config, 'claude').checkIntervalMs, 5000);
  assert.equal(usageSettings(config, 'claude').apiCheckIntervalMs, intervalMs);
  assert.equal(usageSettings(config, 'codex').checkIntervalMs, intervalMs);
  const observed = []; let source = 'sessionLog'; let reads = 0;
  const monitor = new UsageMonitor({ directory: f.home, config: () => config,
    budget: new ApiCallBudget(path.join(f.home, 'budget.json'), () => 0, () => now), now: () => now,
    identity: () => 'synthetic-account', log: () => {}, fetch: async provider => { reads++; await Promise.resolve(); return { ...reading(provider), usage: { ...reading(provider).usage, source } }; },
    observe: async (provider, usage, attributable) => observed.push(attributable) });
  t.after(() => monitor.dispose());
  await Promise.all([monitor.read('codex', true), monitor.read('codex', true)]);
  assert.equal(reads, 1); assert.deepEqual(observed, [false]);
  source = 'api'; await monitor.read('codex', true); assert.deepEqual(observed, [false, true]);
  source = undefined; await monitor.read('codex', true); assert.deepEqual(observed, [false, true, false]);
});
test('monitor cannot publish an old account after its locked provider reading completes', async t => {
  const f = isolateHomes(t); const config = defaultConfig(); config.codex.source = 'auto'; let identity = 'account-a'; let complete;
  const monitor = new UsageMonitor({ directory: f.home, config: () => config,
    budget: new ApiCallBudget(path.join(f.home, 'budget.json'), () => 0), now: () => now,
    identity: () => identity, log: () => {}, fetch: () => new Promise(resolve => { complete = resolve; }) });
  t.after(() => monitor.dispose()); const pending = monitor.read('codex', true); identity = 'account-b'; complete(reading('codex'));
  assert.equal((await pending).result.kind, 'unavailable');
});
test('auto uses completion clock for API and CLI fresh timestamps', async () => {
  for (const successful of ['api', 'cli']) {
    let clock = now;
    const opts = options('codex', {}); opts.now = () => clock;
    opts[successful] = async () => { clock += 1000; return { ...reading('codex'), usage: { ...reading('codex').usage, fetchedAt: new Date(clock) } }; };
    const result = await fetchAutoUsage(opts); assert.equal(result.kind, 'ok'); assert.equal(result.usage.fetchedAt.getTime(), clock);
  }
});
test('monitor expires nearly old local readings and accepts readings completed after request start', async t => {
  const f = isolateHomes(t); const config = defaultConfig(); config.codex.source = 'auto'; config.codex.checkIntervalMinutes = 30;
  let clock = now; let reads = 0;
  const monitor = new UsageMonitor({ directory: f.home, config: () => config,
    budget: new ApiCallBudget(path.join(f.home, 'budget.json'), () => 0), now: () => clock,
    identity: () => 'synthetic', log: () => {}, fetch: async () => {
      reads++; if (reads === 1) return reading('codex', 29 * 60000);
      clock += 1000; return { ...reading('codex'), usage: { ...reading('codex').usage, fetchedAt: new Date(clock) } };
    } });
  t.after(() => monitor.dispose()); assert.equal((await monitor.read('codex')).result.kind, 'ok');
  clock += 2 * 60000;
  assert.equal((await monitor.read('codex')).result.kind, 'ok'); assert.equal(reads, 2);
});
test('monitor auto rereads the Claude account file within seconds and publishes only newer readings', async t => {
  const f = isolateHomes(t); const config = defaultConfig(); config.claude.source = 'auto'; config.claude.checkIntervalMinutes = 30;
  config.claude.accountFile.checkIntervalSeconds = 15;
  let clock = now; let reads = 0; let next = reading('claude'); const observed = [];
  const monitor = new UsageMonitor({ directory: f.home, config: () => config,
    budget: new ApiCallBudget(path.join(f.home, 'budget.json'), () => 0, () => clock), now: () => clock,
    identity: () => 'synthetic', log: () => {}, fetch: async (provider, context, known) => { reads++; return next.kind === 'ok' && known && next.usage.fetchedAt <= known.fetchedAt ? { kind: 'ok', usage: known } : next; },
    observe: async (provider, usage) => observed.push(usage.windows[0].usedPercent) });
  t.after(() => monitor.dispose());
  await monitor.read('claude'); assert.deepEqual(observed, [20]);
  clock += 10000; await monitor.read('claude'); assert.equal(reads, 1);
  clock += 6000; await monitor.read('claude'); assert.equal(reads, 2); assert.deepEqual(observed, [20]);
  clock += 15000; next = { kind: 'ok', usage: { ...reading('claude').usage, fetchedAt: new Date(clock), windows: [{ label: '5h', usedPercent: 96, resetsAt: new Date(now + intervalMs) }] } };
  const state = await monitor.read('claude'); assert.equal(reads, 3); assert.deepEqual(observed, [20, 96]);
  assert.equal(state.result.usage.windows[0].usedPercent, 96);
});
