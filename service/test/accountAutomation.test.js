const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AccountAutomation, atLimit, eligibleAccount, modelWindowFilter, rotationScore } = require('../out/accountAutomation');
const { UsageHistory } = require('../out/usageHistory');

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
  const calls = [], switches = [], refreshed = [], messages = [], problems = [], resets = [];
  const credits = { ...options.credits };
  const redeemedKeys = new Set();
  const settings = Object.fromEntries(['claude', 'codex'].map(provider => [provider, {
    enabled: false, autoRotate: false, fiveHourThresholdPercent: 99.5, weeklyThresholdPercent: 99.5, intervalMs: (provider === 'claude' ? 2 : 6) * 3600000,
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
        ? { kind: 'ok', usage: { ...usage(provider, percents, now),
          ...(provider === 'codex' && credits[credential.id] !== undefined ? { resetCredits: {
            availableCount: credits[credential.id], ...(options.creditExpiry ? { earliestExpiresAt: options.creditExpiry } : {})
          } } : {}) } }
        : { kind: 'error', provider, title: provider, message: options.usageErrors?.[credential.id] ?? 'Unavailable',
          transient: Boolean(options.transientErrors?.[credential.id]) } };
  };
  const make = () => {
    const reset = async (credential, resetSettings, key) => {
      resets.push([credential.id, key]);
      if (options.beforeReset) await options.beforeReset(credential, key, resets.length);
      if (redeemedKeys.has(key)) return { outcome: 'alreadyRedeemed', credential,
        result: { kind: 'ok', usage: { ...usage('codex', values[credential.id], now),
          resetCredits: { availableCount: credits[credential.id] } } } };
      if (credits[credential.id] <= 0) return { outcome: 'noCredit', credential,
        result: { kind: 'ok', usage: { ...usage('codex', values[credential.id], now), resetCredits: { availableCount: 0 } } } };
      credits[credential.id]--;
      redeemedKeys.add(key);
      values[credential.id] = options.afterReset ?? [0, 10];
      if (options.resetReadFails && resets.length === 1) return { outcome: 'reset', credential,
        result: { kind: 'error', provider: 'codex', title: 'Codex', message: 'usage read failed' } };
      return { outcome: 'reset', credential, result: { kind: 'ok', usage: { ...usage('codex', values[credential.id], now),
        resetCredits: { availableCount: credits[credential.id] } } } };
    };
    const service = new AccountAutomation(directory, profiles, p => settings[p], async () => {}, m => messages.push(m), probe, () => now, reset);
    service.onAccountProblem = (...args) => problems.push(args);
    // With `history`, every instance appends to one history under the state directory, as the service does.
    if (options.history) {
      service.history = new UsageHistory(path.join(directory, 'history'), { enabled: true, retentionMs: 365 * 86400000 }, m => messages.push(m), () => now);
    }
    return service;
  };
  const service = make();
  t.after(() => service.dispose());
  return { service, make, options, active, values, credits, calls, switches, resets, refreshed, settings, messages, problems,
    /** Every recorded history event, oldest first. */
    events: () => service.history ? [...service.history.events()] : [],
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

test('a stored reading from before reset no longer blocks the profile', async t => {
  const f = fixture(t);
  f.observe('claude', [['5h', 100, 5], ['7d', 10, 168]]);
  assert.equal(f.service.limitState('claude', 'a').readOnly, true);
  f.advance(6 * 3_600_000);
  assert.equal(f.service.limitState('claude', 'a').readOnly, false);
  assert.equal(f.service.usage('claude', 'a'), undefined);
  assert.match(f.service.usageDetail('claude', 'a'), /Usage reset/);
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

test('a profile reading from before reset cannot block activation or show the old percentage', t => {
  const f = fixture(t);
  const expired = usage('claude', [100, 40], Date.now() - 2 * HOUR);
  expired.windows[0].resetsAt = new Date(Date.now() - HOUR);
  f.service.observe('claude', 'a', expired);
  assert.deepEqual(f.service.limitState('claude', 'a'), { readOnly: false, dimmed: false });
  assert.match(f.service.usageDetail('claude', 'a'), /Usage reset; waiting for a new reading/);
  assert.doesNotMatch(f.service.usageDetail('claude', 'a'), /100%/);
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

test('an expired login the CLI could not refresh is announced for a new sign-in and marks the account', async t => {
  const expired = 'Keep-alive CLI exited with code 1: Failed to authenticate: OAuth session expired and could not be refreshed';
  const f = fixture(t, { values: { b: undefined }, keepAliveErrors: { b: expired }, usageErrors: { b: 'Login token expired. Run `claude` once to refresh it.' } });
  await f.service.sendKeepAliveNow('claude', 'b');
  await f.service.sendKeepAliveNow('claude', 'b');
  assert.deepEqual(f.problems, [['claude', 'b', expired, true]]);
  assert.equal(f.service.loginProblem('claude', 'b'), expired);
  assert.equal(f.service.loginProblem('claude', 'a'), undefined);
  assert.match(f.service.usageDetail('claude', 'b'), /\$\(warning\) Login expired/);
});

test('a keep-alive whose caller reports a dead login records it as announced without telling onAccountProblem', async t => {
  const expired = 'Keep-alive CLI exited with code 1: Failed to authenticate: OAuth session expired and could not be refreshed';
  const f = fixture(t, { values: { b: undefined }, keepAliveErrors: { b: expired }, usageErrors: { b: 'Login token expired. Run `claude` once to refresh it.' } });
  const result = await f.service.sendKeepAliveNow('claude', 'b', { callerReports: true });
  assert.equal(result.keepAliveError, expired);
  assert.deepEqual(f.problems, []);
  assert.equal(f.service.loginProblem('claude', 'b'), expired);
  // The same dead login is not announced later either, by a plain manual keep-alive or by the periodic sweep.
  await f.service.sendKeepAliveNow('claude', 'b');
  f.settings.claude.enabled = true;
  f.advance(2 * HOUR + 1);
  await f.service.tick();
  assert.deepEqual(f.calls.map(call => call[1]).filter(id => id === 'b').length, 3);
  assert.deepEqual(f.problems, []);
});

test('a merely expired token is a login problem to check again, not one to announce', async t => {
  const expired = 'Login token expired. Run `codex` once to refresh it.';
  const f = fixture(t, { values: { c: undefined }, usageErrors: { c: expired } });
  await f.service.sendKeepAliveNow('codex', 'c');
  assert.deepEqual(f.problems, []);
  assert.equal(f.service.loginProblem('codex', 'c'), expired);
  // Once the keep-alive refreshed the token, the reading returns and the mark goes away.
  f.values.c = [5, 5];
  await f.service.sendKeepAliveNow('codex', 'c');
  assert.equal(f.service.loginProblem('codex', 'c'), undefined);
});

test('all exhausted accounts leave the active login unchanged and throttle repeated sweeps', async t => {
  const f = fixture(t, { values: { b: [99.5, 5], c: [5, 100] }, settings: { codex: { autoRotate: true } } });
  f.observe('codex', [99.5, 10]);
  await f.service.tick();
  await f.service.tick();
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.switches, []);
  // Their stored readings reset in a day; until then they are not read again, since they cannot have recovered.
  f.advance(600001);
  f.values.b = [2, 2];
  await f.service.tick();
  assert.deepEqual(f.switches, []);
  assert.deepEqual(f.calls.slice(2), [['codex', 'a', false]]);
  f.advance(86400000);
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
    settings: { codex: { autoRotate: true, fiveHourThresholdPercent: 80, weeklyThresholdPercent: 80 } }
  });
  f.observe('codex', [80, 10]);
  await f.service.tick();
  assert.deepEqual(f.switches, [['codex', 'b', true]]);
});

test('the 5-hour threshold applies to the 5h window and the weekly one to every weekly window, at usage >= threshold', () => {
  const now = Date.now();
  const limits = { fiveHourThresholdPercent: 80, weeklyThresholdPercent: 60 };
  assert.equal(atLimit(usage('claude', [['5h', 85, 1], ['7d', 10, 24]], now), limits), true);
  assert.equal(atLimit(usage('claude', [['5h', 80, 1], ['7d', 10, 24]], now), limits), true);
  assert.equal(atLimit(usage('claude', [['5h', 79.9, 1], ['7d', 59, 24]], now), limits), false);
  assert.equal(atLimit(usage('claude', [['5h', 50, 1], ['7d', 60, 24]], now), limits), true);
  // "7d Fable" is a weekly window too.
  assert.equal(atLimit(usage('claude', [['5h', 1, 1], ['7d', 1, 24], ['7d Fable', 65, 24]], now), limits), true);
  // A candidate has to be below every threshold: exactly at one is not eligible.
  assert.equal(eligibleAccount(usage('claude', [['5h', 80, 1], ['7d', 10, 24]], now), now, limits), false);
  assert.equal(eligibleAccount(usage('claude', [['5h', 79, 1], ['7d', 59, 24]], now), now, limits), true);
});

test('the Fable window counts only for the configured model in auto mode', () => {
  const now = Date.now();
  const fableOut = usage('claude', [['5h', 1, 1], ['7d', 50, 24], ['7d Fable', 100, 24]], now);
  const limits = countsWindow => ({ fiveHourThresholdPercent: 99.5, weeklyThresholdPercent: 99.5, countsWindow });
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

test('Codex waits for an exhausted account that will recover within five minutes, then rechecks it', async t => {
  const f = fixture(t, { ids: ['a', 'b'], values: { a: [['5h', 100, 1 / 60], ['7d', 10, 48]], b: [10, 10] },
    settings: { codex: { autoRotate: true, resetAware: true, strategy: 'soonestReset' } } });
  f.observe('codex', f.values.a);
  await f.service.tick();
  assert.deepEqual(f.switches, []);
  f.values.a = [['5h', 0, 5], ['7d', 10, 48]];
  f.advance(2 * 60_000);
  await f.service.tick();
  assert.deepEqual(f.switches, [], 'a fresh reading after reset keeps the recovered account');
  assert.deepEqual(f.calls.map((call) => call[1]), ['a'], 'no other account was probed');
});

test('each Codex strategy skips a candidate whose quota resets in one minute', async t => {
  for (const strategy of ['sequential', 'soonestReset', 'evenPace', 'leastWaste']) {
    const f = fixture(t, { values: {
      a: [['5h', 100, 10], ['7d', 10, 100]],
      b: [['5h', 10, 1 / 60], ['7d', 10, 1 / 60]],
      c: [['5h', 10, 4], ['7d', 10, 50]]
    }, settings: { codex: { autoRotate: true, resetAware: true, strategy } } });
    f.observeAll('codex');
    await f.service.tick();
    assert.deepEqual(f.switches, [['codex', 'c', true]], strategy);
    assert.ok(!f.calls.some((call) => call[1] === 'b'), strategy);
  }
});

test('Codex reset awareness can be disabled and manual rotation bypasses it', async t => {
  for (const manual of [false, true]) {
    const f = fixture(t, { ids: ['a', 'b'], values: {
      a: [['5h', 100, 1 / 60], ['7d', 10, 100]], b: [10, 10]
    }, settings: { codex: { autoRotate: !manual, resetAware: manual } } });
    f.observe('codex', f.values.a);
    if (manual) { assert.deepEqual(await f.service.rotateNow('codex'), { switched: true }); }
    else { await f.service.tick(); }
    assert.deepEqual(f.switches, [['codex', 'b', true]]);
  }
});

test('Codex automatically redeems only provider-reported earned resets and shows the observed total', async t => {
  const f = fixture(t, { ids: ['a'], credits: { a: 2 }, values: { a: [['5h', 100, 10], ['7d', 10, 100]] },
    settings: { codex: { autoReset: true, autoRotate: false, resetAware: true } } });
  await f.service.tick();
  assert.equal(f.resets.length, 1);
  assert.equal(f.credits.a, 1);
  assert.deepEqual(f.service.usage('codex', 'a').resetCredits, { availableCount: 1, totalCount: 2 });
  await f.service.tick();
  assert.equal(f.resets.length, 1, 'a recovered account spends no more credits');
});

test('Codex rotates before spending a reset credit unless the credit is about to expire', async t => {
  const later = fixture(t, { ids: ['a', 'b'], credits: { a: 2 },
    values: { a: [['5h', 100, 10], ['7d', 10, 100]], b: [10, 10] },
    settings: { codex: { autoReset: true, autoRotate: true, resetAware: true, strategy: 'sequential' } } });
  await later.service.tick();
  assert.deepEqual(later.switches, [['codex', 'b', true]]);
  assert.equal(later.resets.length, 0);

  const urgent = fixture(t, { ids: ['a', 'b'], credits: { a: 2 }, creditExpiry: Math.floor(Date.now() / 1000) + 10 * 60,
    values: { a: [['5h', 100, 10], ['7d', 10, 100]], b: [10, 10] },
    settings: { codex: { autoReset: true, autoRotate: true, resetAware: true, strategy: 'leastWaste' } } });
  urgent.observe('codex', urgent.values.b, 'b');
  await urgent.service.tick();
  assert.equal(urgent.resets.length, 1);
  assert.deepEqual(urgent.switches, []);

  const candidateExpiresFirst = fixture(t, { ids: ['a', 'b'], credits: { a: 2 },
    creditExpiry: Math.floor(Date.now() / 1000) + 30 * 60,
    values: { a: [['5h', 100, 10], ['7d', 10, 100]], b: [['5h', 10, 8 / 60], ['7d', 10, 50]] },
    settings: { codex: { autoReset: true, autoRotate: true, resetAware: true, strategy: 'leastWaste' } } });
  candidateExpiresFirst.observe('codex', candidateExpiresFirst.values.b, 'b');
  await candidateExpiresFirst.service.tick();
  assert.deepEqual(candidateExpiresFirst.switches, [['codex', 'b', true]]);
  assert.equal(candidateExpiresFirst.resets.length, 0);
});

test('an earned reset is saved when natural recovery is near or no credits are reported', async t => {
  const near = fixture(t, { ids: ['a'], credits: { a: 1 }, values: { a: [['5h', 100, 1 / 60], ['7d', 10, 100]] },
    settings: { codex: { autoReset: true } } });
  await near.service.tick();
  assert.equal(near.resets.length, 0);
  const none = fixture(t, { ids: ['a'], credits: { a: 0 }, values: { a: [['5h', 100, 10], ['7d', 10, 100]] },
    settings: { codex: { autoReset: true } } });
  await none.service.tick();
  assert.equal(none.resets.length, 0);
});

test('an earned reset waits for another account recovering in one minute', async t => {
  const f = fixture(t, { ids: ['a', 'b'], credits: { a: 1 },
    values: { a: [['5h', 100, 10], ['7d', 10, 100]], b: [['5h', 100, 1 / 60], ['7d', 10, 100]] },
    settings: { codex: { autoReset: true, autoRotate: true, resetAware: true } } });
  f.observe('codex', f.values.b, 'b');
  await f.service.tick();
  assert.equal(f.resets.length, 0);
  assert.deepEqual(f.switches, []);
  f.values.b = [['5h', 0, 5], ['7d', 10, 100]];
  f.advance(2 * 60_000);
  await f.service.tick();
  assert.deepEqual(f.switches, [['codex', 'b', true]]);
  assert.equal(f.resets.length, 0);
});

test('a failed earned reset retries with the same idempotency key', async t => {
  let failures = 0;
  const f = fixture(t, { ids: ['a'], credits: { a: 1 }, values: { a: [['5h', 100, 10], ['7d', 10, 100]] },
    settings: { codex: { autoReset: true, checkIntervalMs: 60_000 } },
    beforeReset: () => { if (failures++ === 0) throw new Error('response lost'); } });
  await f.service.tick();
  assert.equal(f.resets.length, 1);
  f.advance(61_000);
  await f.service.tick();
  assert.equal(f.resets.length, 2);
  assert.equal(f.resets[0][1], f.resets[1][1]);
});

test('a redeemed credit is not spent twice when the follow-up usage read fails', async t => {
  const f = fixture(t, { ids: ['a'], credits: { a: 2 }, resetReadFails: true,
    values: { a: [['5h', 100, 10], ['7d', 10, 100]] },
    settings: { codex: { autoReset: true, checkIntervalMs: 60_000 } } });
  await f.service.tick();
  assert.equal(f.credits.a, 1);
  assert.equal(f.service.accountState('codex', 'a').resetAttemptKey, f.resets[0][1]);
  f.advance(61_000);
  await f.service.tick();
  assert.equal(f.credits.a, 1);
  assert.equal(f.resets.length, 1, 'fresh recovered usage confirms the previous redemption');
  assert.equal(f.service.accountState('codex', 'a').resetAttemptKey, undefined);
});

test('a cached window whose reset has passed ranks as fresh', () => {
  const now = Date.now();
  const limits = { fiveHourThresholdPercent: 99.5, weeklyThresholdPercent: 99.5 };
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

test('every strategy rotates at usage >= threshold and only to an account below every threshold', async t => {
  for (const strategy of ['sequential', 'soonestReset', 'evenPace', 'leastWaste']) {
    const f = fixture(t, {
      values: { a: [10, 99], b: [10, 99], c: [94, 50] },
      settings: { codex: { autoRotate: true, strategy, fiveHourThresholdPercent: 95, weeklyThresholdPercent: 99 } }
    });
    f.observeAll('codex');
    await f.service.tick();
    assert.deepEqual(f.switches, [['codex', 'c', true]], strategy);
  }
});

test('a session-log reading at the threshold makes the sweep read the active account instead of its stored reading', async t => {
  const f = fixture(t, {
    values: { a: [10, 97], b: [10, 50] },
    settings: { codex: { autoRotate: true, fiveHourThresholdPercent: 100, weeklyThresholdPercent: 90 } }
  });
  // The stored reading of the active account predates the limit.
  f.observe('codex', [10, 40]);
  await f.service.tick();
  assert.deepEqual(f.switches, []);
  f.service.hintLimit('codex', usage('codex', [10, 97], Date.now()));
  await f.service.tick();
  assert.deepEqual(f.switches, [['codex', 'b', true]]);
  assert.deepEqual(f.calls[0], ['codex', 'a', false]);
});

test('rotation that finds no account below the thresholds says so once', async t => {
  const f = fixture(t, {
    values: { a: [10, 97], b: [10, 98], c: [10, 100] },
    settings: { codex: { autoRotate: true, fiveHourThresholdPercent: 100, weeklyThresholdPercent: 90 } }
  });
  const notices = [];
  f.service.onNoCandidate = (provider, detail) => notices.push([provider, detail]);
  f.observeAll('codex');
  await f.service.tick();
  f.advance(20 * 60_000);
  f.observe('codex', [10, 97]);
  await f.service.tick();
  assert.deepEqual(f.switches, []);
  assert.equal(notices.length, 1);
  assert.match(notices[0][1], /7d 97% ≥ 90%/);
});

test('a keep-alive sweep rotates as soon as the active account reaches its limit, not after the last account', async t => {
  const f = fixture(t, { values: { a: [10, 10], b: [10, 10], c: [10, 10] }, settings: { codex: { enabled: true, autoRotate: true } },
    beforeProbe: (provider, credential, keepAlive) => {
      // While b's keep-alive runs, the status bar reads the active account a at its limit.
      if (credential.id === 'b' && keepAlive) { f.values.a = [99.5, 10]; f.observe('codex', [99.5, 10], 'a'); }
    } });
  await f.service.tick();
  assert.deepEqual(f.switches, [['codex', 'b', true]]);
  const order = f.calls.map(call => `${call[1]}:${call[2] ? 'ka' : 'usage'}`);
  // b was read and verified for the switch before c's keep-alive; a sweep that only rotated at its end would do c first.
  assert.ok(order.indexOf('c:ka') > order.lastIndexOf('b:ka'), order.join(' '));
});

test('a hold stops the service\'s sweeps and rotation and refuses hand-run checks until it is resumed or runs out', async t => {
  const f = fixture(t, { values: { a: [99.5, 10], b: [10, 10] }, settings: { codex: { enabled: true, autoRotate: true } } });
  f.service.hold('codex', 'a Codex sign-in is in progress', 60_000);
  f.observe('codex', [99.5, 10]);
  await f.service.tick();
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.switches, []);
  await assert.rejects(f.service.sendKeepAliveNow('codex', 'b'), /A Codex sign-in is in progress; keep-alives wait until it finishes\./);
  assert.deepEqual(await f.service.rotateNow('codex'), { switched: false, reason: 'a Codex sign-in is in progress' });
  // The other service is not held.
  f.settings.claude.enabled = true;
  await f.service.tick();
  assert.ok(f.calls.length > 0 && f.calls.every(call => call[0] === 'claude'), JSON.stringify(f.calls));
  f.service.resume('codex');
  await f.service.tick();
  assert.deepEqual(f.switches, [['codex', 'b', true]]);
  // A hold whose client never lifts it runs out by itself.
  f.service.hold('codex', 'a Codex sign-in is in progress', 20);
  assert.equal(f.service.heldFor('codex'), 'a Codex sign-in is in progress');
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(f.service.heldFor('codex'), undefined);
});

test('an account whose last check failed is not switched to, and costs no call, until a later check succeeds', async t => {
  const failure = 'Keep-alive CLI exited with code 1: workspace routing discovery unavailable';
  const f = fixture(t, { values: { a: [99.5, 10], b: [10, 10], c: [10, 10] }, keepAliveErrors: { b: failure }, settings: { codex: { autoRotate: true } } });
  // b's failed keep-alive marks it.
  await f.service.sendKeepAliveNow('codex', 'b');
  f.calls.length = 0;
  f.observe('codex', [99.5, 10]);
  await f.service.tick();
  assert.deepEqual(f.switches, [['codex', 'c', true]]);
  assert.ok(!f.calls.some(call => call[1] === 'b'), JSON.stringify(f.calls));
  assert.ok(f.messages.some(message => /not rotating to "b": its last check failed/.test(message)), f.messages.join('\n'));
  // Once a keep-alive of b succeeds, it is a candidate again.
  delete f.options.keepAliveErrors.b;
  await f.service.sendKeepAliveNow('codex', 'b');
  f.values.c = [99.5, 10];
  f.observe('codex', [99.5, 10], 'c');
  f.advance(600001);
  await f.service.tick();
  assert.deepEqual(f.switches.at(-1), ['codex', 'b', true]);
});

test('accounts left out for a failed last check are named when no candidate remains', async t => {
  const f = fixture(t, { ids: ['a', 'b'], values: { a: [99.5, 10], b: [10, 10] },
    keepAliveErrors: { b: 'Keep-alive CLI exited with code 1: workspace routing discovery unavailable' }, settings: { codex: { autoRotate: true } } });
  const notices = [];
  f.service.onNoCandidate = (provider, detail) => notices.push(detail);
  await f.service.sendKeepAliveNow('codex', 'b');
  f.observe('codex', [99.5, 10]);
  await f.service.tick();
  assert.deepEqual(f.switches, []);
  assert.equal(notices.length, 1);
  assert.match(notices[0], /left out for a failed last check: "b" \(.*workspace routing discovery unavailable/);
});

test('a candidate still at its limit by its stored reading, with the reset ahead, costs a limit sweep nothing until that reset', async t => {
  const f = fixture(t, { values: { a: [99.5, 10], b: [10, 10], c: [10, 10] }, settings: { codex: { autoRotate: true } } });
  // b's stored reading: weekly window at the threshold, resetting in 2 hours.
  f.observe('codex', [['5h', 10, 1], ['7d', 99.5, 2]], 'b');
  f.observe('codex', [99.5, 10]);
  await f.service.tick();
  assert.deepEqual(f.switches, [['codex', 'c', true]]);
  assert.ok(!f.calls.some(call => call[1] === 'b'), JSON.stringify(f.calls));
  // Once that reset has passed, b is read again and can be switched to; a's stored reading still blocks it.
  f.values.c = [99.5, 10];
  f.observe('codex', [99.5, 10], 'c');
  f.advance(2 * HOUR + 1);
  f.calls.length = 0;
  await f.service.tick();
  assert.deepEqual(f.switches.at(-1), ['codex', 'b', true]);
  assert.deepEqual(f.calls.map(call => call[1]), ['c', 'b', 'b']);
});

test('accounts still at their limit by their last reading are named with their reset when no candidate remains, and nothing is spent', async t => {
  const f = fixture(t, { ids: ['a', 'b'], values: { a: [99.5, 10], b: [10, 10] }, settings: { codex: { autoRotate: true } } });
  const notices = [];
  f.service.onNoCandidate = (provider, detail) => notices.push(detail);
  f.observe('codex', [['5h', 10, 1], ['7d', 99.5, 48]], 'b');
  f.observe('codex', [99.5, 10]);
  await f.service.tick();
  assert.deepEqual(f.calls, []);
  assert.deepEqual(f.switches, []);
  assert.equal(notices.length, 1);
  assert.match(notices[0], /still at their limit by their last reading: "b" \(resets in 2d\)/);
});

test('a keep-alive by hand waits for a running sweep, then holds the lock for its whole sweep', async t => {
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  const f = fixture(t, { settings: { claude: { enabled: true } }, beforeProbe: () => wait });
  const other = f.make();
  t.after(() => other.dispose());
  // Another service instance's sweep holds claude's lock while its first probe is blocked.
  const sweep = other.tick();
  await assert.rejects(f.service.sendKeepAliveNow('claude', 'b'), /already running/);
  const events = [];
  const byHand = f.service.withAccountLock('claude', async () => {
    events.push('started');
    await f.service.sendKeepAliveNow('claude', 'b');
    await f.service.sendKeepAliveNow('claude', 'c');
  }, { waitMs: 5000, onWait: () => events.push('waiting') });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(events, ['waiting']);
  release();
  await sweep;
  await byHand;
  assert.deepEqual(events, ['waiting', 'started']);
  assert.deepEqual(f.calls.map(call => call[1]), ['a', 'b', 'c', 'b', 'c']);
});

test('a keep-alive by hand gives up on the lock after its wait, and at once when cancelled', async t => {
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  const f = fixture(t, { settings: { claude: { enabled: true } }, beforeProbe: () => wait });
  const other = f.make();
  t.after(() => { release(); other.dispose(); });
  const sweep = other.tick();
  await assert.rejects(f.service.sendKeepAliveNow('claude', 'b', { wait: { waitMs: 60 } }), /already running/);
  const abort = new AbortController();
  const cancelled = assert.rejects(f.service.sendKeepAliveNow('claude', 'b', { wait: { waitMs: 60000, signal: abort.signal } }), /Cancelled/);
  abort.abort();
  await cancelled;
  release();
  await sweep;
  // The periodic sweep does not run while a sweep by hand holds the lock, and resumes afterwards.
  f.calls.length = 0;
  f.advance(3 * HOUR);
  await f.service.withAccountLock('claude', async () => {
    await f.service.tick();
    assert.deepEqual(f.calls, []);
  });
  await f.service.tick();
  assert.ok(f.calls.some(call => call[1] === 'b'), JSON.stringify(f.calls));
});

test('a rotation sweep by hand waits for a running sweep too, and reports a hold instead of waiting', async t => {
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  const f = fixture(t, { values: { a: [99.5, 10], b: [10, 10] }, settings: { codex: { enabled: true } }, beforeProbe: () => wait });
  const other = f.make();
  t.after(() => other.dispose());
  const sweep = other.tick();
  await assert.rejects(f.service.rotateNow('codex'), /already running/);
  const events = [];
  const byHand = f.service.rotateNow('codex', { waitMs: 5000, onWait: () => events.push('waiting') });
  await new Promise(resolve => setTimeout(resolve, 30));
  release();
  await sweep;
  assert.equal((await byHand).switched, true);
  assert.deepEqual(events, ['waiting']);
  f.service.hold('codex', 'a Codex sign-in is in progress', 60_000);
  assert.deepEqual(await f.service.rotateNow('codex'), { switched: false, reason: 'a Codex sign-in is in progress' });
});

test('the history records the readings of a sweep and the switch with every candidate and its outcome', async t => {
  const f = fixture(t, { history: true, values: { a: [10, 99.5], b: [99.5, 5] }, settings: { codex: { autoRotate: true } } });
  f.observe('codex', [10, 99.5]);
  await f.service.tick();
  assert.deepEqual(f.switches, [['codex', 'c', true]]);
  const events = f.events();
  // c was read and then verified with a keep-alive; the second reading showed the same figures and is not repeated.
  assert.deepEqual(events.map(e => [e.type, e.type === 'reading' ? `${e.account.id}:${e.source}:${e.active}` : e.reason]),
    [['reading', 'a:status:true'], ['reading', 'b:rotation:false'], ['reading', 'c:rotation:false'], ['switch', 'limit']]);
  const sw = events[3];
  assert.deepEqual([sw.from, sw.to, sw.automatic, sw.calls, sw.stayedMs], [{ id: 'a', name: 'a' }, { id: 'c', name: 'c' }, true, 3, undefined]);
  assert.deepEqual(sw.settings, { strategy: 'sequential', trigger: 'limit', fiveHourThresholdPercent: 99.5, weeklyThresholdPercent: 99.5 });
  assert.deepEqual(sw.fromUsage.windows.map(w => w.usedPercent), [10, 99.5]);
  assert.deepEqual(sw.toUsage.windows.map(w => w.usedPercent), [20, 20]);
  assert.deepEqual(sw.candidates.map(c => [c.account.id, c.usable, c.outcome, c.usage?.windows.map(w => w.usedPercent)]),
    [['b', false, 'ineligible', [99.5, 5]], ['c', false, 'chosen', [20, 20]]]);
});

test('the history gets one exhausted event per stretch with every account at its limit, and its recovery', async t => {
  const f = fixture(t, { history: true, values: { a: [10, 97], b: [10, 98], c: [10, 100] },
    settings: { codex: { autoRotate: true, fiveHourThresholdPercent: 100, weeklyThresholdPercent: 90 } } });
  const notices = [];
  f.service.onNoCandidate = () => notices.push(1);
  f.observeAll('codex');
  await f.service.tick();
  let events = f.events().filter(e => e.type !== 'reading');
  assert.equal(events.length, 1);
  assert.deepEqual([events[0].type, events[0].active.id, events[0].reached, typeof events[0].nextCandidateAt],
    ['exhausted', 'a', [{ label: '7d', usedPercent: 97, threshold: 90 }], 'string']);
  // Both candidates were still at their limit by their stored readings, so nothing was spent on them.
  assert.deepEqual(events[0].candidates.map(c => [c.account.id, c.outcome]), [['b', 'limited'], ['c', 'limited']]);
  // Another sweep in the same stretch adds nothing; the stretch ends when the active account reads below its thresholds.
  f.advance(20 * 60000);
  f.observe('codex', [10, 97]);
  await f.service.tick();
  assert.equal(f.events().filter(e => e.type !== 'reading').length, 1);
  f.advance(60 * 60000);
  f.observe('codex', [10, 50]);
  await f.service.tick();
  events = f.events().filter(e => e.type !== 'reading');
  assert.deepEqual(events.map(e => e.type), ['exhausted', 'recovered']);
  assert.deepEqual([events[1].by, events[1].afterMs, events[1].active.id], ['reset', 80 * 60000, 'a']);
  // Reaching the limit again starts a new stretch, which is reported again.
  f.advance(60 * 60000);
  f.observe('codex', [10, 97]);
  await f.service.tick();
  assert.equal(f.events().filter(e => e.type === 'exhausted').length, 2);
  assert.equal(notices.length, 2);
});

test('the history records a check when it starts failing and when it works again', async t => {
  const f = fixture(t, { history: true, values: { a: [10, 10], b: [10, 10], c: [10, 10] },
    keepAliveErrors: { b: 'Keep-alive CLI exited with code 1: Your workspace is out of credits.' }, settings: { codex: { enabled: true } } });
  await f.service.tick();
  f.options.keepAliveErrors = {};
  f.advance(6 * 3600000);
  await f.service.tick();
  const checks = f.events().filter(e => e.type === 'check');
  assert.deepEqual(checks.map(c => [c.account.id, c.ok, c.keepAlive, c.problem]), [['b', false, true, 'Insufficient credits'], ['b', true, true, undefined]]);
  assert.equal(checks[0].error, 'Keep-alive CLI exited with code 1: Your workspace is out of credits.');
  // Three accounts read twice, six hours apart: unchanged figures are repeated after an hour.
  assert.equal(f.events().filter(e => e.type === 'reading').length, 6);
});

test('a sweep that spends calls without switching is recorded with what it found', async t => {
  const f = fixture(t, { history: true, ids: ['a', 'b', 'c', 'd', 'e'], values: afternoon,
    settings: { claude: { autoRotate: true, strategy: 'evenPace', trigger: 'proactive', minStayMs: 0 } } });
  f.active.claude = 'c';
  f.observeAll('claude');
  f.values.e = [['5h', 53, 4], ['7d', 95, 96], ['7d Fable', 95, 96]];
  await f.service.tick();
  assert.deepEqual(f.switches, []);
  const sweeps = f.events().filter(e => e.type === 'sweep');
  assert.equal(sweeps.length, 1);
  assert.deepEqual([sweeps[0].outcome, sweeps[0].active.id, sweeps[0].calls, sweeps[0].settings.strategy, sweeps[0].settings.minStayMinutes],
    ['noBetterCandidate', 'c', 1, 'evenPace', 0]);
  const e = sweeps[0].candidates.find(c => c.account.id === 'e');
  assert.deepEqual([e.outcome, e.usable, typeof e.score, typeof e.freshScore, e.usage.windows[1].usedPercent], ['notBetter', true, 'number', 'number', 95]);
  assert.ok(sweeps[0].candidates.filter(c => c.account.id !== 'e').every(c => c.outcome === 'notBetter' && c.usage === undefined));
});

test('a proactive switch is recorded with the stay it ended', async t => {
  const f = fixture(t, { history: true, ids: ['a', 'b', 'c', 'd', 'e'], values: afternoon,
    settings: { claude: { autoRotate: true, strategy: 'evenPace', trigger: 'proactive', minStayMs: 30 * 60000 } } });
  f.active.claude = 'c';
  f.observeAll('claude');
  await f.service.tick();
  f.advance(31 * 60000);
  f.observeAll('claude');
  await f.service.tick();
  assert.deepEqual(f.switches, [['claude', 'e', true]]);
  const sw = f.events().find(e => e.type === 'switch');
  assert.deepEqual([sw.reason, sw.from.id, sw.to.id, sw.stayedMs, sw.settings.trigger, sw.settings.minStayMinutes],
    ['proactive', 'c', 'e', 31 * 60000, 'proactive', 30]);
  assert.equal(sw.candidates.find(c => c.account.id === 'e').outcome, 'chosen');
  assert.equal(f.service.stayed('claude', 'e'), 0);
});

for (const provider of ['claude', 'codex']) for (const strategy of ['sequential', 'soonestReset', 'evenPace', 'leastWaste']) {
  test(`${provider} ${strategy}: diagnostics use the rotation scores without probing or switching`, async t => {
    const f = fixture(t, { values: { a: [20, ['7d', 30, 48]], b: [10, ['7d', 10, 24]], c: [10, ['7d', 20, 72]] },
      settings: { [provider]: { strategy, autoRotate: false, trigger: 'proactive' } } });
    f.observeAll(provider);
    const diagnostic = f.service.diagnostics(provider);
    assert.equal(diagnostic.strategy, strategy); assert.match(diagnostic.reason, /disabled/);
    assert.equal(diagnostic.candidates.length, 3); assert.equal(f.calls.length, 0); assert.equal(f.switches.length, 0);
    for (const candidate of diagnostic.candidates) {
      assert.equal(candidate.score, rotationScore(strategy, f.service.usage(provider, candidate.id), Date.parse(diagnostic.evaluatedAt), f.settings[provider]));
    }
    assert.equal(diagnostic.candidates.find(c => c.id === 'a').active, true);
    if (strategy === 'sequential') assert.deepEqual(diagnostic.candidates.map(c => c.rank), [undefined, 1, 2]);
    f.settings[provider].autoRotate = true; f.settings[provider].trigger = 'limit';
    assert.match(f.service.diagnostics(provider).reason, /below.*thresholds/);
  });
}
test('diagnostics explain imminent resets, unknown accounts and failed checks', async t => {
  const f = fixture(t, { values: { a: [['5h', 100, 0.04], ['7d', 10, 72]], b: null, c: [10, 10] },
    settings: { codex: { strategy: 'leastWaste', autoRotate: false, resetAware: true } }, keepAliveErrors: { c: 'OAuth token expired' } });
  f.observeAll('codex'); await f.service.sendKeepAliveNow('codex', 'c'); f.settings.codex.autoRotate = true;
  const d = f.service.diagnostics('codex'); assert.match(d.reason, /Waiting.*reset/);
  assert.match(d.candidates.find(c => c.id === 'b').reason, /No usage/);
  assert.match(d.candidates.find(c => c.id === 'c').reason, /failed/);
});

test('independent account operations serialize while nested sweep checks reuse the lock', async t => {
  const f=fixture(t); const events=[]; let release;
  const wait=new Promise(resolve=>release=resolve);
  const first=f.service.withAccountLock('codex',async()=>{events.push('first');await f.service.withAccountLock('codex',async()=>events.push('nested'));await wait;events.push('first done');});
  await new Promise(resolve=>setImmediate(resolve));
  const second=f.service.withAccountLock('codex',async()=>events.push('second'));
  await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(events,['first','nested']);
  release();await Promise.all([first,second]);assert.deepEqual(events,['first','nested','first done','second']);
});
