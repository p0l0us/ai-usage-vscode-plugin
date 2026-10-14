const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const live = require('../out/live');
const { temporary, fixture, stubFetch, reply, fakeCli } = require('./fixtures/live/helpers');

const ACCOUNT = '11111111-2222-3333-4444-555555555555';

function claudeHome(root, credentials = { accessToken: 'tok-1', subscriptionType: 'max', rateLimitTier: 'default_claude_max_5x' }) {
  const dir = path.join(root, 'claude-home');
  fs.mkdirSync(dir, { recursive: true });
  if (credentials) {
    fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: credentials }));
  }
  return dir;
}

const ok = (result) => { assert.equal(result.kind, 'ok', JSON.stringify(result)); return result.usage; };

test('Claude usage API: fixture response maps to windows, model-scoped limits and plan', async (t) => {
  const home = claudeHome(temporary(t));
  const calls = stubFetch(t, () => reply(200, fixture('claudeUsage.json')));
  const observed = [];
  const usage = ok(await live.fetchClaudeUsage(home, { observe: (hint) => observed.push(hint) }));

  assert.deepEqual(usage.windows.map((w) => [w.label, w.usedPercent, w.resetsAt?.toISOString()]), [
    ['5h', 37.5, '2026-10-11T15:00:00.000Z'],
    ['7d', 12, '2026-10-16T09:00:00.000Z'],
    // Scoped limits need kind weekly_scoped, a model name and a numeric percent; the rest are ignored.
    ['7d Fable', 64, '2026-10-17T00:00:00.000Z']
  ]);
  assert.equal(usage.plan, 'default_claude_max_5x');
  assert.equal(usage.provider, 'claude');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.headers.Authorization, 'Bearer tok-1');
  assert.equal(calls[0].init.headers['anthropic-beta'], 'oauth-2025-04-20');
  assert.deepEqual(observed, [undefined], 'the observer hears about every response, even without rate-limit headers');
});

test('Claude usage API: plan falls back to the subscription type', async (t) => {
  const home = claudeHome(temporary(t), { accessToken: 'tok', subscriptionType: 'pro' });
  stubFetch(t, () => reply(200, { five_hour: { utilization: 1 } }));
  assert.equal(ok(await live.fetchClaudeUsage(home)).plan, 'pro');
});

const percentCases = [
  ['over 100 is clamped', 140, 100],
  ['negative is clamped to 0', -5, 0],
  ['zero stays zero', 0, 0],
  ['fraction is kept', 0.25, 0.25]
];
for (const [name, utilization, expected] of percentCases) {
  test(`Claude usage API: utilization ${name}`, async (t) => {
    const home = claudeHome(temporary(t));
    stubFetch(t, () => reply(200, { five_hour: { utilization, resets_at: null } }));
    const usage = ok(await live.fetchClaudeUsage(home));
    assert.equal(usage.windows[0].usedPercent, expected);
    assert.equal(usage.windows[0].resetsAt, undefined);
  });
}

const missingWindowBodies = [
  ['empty object', {}],
  ['null windows', { five_hour: null, seven_day: null }],
  ['string utilization', { five_hour: { utilization: '50' } }],
  ['null utilization', { five_hour: { utilization: null } }],
  ['empty limits array', { limits: [] }],
  ['array body with no windows', []],
  ['only unknown keys', { something_new: { utilization: 5 } }]
];
for (const [name, body] of missingWindowBodies) {
  test(`Claude usage API: ${name} reports no windows (non-transient)`, async (t) => {
    const home = claudeHome(temporary(t));
    stubFetch(t, () => reply(200, body));
    const result = await live.fetchClaudeUsage(home);
    assert.equal(result.kind, 'error');
    assert.equal(result.message, 'Usage response contained no rate-limit windows.');
    assert.equal(result.transient, undefined);
  });
}

