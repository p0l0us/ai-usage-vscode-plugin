const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AccountAutomation, atLimit, eligibleAccount } = require('../out/accountAutomation');

const usage = (provider, percents, now) => ({ provider, title: provider, fetchedAt: new Date(now),
  windows: percents.map((usedPercent, i) => ({ label: i ? '7d' : '5h', usedPercent, resetsAt: new Date(now + 86400000) })) });

function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-automation-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let now = Date.now();
  const active = { claude: 'a', codex: 'a' };
  const values = { a: [99.5, 10], b: [10, 10], c: [20, 20], ...options.values };
  const calls = [], switches = [], refreshed = [], messages = [];
  const settings = Object.fromEntries(['claude', 'codex'].map(provider => [provider, {
    enabled: false, autoRotate: false, thresholdPercent: 99.5, intervalMs: (provider === 'claude' ? 2 : 6) * 3600000,
    checkIntervalMs: 600000, home: directory, cliPath: provider, model: '', ...options.settings?.[provider]
  }]));
  const profiles = {
    profiles: () => ['a', 'b', 'c'].map(id => ({ id, name: id })),
    activeProfileId: provider => active[provider],
    credential: async (provider, id) => ({ id }),
    refreshedCredential: async (...args) => refreshed.push(args),
    matchesNative: async () => options.matchesNative !== false,
    activateProfile: async (provider, id, automatic) => {
      active[provider] = id;
      switches.push([provider, id, automatic]);
      return true;
    }
  };
  const probe = async (provider, credential, config, keepAlive) => {
    calls.push([provider, credential.id, keepAlive]);
    if (options.beforeProbe) await options.beforeProbe(provider, credential, keepAlive);
    const percents = values[credential.id];
    return { credential: { ...credential, refreshed: true }, result: percents
      ? { kind: 'ok', usage: usage(provider, percents, now) }
      : { kind: 'error', provider, title: provider, message: 'Unavailable' } };
  };
  const make = () => new AccountAutomation(directory, profiles, p => settings[p], async () => {}, m => messages.push(m), probe, () => now);
  const service = make();
  t.after(() => service.dispose());
  return { service, make, active, values, calls, switches, refreshed, settings, messages,
    observe: (provider, percents) => service.observe(provider, active[provider], usage(provider, percents, now)),
    advance: ms => { now += ms; } };
}

test('99.5% default threshold preserves precision and checks both periods', () => {
  assert.equal(atLimit(usage('codex', [99.49, 20], Date.now())), false);
  assert.equal(atLimit(usage('codex', [5, 99.5], Date.now())), true);
  assert.equal(eligibleAccount(usage('codex', [5, 99.5], Date.now())), false);
  assert.equal(atLimit(usage('codex', [80, 20], Date.now()), 80), true);
  assert.equal(eligibleAccount(usage('codex', [5, 80], Date.now()), Date.now(), 80), false);
  assert.equal(eligibleAccount(usage('codex', [], Date.now())), false);
  const expired = usage('codex', [10, 10], Date.now());
  expired.windows[1].resetsAt = new Date(0);
  assert.equal(eligibleAccount(expired), false);
});

test('disabled automation performs no background calls', async t => {
  const f = fixture(t);
  await f.service.tick();
  assert.deepEqual(f.calls, []);
});

test('per-account 2h/6h schedule persists across service restarts and includes inactive accounts', async t => {
  const f = fixture(t, { settings: { claude: { enabled: true }, codex: { enabled: true } } });
  await f.service.tick();
  assert.equal(f.calls.length, 6);
  assert.equal(f.refreshed.length, 6);
  assert.match(f.service.usageDetail('codex', 'b'), /5h: 10%.*7d: 10%/);
  const restarted = f.make();
  t.after(() => restarted.dispose());
  await restarted.tick();
  assert.equal(f.calls.length, 6);
  f.advance(2 * 3600000);
  await restarted.tick();
  assert.equal(f.calls.filter(c => c[0] === 'claude').length, 6);
  assert.equal(f.calls.filter(c => c[0] === 'codex').length, 3);
  f.advance(4 * 3600000);
  await restarted.tick();
  assert.equal(f.calls.filter(c => c[0] === 'codex').length, 6);
});

test('a weekly Codex limit skips exhausted next account and activates the next eligible one', async t => {
  const f = fixture(t, { values: { a: [10, 99.5], b: [99.5, 5] }, settings: { codex: { autoRotate: true } } });
  f.observe('codex', [10, 99.5]);
  await f.service.tick();
  assert.deepEqual(f.switches, [['codex', 'c', true]]);
  assert.deepEqual(f.calls, [['codex', 'a', false], ['codex', 'b', false], ['codex', 'c', false]]);
});

