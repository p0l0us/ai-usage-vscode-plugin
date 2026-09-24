const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AccountAutomation, atLimit, eligibleAccount, modelWindowFilter, rotationScore } = require('../out/accountAutomation');

const HOUR = 3600000;
// A window is a plain percentage ("5h", then "7d") or [label, percent, hours until reset].
const usage = (provider, percents, now) => ({ provider, title: provider, fetchedAt: new Date(now),
  windows: percents.map((value, i) => Array.isArray(value)
    ? { label: value[0], usedPercent: value[1], resetsAt: new Date(now + value[2] * HOUR) }
    : { label: i ? '7d' : '5h', usedPercent: value, resetsAt: new Date(now + 86400000) }) });

function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-automation-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let now = Date.now();
  const active = { claude: 'a', codex: 'a' };
  const values = { a: [99.5, 10], b: [10, 10], c: [20, 20], ...options.values };
  const calls = [], switches = [], refreshed = [], messages = [], problems = [];
  const settings = Object.fromEntries(['claude', 'codex'].map(provider => [provider, {
    enabled: false, autoRotate: false, thresholdPercent: 99.5, intervalMs: (provider === 'claude' ? 2 : 6) * 3600000,
    checkIntervalMs: 600000, home: directory, cliPath: provider, model: '', ...options.settings?.[provider]
  }]));
  const profiles = {
    profiles: () => (options.ids ?? ['a', 'b', 'c']).map(id => ({ id, name: id })),
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
    return { credential: { ...credential, refreshed: true },
      keepAliveError: keepAlive ? options.keepAliveErrors?.[credential.id] : undefined,
      result: percents
        ? { kind: 'ok', usage: usage(provider, percents, now) }
        : { kind: 'error', provider, title: provider, message: options.usageErrors?.[credential.id] ?? 'Unavailable',
          transient: Boolean(options.transientErrors?.[credential.id]) } };
  };
  const make = () => {
    const service = new AccountAutomation(directory, profiles, p => settings[p], async () => {}, m => messages.push(m), probe, () => now);
    service.onAccountProblem = (...args) => problems.push(args);
    return service;
  };
  const service = make();
  t.after(() => service.dispose());
  return { service, make, options, active, values, calls, switches, refreshed, settings, messages, problems,
    observe: (provider, percents, id = active[provider]) => service.observe(provider, id, usage(provider, percents, now)),
    /** Cache every account's configured reading, as a keep-alive sweep would. */
    observeAll: provider => Object.entries(values).forEach(([id, percents]) =>
      percents && service.observe(provider, id, usage(provider, percents, now))),
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
  // The active account's reading is moments old, so only candidates are read; the eligible one gets a real
  // keep-alive before anything is switched.
  assert.deepEqual(f.calls, [['codex', 'b', false], ['codex', 'c', false], ['codex', 'c', true]]);
});

test('a candidate whose pre-switch keep-alive fails is reported and skipped for the next healthy account', async t => {
  const f = fixture(t, { values: { a: [99.5, 10] }, keepAliveErrors: { b: 'Keep-alive CLI exited with code 1: Your workspace is out of credits.' },
    settings: { codex: { autoRotate: true } } });
  f.observe('codex', [99.5, 10]);
  await f.service.tick();
  assert.deepEqual(f.switches, [['codex', 'c', true]]);
  assert.deepEqual(f.problems, [['codex', 'b', 'Keep-alive CLI exited with code 1: Your workspace is out of credits.', false]]);
  // The menu shows the problem in a few words, not the CLI's output.
  assert.match(f.service.usageDetail('codex', 'b'), /\$\(warning\) Insufficient credits$/);
});

test('a revoked candidate is never switched to and is announced once per credential', async t => {
  const revoked = 'Keep-alive CLI exited with code 1: Your access token could not be refreshed because your refresh token was revoked. Please log out and sign in again.';
  const f = fixture(t, { values: { a: [99.5, 10], c: [99.5, 10] }, keepAliveErrors: { b: revoked }, settings: { codex: { autoRotate: true } } });
  f.observe('codex', [99.5, 10]);
  await f.service.tick();
  f.advance(600001);
  await f.service.tick();
  assert.deepEqual(f.switches, []);
  assert.deepEqual(f.problems, [['codex', 'b', revoked, true]]);
});

test('a revoked login found by a usage check is announced, and a new sign-in clears it', async t => {
  const revoked = 'Codex CLI: account/rateLimits/read failed: 401 Unauthorized; {"code": "token_revoked"}';
  const f = fixture(t, { values: { b: undefined }, usageErrors: { b: revoked } });
  await f.service.sendKeepAliveNow('codex', 'b');
  await f.service.sendKeepAliveNow('codex', 'b');
  assert.deepEqual(f.problems, [['codex', 'b', revoked, true]]);
  f.values.b = [5, 5];
  const result = await f.service.credentialReplaced('codex', 'b');
  assert.equal(result.usage.windows[0].usedPercent, 5);
  assert.deepEqual(f.calls.at(-1), ['codex', 'b', false]);
  assert.doesNotMatch(f.service.usageDetail('codex', 'b'), /token_revoked/);
});