test('Claude usage API: one missing window leaves the other and unknown keys are ignored', async (t) => {
  const home = claudeHome(temporary(t));
  stubFetch(t, () => reply(200, { seven_day: { utilization: 9, resets_at: '2026-10-16T09:00:00Z', brand_new: 1 }, five_hour: null, future_window: {} }));
  const usage = ok(await live.fetchClaudeUsage(home));
  assert.deepEqual(usage.windows.map((w) => w.label), ['7d']);
});

const resetFormats = [
  ['ISO with offset', '2026-10-11T17:00:00+02:00', '2026-10-11T15:00:00.000Z'],
  ['ISO with microseconds', '2026-10-11T15:00:00.123456+00:00', '2026-10-11T15:00:00.123Z'],
  ['HTTP-date string', 'Sun, 11 Oct 2026 15:00:00 GMT', '2026-10-11T15:00:00.000Z'],
  ['epoch seconds as number', 1791730800, '2026-10-11T15:00:00.000Z'],
  ['epoch milliseconds as number', 1791730800000, '2026-10-11T15:00:00.000Z'],
  ['garbage string', 'tomorrow-ish', undefined],
  ['empty string', '', undefined],
  ['null', null, undefined],
  ['boolean', true, undefined]
];
for (const [name, value, expected] of resetFormats) {
  test(`Claude usage API: resets_at ${name}`, async (t) => {
    const home = claudeHome(temporary(t));
    stubFetch(t, () => reply(200, { five_hour: { utilization: 5, resets_at: value } }));
    const usage = ok(await live.fetchClaudeUsage(home));
    assert.equal(usage.windows[0].resetsAt?.toISOString(), expected);
  });
}

test('Claude usage API: NaN-like utilization strings are not windows', async (t) => {
  const home = claudeHome(temporary(t));
  // JSON cannot carry NaN/Infinity as numbers; the parser must not accept their string forms either.
  stubFetch(t, () => reply(200, '{"five_hour":{"utilization":"NaN"},"seven_day":{"utilization":1e999}}'));
  const result = await live.fetchClaudeUsage(home);
  // 1e999 parses to Infinity, which is not finite and must be dropped.
  assert.equal(result.kind, 'error');
});

test('Claude usage API: no credentials is unavailable without a request', async (t) => {
  const calls = stubFetch(t, () => reply(200, {}));
  for (const credentials of [null, { accessToken: '' }, { accessToken: 5 }]) {
    const home = claudeHome(temporary(t), credentials);
    assert.deepEqual(await live.fetchClaudeUsage(home), { kind: 'unavailable', provider: 'claude' });
  }
  assert.equal(calls.length, 0);
});

test('Claude usage API: corrupt credentials file is unavailable', async (t) => {
  const home = claudeHome(temporary(t), null);
  fs.writeFileSync(path.join(home, '.credentials.json'), '{not json');
  assert.equal((await live.fetchClaudeUsage(home)).kind, 'unavailable');
});

test('Claude usage API: expired token fails before any request', async (t) => {
  const calls = stubFetch(t, () => reply(200, {}));
  const home = claudeHome(temporary(t), { accessToken: 'tok', expiresAt: Date.now() - 1000 });
  const result = await live.fetchClaudeUsage(home);
  assert.deepEqual(result, { kind: 'error', provider: 'claude', title: 'Claude', message: 'Login token expired. Run `claude` once to refresh it.' });
  assert.equal(calls.length, 0);
});

test('Claude usage API: a non-numeric expiresAt is ignored', async (t) => {
  const home = claudeHome(temporary(t), { accessToken: 'tok', expiresAt: '2020-01-01' });
  stubFetch(t, () => reply(200, { five_hour: { utilization: 2 } }));
  assert.equal(ok(await live.fetchClaudeUsage(home)).windows.length, 1);
});

for (const status of [401, 403]) {
  test(`Claude usage API: HTTP ${status} asks for a new sign-in and is not transient`, async (t) => {
    const home = claudeHome(temporary(t));
    stubFetch(t, () => reply(status, { error: 'nope' }));
    const result = await live.fetchClaudeUsage(home);
    assert.deepEqual(result, {
      kind: 'error', provider: 'claude', title: 'Claude', message: 'Not authorized. Run `claude` once to sign in again.',
      status, transient: false, retryAfterMs: undefined
    });
  });
}