test('all exhausted accounts leave the active login unchanged and throttle repeated sweeps', async t => {
  const f = fixture(t, { values: { b: [99.5, 5], c: [5, 100] }, settings: { codex: { autoRotate: true } } });
  f.observe('codex', [99.5, 10]);
  await f.service.tick();
  await f.service.tick();
  assert.equal(f.calls.length, 3);
  assert.deepEqual(f.switches, []);
  f.advance(600001);
  f.values.b = [2, 2];
  await f.service.tick();
  assert.deepEqual(f.switches, [['codex', 'b', true]]);
});

test('fresh active reading after a reset prevents rotation from an old exhausted cache', async t => {
  const f = fixture(t, { values: { a: [0, 2] }, settings: { claude: { autoRotate: true } } });
  f.observe('claude', [100, 10]);
  await f.service.tick();
  assert.deepEqual(f.switches, []);
  assert.equal(f.calls.length, 1);
});

test('unavailable and partial-window accounts cannot become rotation targets', async t => {
  const f = fixture(t, { values: { b: undefined, c: [10] }, settings: { codex: { autoRotate: true } } });
  f.observe('codex', [99.5, 10]);
  await f.service.tick();
  assert.deepEqual(f.switches, []);
});

test('failed active refresh never rotates using its last good reading', async t => {
  const f = fixture(t, { values: { a: undefined }, settings: { claude: { autoRotate: true } } });
  f.observe('claude', [99.5, 10]);
  await f.service.tick();
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.switches, []);
});

test('external native account changes prevent automatic switching', async t => {
  const f = fixture(t, { matchesNative: false, settings: { codex: { autoRotate: true } } });
  f.observe('codex', [99.5, 10]);
  await f.service.tick();
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.switches, []);
});

test('account change while checking a candidate cancels the switch', async t => {
  let f;
  f = fixture(t, { settings: { codex: { autoRotate: true } }, beforeProbe: async (provider, credential) => {
    if (credential.id === 'b') f.active.codex = 'c';
  } });
  f.observe('codex', [99.5, 10]);
  await f.service.tick();
  assert.deepEqual(f.switches, []);
});

test('concurrent windows and overlapping timer ticks do not duplicate checks', async t => {
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  const f = fixture(t, { settings: { claude: { enabled: true } }, beforeProbe: () => wait });
  const other = f.make();
  t.after(() => other.dispose());
  const first = f.service.tick();
  const second = f.service.tick();
  await other.tick();
  release();
  await Promise.all([first, second]);
  assert.equal(f.calls.length, 3);
});

test('failed keep-alive attempts still persist schedule instead of retrying every tick', async t => {
  const f = fixture(t, { values: { a: undefined }, settings: { claude: { enabled: true } } });
  await f.service.tick();
  await f.service.tick();
  assert.equal(f.calls.length, 3);
  assert.match(f.service.usageDetail('claude', 'a'), /Unavailable/);
});

test('manual keep-alive runs while disabled, updates account stats, and resets its periodic schedule', async t => {
  const f = fixture(t);
  const result = await f.service.sendKeepAliveNow('codex', 'b');
  assert.deepEqual(f.calls, [['codex', 'b', true]]);
  assert.deepEqual(result.usage.windows.map(window => window.usedPercent), [10, 10]);
  assert.match(f.service.usageDetail('codex', 'b'), /5h: 10%.*7d: 10%/);

  f.settings.codex.enabled = true;
  await f.service.tick();
  assert.deepEqual(f.calls.filter(call => call[0] === 'codex').map(call => call[1]), ['b', 'a', 'c']);
});

test('rotation wraps once through saved order without selecting current account', async t => {
  const f = fixture(t, { values: { c: [99.5, 0], a: [1, 1] }, settings: { codex: { autoRotate: true } } });
  f.active.codex = 'c';
  f.observe('codex', [99.5, 0]);
  await f.service.tick();
  assert.deepEqual(f.switches, [['codex', 'a', true]]);
});

test('per-service rotation threshold controls triggering and candidate eligibility', async t => {
  const f = fixture(t, {
    values: { a: [80, 10], b: [79.9, 20] },
    settings: { codex: { autoRotate: true, thresholdPercent: 80 } }
  });
  f.observe('codex', [80, 10]);
  await f.service.tick();
  assert.deepEqual(f.switches, [['codex', 'b', true]]);
});