test('all exhausted accounts leave the active login unchanged and throttle repeated sweeps', async t => {
  const f = fixture(t, { values: { b: [99.5, 5], c: [5, 100] }, settings: { codex: { autoRotate: true } } });
  f.observe('codex', [99.5, 10]);
  await f.service.tick();
  await f.service.tick();
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.switches, []);
  f.advance(600001);
  f.values.b = [2, 2];
  await f.service.tick();
  assert.deepEqual(f.switches, [['codex', 'b', true]]);
});

test('fresh active reading after a reset prevents rotation from an old exhausted cache', async t => {
  const f = fixture(t, { values: { a: [0, 2] }, settings: { claude: { autoRotate: true } } });
  f.observe('claude', [100, 10]);
  f.advance(3 * 60000);
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
  f.advance(3 * 60000);
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

test('5-hour, weekly and Fable thresholds apply to their own windows and fall back in order', () => {
  const now = Date.now();
  const limits = { thresholdPercent: 99.5, fiveHourThresholdPercent: 80, weeklyThresholdPercent: 60 };
  assert.equal(atLimit(usage('claude', [['5h', 85, 1], ['7d', 10, 24]], now), limits), true);
  assert.equal(atLimit(usage('claude', [['5h', 50, 1], ['7d', 59, 24]], now), limits), false);
  assert.equal(atLimit(usage('claude', [['5h', 50, 1], ['7d', 61, 24]], now), limits), true);
  // "7d Fable" uses the weekly threshold until its own is set.
  assert.equal(atLimit(usage('claude', [['5h', 1, 1], ['7d', 1, 24], ['7d Fable', 65, 24]], now), limits), true);
  assert.equal(atLimit(usage('claude', [['5h', 1, 1], ['7d', 1, 24], ['7d Fable', 65, 24]], now),
    { ...limits, modelWeeklyThresholdPercent: 90 }), false);
  assert.equal(atLimit(usage('claude', [['5h', 99, 1]], now), { thresholdPercent: 99.5 }), false);
});

test('the Fable window counts only for the configured model in auto mode', () => {
  const now = Date.now();
  const fableOut = usage('claude', [['5h', 1, 1], ['7d', 50, 24], ['7d Fable', 100, 24]], now);
  const limits = countsWindow => ({ thresholdPercent: 99.5, countsWindow });
  assert.equal(eligibleAccount(fableOut, now, limits(modelWindowFilter('auto', 'claude-fable-5-1'))), false);
  assert.equal(eligibleAccount(fableOut, now, limits(modelWindowFilter('auto', 'opus'))), true);
  assert.equal(eligibleAccount(fableOut, now, limits(modelWindowFilter('auto', undefined))), false);
  assert.equal(eligibleAccount(fableOut, now, limits(modelWindowFilter('never', 'fable'))), true);
  assert.equal(eligibleAccount(fableOut, now, limits(modelWindowFilter('always', 'opus'))), false);
});

// The five accounts of a real afternoon: c is active.
const afternoon = {
  a: [['5h', 0, 3], ['7d', 71, 120], ['7d Fable', 71, 120]],
  b: [['5h', 100, 1], ['7d', 83, 48], ['7d Fable', 79, 48]],
  c: [['5h', 2, 0.1], ['7d', 91, 48], ['7d Fable', 89, 48]],
  d: [['5h', 100, 4], ['7d', 39, 144], ['7d Fable', 33, 144]],
  e: [['5h', 53, 4], ['7d', 9, 96], ['7d Fable', 17, 96]]
};

test('soonest reset skips 5h-locked accounts and defers one spending its week too early', async t => {
  const f = fixture(t, { ids: ['a', 'b', 'c', 'd', 'e'], values: { ...afternoon, c: [['5h', 100, 0.1], ['7d', 91, 48], ['7d Fable', 89, 48]] },
    settings: { claude: { autoRotate: true, strategy: 'soonestReset' } } });
  f.active.claude = 'c';
  f.observeAll('claude');
  await f.service.tick();
  // e resets in 4 days and is behind pace; a resets later and is 42 points ahead with most of its week left.
  assert.deepEqual(f.switches, [['claude', 'e', true]]);
  assert.deepEqual(f.calls, [['claude', 'e', false], ['claude', 'e', true]]);
});

test('proactive soonest reset keeps the account resetting first without spending any calls', async t => {
  const f = fixture(t, { ids: ['a', 'b', 'c', 'd', 'e'], values: afternoon,
    settings: { claude: { autoRotate: true, strategy: 'soonestReset', trigger: 'proactive', minStayMs: 0 } } });
  f.active.claude = 'c';
  f.observeAll('claude');
  await f.service.tick();
  assert.deepEqual(f.switches, []);
  assert.deepEqual(f.calls, []);
});

test('proactive even pace leaves an account ahead of pace, but only after the minimum stay', async t => {
  const f = fixture(t, { ids: ['a', 'b', 'c', 'd', 'e'], values: afternoon,
    settings: { claude: { autoRotate: true, strategy: 'evenPace', trigger: 'proactive', minStayMs: 30 * 60000 } } });
  f.active.claude = 'c';
  f.observeAll('claude');
  await f.service.tick();
  assert.deepEqual(f.switches, []);
  f.advance(31 * 60000);
  f.observeAll('claude');
  await f.service.tick();
  assert.deepEqual(f.switches, [['claude', 'e', true]]);
  // Just switched: the stay starts again.
  f.advance(10 * 60000);
  f.values.a = [['5h', 0, 3], ['7d', 0, 167], ['7d Fable', 0, 167]];
  f.observeAll('claude');
  await f.service.tick();
  assert.deepEqual(f.switches, [['claude', 'e', true]]);
});

test('proactive rotation does not switch when the fresh reading no longer shows a better account', async t => {
  const f = fixture(t, { ids: ['a', 'b', 'c', 'd', 'e'], values: afternoon,
    settings: { claude: { autoRotate: true, strategy: 'evenPace', trigger: 'proactive', minStayMs: 0 } } });
  f.active.claude = 'c';
  f.observeAll('claude');
  f.values.e = [['5h', 53, 4], ['7d', 95, 96], ['7d Fable', 95, 96]];
  await f.service.tick();
  assert.deepEqual(f.switches, []);
  assert.deepEqual(f.calls.map(call => call[1]), ['e']);
});

test('least waste prefers the most allowance per hour over the soonest reset', async t => {
  const values = { a: [['5h', 99.5, 1], ['7d', 50, 72]], b: [['5h', 0, 5], ['7d', 90, 24]], c: [['5h', 0, 5], ['7d', 20, 100]] };
  for (const [strategy, expected] of [['soonestReset', 'b'], ['leastWaste', 'c'], ['sequential', 'b']]) {
    const f = fixture(t, { values, settings: { codex: { autoRotate: true, strategy } } });
    f.observeAll('codex');
    await f.service.tick();
    assert.deepEqual(f.switches, [['codex', expected, true]], strategy);
  }
});

test('a cached window whose reset has passed ranks as fresh', () => {
  const now = Date.now();
  const limits = { thresholdPercent: 99.5 };
  const stale = usage('claude', [['5h', 100, -1], ['7d', 95, -2]], now);
  // Rolled forward: the 7d window restarted 2 hours ago.
  const fresh = usage('claude', [['5h', 0, 4], ['7d', 0, 166]], now);
  for (const strategy of ['soonestReset', 'evenPace', 'leastWaste']) {
    assert.ok(Math.abs(rotationScore(strategy, stale, now, limits) - rotationScore(strategy, fresh, now, limits)) < 1e-6, strategy);
  }
  assert.equal(rotationScore('sequential', fresh, now, limits), undefined);
  assert.equal(rotationScore('evenPace', usage('claude', [['5h', 10, 4]], now), now, limits), undefined);
});

test('a reading that reaches a threshold rotates at once, without waiting for a tick or re-reading the account', async t => {
  const f = fixture(t, { settings: { claude: { autoRotate: true, fiveHourThresholdPercent: 91 } } });
  f.observe('claude', [91, 10]);
  await f.service.tick(); // joins the rotation the reading started
  assert.deepEqual(f.switches, [['claude', 'b', true]]);
  assert.deepEqual(f.calls, [['claude', 'b', false], ['claude', 'b', true]]);
});

test('a reading below every threshold does not start rotation', async t => {
  const f = fixture(t, { settings: { claude: { autoRotate: true, fiveHourThresholdPercent: 91 } } });
  f.observe('claude', [90, 10]);
  await f.service.tick();
  assert.deepEqual(f.calls, []);
});

test('a sweep that cannot read the active account retries once its pause ends, not a full interval later', async t => {
  const f = fixture(t, { values: { a: undefined }, transientErrors: { a: true }, settings: { claude: { autoRotate: false } } });
  // A rate-limited check pauses the active account's checks for the 10-minute interval.
  await f.service.sendKeepAliveNow('claude', 'a');
  f.observe('claude', [99.5, 10]);
  f.advance(8 * 60000);
  f.settings.claude.autoRotate = true;
  await f.service.tick();
  assert.deepEqual(f.switches, []);
  // The pause ends two minutes later; the old throttle would have waited until 18 minutes.
  f.values.a = [99.5, 10];
  f.options.transientErrors = {};
  f.advance(2 * 60000 + 1);
  await f.service.tick();
  assert.deepEqual(f.switches, [['claude', 'b', true]]);
});