test('Claude usage API: 429 reports Retry-After seconds and feeds the observer', async (t) => {
  const home = claudeHome(temporary(t));
  stubFetch(t, () => reply(429, '', { 'retry-after': '120', 'anthropic-ratelimit-requests-remaining': '0' }));
  const hints = [];
  const result = await live.fetchClaudeUsage(home, { observe: (hint) => hints.push(hint) });
  assert.deepEqual(result, {
    kind: 'error', provider: 'claude', title: 'Claude', message: 'Rate limited by the service.',
    status: 429, transient: true, retryAfterMs: 120_000
  });
  assert.deepEqual(hints, [{ remaining: 0, resetAt: undefined, retryAfterMs: 120_000 }]);
});

test('Claude usage API: 429 without Retry-After has no wait', async (t) => {
  const home = claudeHome(temporary(t));
  stubFetch(t, () => reply(429, { error: 'slow down' }));
  const result = await live.fetchClaudeUsage(home);
  assert.equal(result.transient, true);
  assert.equal(result.retryAfterMs, undefined);
});

test('Claude usage API: 429 with an HTTP-date Retry-After becomes a positive wait', async (t) => {
  const home = claudeHome(temporary(t));
  const when = new Date(Date.now() + 90_000).toUTCString();
  stubFetch(t, () => reply(429, '', { 'retry-after': when }));
  const result = await live.fetchClaudeUsage(home);
  assert.ok(result.retryAfterMs > 60_000 && result.retryAfterMs <= 90_000, String(result.retryAfterMs));
});

for (const [status, transient] of [[500, true], [502, true], [503, true], [400, false], [404, false], [418, false], [204, false]]) {
  test(`Claude usage API: HTTP ${status} is ${transient ? '' : 'not '}transient`, async (t) => {
    const home = claudeHome(temporary(t));
    stubFetch(t, () => reply(status, status === 204 ? undefined : { error: 'x' }));
    const result = await live.fetchClaudeUsage(home);
    assert.equal(result.kind, 'error');
    assert.equal(result.status, status);
    assert.equal(result.transient, transient);
    assert.equal(result.message, `Unexpected response (HTTP ${status}).`);
  });
}

test('Claude usage API: 200 with an empty, text or JSON-null body is an unexpected response', async (t) => {
  const home = claudeHome(temporary(t));
  for (const body of ['', 'plain text, not json', 'null']) {
    stubFetch(t, () => reply(200, body));
    const result = await live.fetchClaudeUsage(home);
    assert.equal(result.kind, 'error', body);
    // A text body parses to a string and an empty body to undefined; neither is an object.
    assert.equal(result.message, 'Unexpected response (HTTP 200).', body);
    assert.equal(result.transient, false);
  }
});

test('Claude usage API: network errors are transient with the cause in the message', async (t) => {
  const home = claudeHome(temporary(t));
  stubFetch(t, () => { throw new TypeError('fetch failed: ECONNRESET'); });
  assert.deepEqual(await live.fetchClaudeUsage(home), {
    kind: 'error', provider: 'claude', title: 'Claude', message: 'Request failed: fetch failed: ECONNRESET', transient: true
  });
});

test('Claude usage API: a non-Error rejection is stringified', async (t) => {
  const home = claudeHome(temporary(t));
  stubFetch(t, () => { throw 'socket closed'; });
  assert.equal((await live.fetchClaudeUsage(home)).message, 'Request failed: socket closed');
});

test('Claude usage API: the 10 second timeout aborts the request and reads as "timed out"', async (t) => {
  const home = claudeHome(temporary(t));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  stubFetch(t, (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => {
      const error = new Error('This operation was aborted');
      error.name = 'AbortError';
      reject(error);
    });
  }));
  const pending = live.fetchClaudeUsage(home);
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(10_000);
  assert.deepEqual(await pending, {
    kind: 'error', provider: 'claude', title: 'Claude', message: 'Request failed: timed out', transient: true
  });
});

test('parseRateLimitHeaders handles counts, RFC 3339 / epoch resets and Retry-After', () => {
  const now = Date.parse('2026-10-11T12:00:00Z');
  const hint = (init) => live.parseRateLimitHeaders(new Headers(init), now);
  assert.equal(hint({}), undefined);
  assert.deepEqual(hint({ 'anthropic-ratelimit-requests-remaining': '7', 'anthropic-ratelimit-requests-reset': '2026-10-11T12:01:00Z' }),
    { remaining: 7, resetAt: Date.parse('2026-10-11T12:01:00Z'), retryAfterMs: undefined });
  assert.deepEqual(hint({ 'anthropic-ratelimit-requests-reset': '1791720060' }),
    { remaining: undefined, resetAt: 1791720060_000, retryAfterMs: undefined });
  assert.deepEqual(hint({ 'retry-after': 'Sun, 11 Oct 2026 12:00:30 GMT' }),
    { remaining: undefined, resetAt: undefined, retryAfterMs: 30_000 });
  // Negative, fractional or non-numeric remaining counts are not a count.
  assert.equal(hint({ 'anthropic-ratelimit-requests-remaining': '-1' }), undefined);
  assert.equal(hint({ 'anthropic-ratelimit-requests-remaining': '2.5' }), undefined);
  assert.equal(hint({ 'anthropic-ratelimit-requests-remaining': 'many' }), undefined);
  assert.equal(hint({ 'anthropic-ratelimit-requests-reset': 'soonish' }), undefined);
});

test('parseRetryAfterHeader: seconds, dates in the past, junk and absence', () => {
  const now = Date.parse('2026-10-11T12:00:00Z');
  assert.equal(live.parseRetryAfterHeader(null, now), undefined);
  assert.equal(live.parseRetryAfterHeader('', now), undefined);
  assert.equal(live.parseRetryAfterHeader('0', now), 0);
  assert.equal(live.parseRetryAfterHeader('1.5', now), 1500);
  assert.equal(live.parseRetryAfterHeader('-30', now), 0);
  assert.equal(live.parseRetryAfterHeader('Sun, 11 Oct 2026 11:00:00 GMT', now), 0);
  assert.equal(live.parseRetryAfterHeader('Sun, 11 Oct 2026 12:02:00 GMT', now), 120_000);
  assert.equal(live.parseRetryAfterHeader('later', now), undefined);
});

// --- account file cache ---------------------------------------------------------------------

function accountFile(root, data) {
  const file = path.join(root, '.claude.json');
  fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data));
  return file;
}

const future = (ms) => new Date(Date.now() + ms).toISOString();

test('account file: a current cache for the active account is read with its own timestamp', async (t) => {
  const root = temporary(t);
  const home = claudeHome(root);
  const fetchedAtMs = Date.now() - 5 * 60_000;
  const file = accountFile(root, {
    oauthAccount: { accountUuid: ACCOUNT },
    cachedUsageUtilization: { fetchedAtMs, accountUuid: ACCOUNT, utilization: {
      five_hour: { utilization: 61, resets_at: future(3600_000) },
      limits: [{ kind: 'weekly_scoped', percent: 100.5, resets_at: future(86400_000), scope: { model: { display_name: 'Fable' } } }]
    } }
  });
  const usage = ok(await live.fetchClaudeUsageFromAccountFile(file, home));
  assert.equal(usage.fetchedAt.getTime(), fetchedAtMs);
  assert.deepEqual(usage.windows.map((w) => [w.label, w.usedPercent]), [['5h', 61], ['7d Fable', 100]]);
  assert.equal(usage.plan, 'default_claude_max_5x');
});

const cacheProblems = [
  ['file missing', undefined, /has not cached a usage reading yet/, true],
  ['file is not JSON', '{oops', /has not cached a usage reading yet/, true],
  ['no cache key', { oauthAccount: { accountUuid: ACCOUNT } }, /has not cached a usage reading yet/, true],
  ['cache without utilization', { oauthAccount: { accountUuid: ACCOUNT }, cachedUsageUtilization: { fetchedAtMs: 1, accountUuid: ACCOUNT, utilization: null } }, /has not cached/, true],
  ['cache without numeric fetchedAtMs', { oauthAccount: { accountUuid: ACCOUNT }, cachedUsageUtilization: { fetchedAtMs: '1', accountUuid: ACCOUNT, utilization: { five_hour: { utilization: 1 } } } }, /has not cached/, true],
  ['cache belongs to another account', { oauthAccount: { accountUuid: ACCOUNT }, cachedUsageUtilization: { fetchedAtMs: 1, accountUuid: 'ffffffff-0000-0000-0000-000000000000', utilization: { five_hour: { utilization: 1 } } } }, /previous account/, true],
  ['no active account in the file', { cachedUsageUtilization: { fetchedAtMs: 1, accountUuid: null, utilization: { five_hour: { utilization: 1 } } } }, /previous account/, true],
  ['cache has no windows', { oauthAccount: { accountUuid: ACCOUNT }, cachedUsageUtilization: { fetchedAtMs: 1, accountUuid: ACCOUNT, utilization: { five_hour: null } } }, /Cached usage contained no rate-limit windows/, undefined],
  ['a cached window already reset', { oauthAccount: { accountUuid: ACCOUNT }, cachedUsageUtilization: { fetchedAtMs: 1, accountUuid: ACCOUNT, utilization: { five_hour: { utilization: 99, resets_at: '2020-01-01T00:00:00Z' } } } }, /new quota window/, true]
];
for (const [name, data, message, transient] of cacheProblems) {
  test(`account file: ${name}`, async (t) => {
    const root = temporary(t);
    const home = claudeHome(root);
    const file = data === undefined ? path.join(root, 'absent.json') : accountFile(root, data);
    const result = await live.fetchClaudeUsageFromAccountFile(file, home);
    assert.equal(result.kind, 'error');
    assert.match(result.message, message);
    assert.equal(result.transient, transient);
  });
}

test('account file: missing credentials is unavailable', async (t) => {
  const root = temporary(t);
  const file = accountFile(root, { oauthAccount: { accountUuid: ACCOUNT } });
  assert.deepEqual(await live.fetchClaudeUsageFromAccountFile(file, claudeHome(root, null)), { kind: 'unavailable', provider: 'claude' });
});

// --- /usage CLI ----------------------------------------------------------------------------

function cliFixture(t, { cache = true } = {}) {
  const root = temporary(t);
  const home = claudeHome(root);
  const file = accountFile(root, { oauthAccount: { accountUuid: ACCOUNT } });
  const writer = `
const fs = require('fs');
const data = JSON.parse(fs.readFileSync(${JSON.stringify(file)}, 'utf8'));
data.cachedUsageUtilization = { fetchedAtMs: Date.now(), accountUuid: ${JSON.stringify(ACCOUNT)},
  utilization: { five_hour: { utilization: 12, resets_at: ${JSON.stringify(future(3600_000))} } } };
fs.writeFileSync(${JSON.stringify(file)}, JSON.stringify(data));`;
  return { root, home, file, writer: cache ? writer : '' };
}

test('Claude CLI: no credentials is unavailable and a missing binary is a configuration error', async (t) => {
  const root = temporary(t);
  const file = accountFile(root, {});
  assert.deepEqual(await live.fetchClaudeUsageCli('claude', claudeHome(root, null), file), { kind: 'unavailable', provider: 'claude' });
  const result = await live.fetchClaudeUsageCli(path.join(root, 'no-such-claude'), claudeHome(root), file);
  assert.equal(result.kind, 'error');
  assert.match(result.message, /^Claude CLI ".*no-such-claude" not found\. Set aiUsage\.claude\.cliPath/);
});

test('Claude CLI: passes the headless /usage arguments and tags the reading with its source', async (t) => {
  const f = cliFixture(t);
  const cli = fakeCli(f.root, `${f.writer}\nrequire('fs').writeFileSync(${JSON.stringify(path.join(f.root, 'argv.json'))}, JSON.stringify(process.argv.slice(2)));`);
  const usage = ok(await live.fetchClaudeUsageCli(cli, f.home, f.file));
  assert.deepEqual(usage.details, ['Source: Claude Code CLI (/usage)']);
  assert.equal(usage.windows[0].usedPercent, 12);
  const argv = JSON.parse(fs.readFileSync(path.join(f.root, 'argv.json'), 'utf8'));
  assert.equal(argv[0], '--print');
  assert.equal(argv.at(-1), '/usage');
  assert.ok(argv.includes('--no-session-persistence'));
});

test('Claude CLI: ANSI-decorated output explains a missing cache using its first non-blank line', async (t) => {
  const f = cliFixture(t, { cache: false });
  const cli = fakeCli(f.root, `process.stdout.write('\\n   \\r\\n\\u001b[31mError: not logged in\\u001b[0m\\nsecond line\\n');`);
  const result = await live.fetchClaudeUsageCli(cli, f.home, f.file);
  assert.equal(result.kind, 'error');
  assert.equal(result.transient, true);
  // Escape sequences are passed through untouched; the message keeps the raw first line.
  assert.equal(result.message, 'Claude CLI /usage: Error: not logged in');
});

test('Claude CLI: empty output and no cache gives the generic message; long lines are cut to 200 chars', async (t) => {
  const f = cliFixture(t, { cache: false });
  const quiet = await live.fetchClaudeUsageCli(fakeCli(f.root, '', 'quiet'), f.home, f.file);
  assert.equal(quiet.message, 'Claude CLI ran /usage but cached no usage reading.');
  const long = await live.fetchClaudeUsageCli(fakeCli(f.root, `console.log('x'.repeat(500));`, 'long'), f.home, f.file);
  assert.equal(long.message, `Claude CLI /usage: ${'x'.repeat(200)}`);
});

test('Claude CLI: a non-zero exit reports the stdout line and the exit code', async (t) => {
  const f = cliFixture(t);
  const cli = fakeCli(f.root, `console.log('Invalid API key'); process.exit(2);`);
  assert.deepEqual(await live.fetchClaudeUsageCli(cli, f.home, f.file), {
    kind: 'error', provider: 'claude', title: 'Claude', message: 'Claude CLI: Invalid API key (exit 2)', transient: true
  });
});

test('Claude CLI: a non-zero exit falls back to stderr, then to the bare exit code', async (t) => {
  const f = cliFixture(t);
  const viaStderr = await live.fetchClaudeUsageCli(fakeCli(f.root, `console.error('  network down  '); process.exit(1);`, 'e1'), f.home, f.file);
  assert.equal(viaStderr.message, 'Claude CLI: network down (exit 1)');
  const silent = await live.fetchClaudeUsageCli(fakeCli(f.root, `process.exit(7);`, 'e2'), f.home, f.file);
  assert.equal(silent.message, 'Claude CLI: exited with code 7');
});

test('Claude CLI: a stale cache left by a succeeding command is reported as an error, not served', async (t) => {
  const f = cliFixture(t, { cache: false });
  fs.writeFileSync(f.file, JSON.stringify({ oauthAccount: { accountUuid: ACCOUNT }, cachedUsageUtilization: {
    fetchedAtMs: 1, accountUuid: ACCOUNT, utilization: { five_hour: { utilization: 5, resets_at: '2020-01-01T00:00:00Z' } } } }));
  const result = await live.fetchClaudeUsageCli(fakeCli(f.root, `console.log('Current session: 5%');`), f.home, f.file);
  assert.equal(result.kind, 'error');
  assert.equal(result.message, 'Claude CLI /usage: Current session: 5%');
});
