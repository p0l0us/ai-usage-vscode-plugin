const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const live = require('../out/live');
const { temporary, fixture, jwt, stubFetch, reply, fakeCodex } = require('./fixtures/live/helpers');

const NOW_S = Math.floor(Date.now() / 1000);

function codexHome(root, tokens = { access_token: jwt({ exp: NOW_S + 3600, 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-1', chatgpt_plan_type: 'team' } }) }) {
  const dir = path.join(root, 'codex-home');
  fs.mkdirSync(dir, { recursive: true });
  if (tokens) {
    fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ tokens }));
  }
  return dir;
}

const ok = (result) => { assert.equal(result.kind, 'ok', JSON.stringify(result)); return result.usage; };

// --- wham usage API ---------------------------------------------------------------------------

test('Codex API: fixture response maps windows by duration and clamps', async (t) => {
  const home = codexHome(temporary(t));
  const calls = stubFetch(t, () => reply(200, fixture('codexWham.json')));
  const usage = ok(await live.fetchCodexUsage(home));
  assert.deepEqual(usage.windows.map((w) => [w.label, w.usedPercent, w.resetsAt.toISOString()]), [
    ['5h', 41, '2026-10-11T15:00:00.000Z'],
    ['7d', 100, '2026-10-17T15:20:00.000Z']
  ]);
  assert.equal(usage.plan, 'plus', 'the response plan wins over the token claim');
  assert.equal(calls[0].init.headers['ChatGPT-Account-Id'], 'acct-1');
  assert.match(calls[0].init.headers.Authorization, /^Bearer ey/);
});

test('Codex API: plan falls back to the token claim; account id comes from tokens.account_id first', async (t) => {
  const access = jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'from-jwt', chatgpt_plan_type: 'team' } });
  const home = codexHome(temporary(t), { access_token: access, account_id: 'explicit-id' });
  const calls = stubFetch(t, () => reply(200, { rate_limit: { primary_window: { used_percent: 5 } } }));
  const usage = ok(await live.fetchCodexUsage(home));
  assert.equal(usage.plan, 'team');
  assert.equal(calls[0].init.headers['ChatGPT-Account-Id'], 'explicit-id');
  // No duration means the generic label; no reset means no date.
  assert.deepEqual(usage.windows, [{ label: 'limit', usedPercent: 5, resetsAt: undefined }]);
});

test('Codex API: id_token claims take precedence and a missing account id sends no header', async (t) => {
  const home = codexHome(temporary(t), {
    access_token: 'opaque-token-without-dots',
    id_token: jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'from-id-token', chatgpt_plan_type: 'pro' } })
  });
  const calls = stubFetch(t, () => reply(200, { rate_limit: { secondary_window: { used_percent: 1, limit_window_seconds: 5400 } } }));
  const usage = ok(await live.fetchCodexUsage(home));
  assert.equal(calls[0].init.headers['ChatGPT-Account-Id'], 'from-id-token');
  assert.equal(usage.plan, 'pro');
  assert.equal(usage.windows[0].label, '90m', 'durations that are not whole hours are shown in minutes');
  const bare = codexHome(temporary(t), { access_token: 'opaque' });
  const calls2 = stubFetch(t, () => reply(200, { rate_limit: { primary_window: { used_percent: 1 } } }));
  ok(await live.fetchCodexUsage(bare));
  assert.equal('ChatGPT-Account-Id' in calls2[0].init.headers, false);
});

const windowLabels = [[18000, '5h'], [604800, '7d'], [86400, '1d'], [3600, '1h'], [1800, '30m'], [90, '2m'], [0, 'limit'], [-5, 'limit']];
for (const [seconds, label] of windowLabels) {
  test(`Codex API: limit_window_seconds ${seconds} is labelled ${label}`, async (t) => {
    const home = codexHome(temporary(t));
    stubFetch(t, () => reply(200, { rate_limit: { primary_window: { used_percent: 1, limit_window_seconds: seconds } } }));
    assert.equal(ok(await live.fetchCodexUsage(home)).windows[0].label, label);
  });
}

const codexEmptyBodies = [
  ['no rate_limit', {}], ['null rate_limit', { rate_limit: null }],
  ['null windows', { rate_limit: { primary_window: null, secondary_window: null } }],
  ['non-numeric percent', { rate_limit: { primary_window: { used_percent: '40' } } }]
];
for (const [name, body] of codexEmptyBodies) {
  test(`Codex API: ${name} reports no windows`, async (t) => {
    const home = codexHome(temporary(t));
    stubFetch(t, () => reply(200, body));
    const result = await live.fetchCodexUsage(home);
    assert.equal(result.kind, 'error');
    assert.equal(result.message, 'Usage response contained no rate-limit windows.');
  });
}

test('Codex API: unavailable without auth, error for an expired token, no request either way', async (t) => {
  const calls = stubFetch(t, () => reply(200, {}));
  const root = temporary(t);
  assert.deepEqual(await live.fetchCodexUsage(codexHome(root, null)), { kind: 'unavailable', provider: 'codex' });
  const expired = codexHome(temporary(t), { access_token: jwt({ exp: NOW_S - 60 }) });
  assert.deepEqual(await live.fetchCodexUsage(expired), {
    kind: 'error', provider: 'codex', title: 'Codex', message: 'Login token expired. Run `codex` once to refresh it.'
  });
  assert.equal(calls.length, 0);
});

for (const status of [401, 403]) {
  test(`Codex API: HTTP ${status} asks for codex login`, async (t) => {
    stubFetch(t, () => reply(status, 'denied'));
    const result = await live.fetchCodexUsage(codexHome(temporary(t)));
    assert.equal(result.message, 'Not authorized. Run `codex login` to sign in again.');
    assert.equal(result.transient, false);
    assert.equal(result.status, status);
  });
}

for (const [status, headers, transient, retryAfterMs] of [
  [429, { 'retry-after': '30' }, true, 30_000], [429, {}, true, undefined], [503, {}, true, undefined], [404, {}, false, undefined]]) {
  test(`Codex API: HTTP ${status}${headers['retry-after'] ? ' with Retry-After' : ''}`, async (t) => {
    stubFetch(t, () => reply(status, '', headers));
    const result = await live.fetchCodexUsage(codexHome(temporary(t)));
    assert.equal(result.kind, 'error');
    assert.equal(result.transient, transient);
    assert.equal(result.retryAfterMs, retryAfterMs);
    assert.equal(result.message, status === 429 ? 'Rate limited by the service.' : `Unexpected response (HTTP ${status}).`);
  });
}

test('Codex API: network failure and invalid JSON body', async (t) => {
  const home = codexHome(temporary(t));
  stubFetch(t, () => { throw new Error('ENOTFOUND chatgpt.com'); });
  assert.deepEqual(await live.fetchCodexUsage(home), {
    kind: 'error', provider: 'codex', title: 'Codex', message: 'Request failed: ENOTFOUND chatgpt.com', transient: true
  });
  stubFetch(t, () => reply(200, '<html>maintenance</html>'));
  assert.equal((await live.fetchCodexUsage(home)).message, 'Unexpected response (HTTP 200).');
});

// --- session log ----------------------------------------------------------------------------

function sessionRoot(t) {
  const root = temporary(t);
  const home = codexHome(root, null);
  const original = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  t.after(() => { if (original === undefined) { delete process.env.CODEX_HOME; } else { process.env.CODEX_HOME = original; } });
  return path.join(home, 'sessions');
}

function writeLog(dir, name, text, mtime) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, text);
  if (mtime) { fs.utimesSync(file, new Date(mtime), new Date(mtime)); }
  return file;
}

const record = (timestamp, primary, secondary, extra = {}) => JSON.stringify({
  timestamp, type: 'event_msg', payload: { type: 'token_count', rate_limits: { primary, secondary, ...extra } }
});

test('Codex session log: the fixture yields the last complete record, skipping prose, empty and truncated lines', async (t) => {
  const sessions = sessionRoot(t);
  writeLog(path.join(sessions, '2026', '10', '11'), 'rollout-a.jsonl', fixture('codexSession.jsonl'));
  const usage = ok(await live.fetchCodexUsageFromSessionLog());
  assert.deepEqual(usage.windows.map((w) => [w.label, w.usedPercent, w.resetsAt.toISOString()]), [
    ['5h', 22, '2026-10-11T15:00:00.000Z'],
    ['7d', 4, '2026-10-17T15:20:00.000Z']
  ]);
  assert.equal(usage.plan, 'pro');
  assert.equal(usage.fetchedAt.toISOString(), '2026-10-11T08:05:00.000Z', 'the reading is as old as the record');
  assert.match(usage.details[0], /^Source: Codex session log \(recorded /);
});

test('Codex session log: no sessions directory is unavailable; no records is an error', async (t) => {
  const sessions = sessionRoot(t);
  assert.deepEqual(await live.fetchCodexUsageFromSessionLog(), { kind: 'unavailable', provider: 'codex', reason: 'No Codex session logs found.' });
  writeLog(sessions, 'empty.jsonl', '');
  writeLog(sessions, 'chatter.jsonl', '{"type":"event_msg","payload":{"message":"hello"}}\nnot json at all\n');
  const result = await live.fetchCodexUsageFromSessionLog();
  assert.equal(result.kind, 'error');
  assert.match(result.message, /^No rate-limit records in recent Codex session logs/);
});

test('Codex session log: a newer record in an older-mtime file wins; older files are still considered', async (t) => {
  const sessions = sessionRoot(t);
  const base = Date.parse('2026-10-11T10:00:00Z');
  writeLog(sessions, 'newer-mtime.jsonl', record('2026-10-11T08:00:00Z', { used_percent: 10, window_minutes: 300 }) + '\n', base + 60_000);
  writeLog(sessions, 'older-mtime.jsonl', record('2026-10-11T09:30:00Z', { used_percent: 55, window_minutes: 300 }) + '\n', base);
  const usage = ok(await live.fetchCodexUsageFromSessionLog());
  assert.equal(usage.windows[0].usedPercent, 55);
});

test('Codex session log: only the six most recently modified files are inspected', async (t) => {
  const sessions = sessionRoot(t);
  const base = Date.now() - 100_000_000;
  // The seventh-newest file holds the newest record but is never opened.
  writeLog(sessions, 'seventh.jsonl', record('2026-12-01T00:00:00Z', { used_percent: 99, window_minutes: 300 }) + '\n', base);
  for (let index = 1; index <= 6; index++) {
    writeLog(sessions, `f${index}.jsonl`, record(`2026-10-0${index}T00:00:00Z`, { used_percent: index, window_minutes: 300 }) + '\n', base + index * 1000);
  }
  assert.equal(ok(await live.fetchCodexUsageFromSessionLog()).windows[0].usedPercent, 6);
});

test('Codex session log: file mtime cannot supply a missing event timestamp', async (t) => {
  const sessions = sessionRoot(t);
  const mtime = Date.parse('2026-10-10T10:00:00Z');
  writeLog(sessions, 'a.jsonl', JSON.stringify({ payload: { rate_limits: { primary: { used_percent: 7, window_minutes: 300 } } } }) + '\n', mtime);
  assert.equal((await live.fetchCodexUsageFromSessionLog()).kind, 'error');
});

test('Codex session tails handle unchanged files, split appends, truncation and replacement', async t => {
  const sessions = sessionRoot(t), file = path.join(sessions, 'a.jsonl');
  const first = record('2026-10-10T10:00:00Z', { used_percent: 10, window_minutes: 300 }) + '\n';
  const next = record('2026-10-10T11:00:00Z', { used_percent: 20, window_minutes: 300 }) + '\n';
  writeLog(sessions, 'a.jsonl', first);
  assert.equal(ok(await live.fetchCodexUsageFromSessionLog()).windows[0].usedPercent, 10);
  assert.equal(ok(await live.fetchCodexUsageFromSessionLog()).windows[0].usedPercent, 10);
  fs.appendFileSync(file, next.slice(0, -8));
  assert.equal(ok(await live.fetchCodexUsageFromSessionLog()).windows[0].usedPercent, 10);
  fs.appendFileSync(file, next.slice(-8));
  assert.equal(ok(await live.fetchCodexUsageFromSessionLog()).windows[0].usedPercent, 20);
  fs.writeFileSync(file, first);
  assert.equal(ok(await live.fetchCodexUsageFromSessionLog()).windows[0].usedPercent, 10);
  fs.renameSync(file, path.join(sessions, 'old.txt')); fs.writeFileSync(file, next);
  assert.equal(ok(await live.fetchCodexUsageFromSessionLog()).windows[0].usedPercent, 20);
});

test('Codex RPC completes initialized handshake and preserves retry errors without transport fallback', async t => {
  const root = temporary(t), home = codexHome(root);
  const cli = require('./fixtures/live/helpers').fakeCli(root, `
let initialized = false;
require('readline').createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') console.log(JSON.stringify({id:message.id,result:{}}));
  else if (message.method === 'initialized') initialized = true;
  else console.log(JSON.stringify({ id:message.id, error:{ code:-32001, message: initialized ? 'throttled' : 'handshake missing', data:{status:429,retryAfterMs:3600000,code:'rate_limited'} } }));
});`);
  const metrics = [];
  const result = await require('../out/requestDiagnostics').traceRequests(metric => metrics.push(metric), () => live.fetchCodexUsageCli(cli, home));
  assert.equal(metrics.filter(metric => metric === 'rpc').length, 2, 'initialize and rateLimits/read are separate RPC requests');
  assert.equal(metrics.filter(metric => metric === 'process').length, 1);
  assert.equal(result.kind, 'error'); assert.match(result.message, /throttled/);
  assert.equal(result.status, 429); assert.equal(result.retryAfterMs, 3600000); assert.equal(result.code, 'rate_limited');
  const verification = await live.verifyCodexNativeAccount({ tokens: { account_id: 'a' } }, cli, home);
  assert.equal(verification.status, 'unverified'); assert.equal(verification.errorStatus, 429);
  assert.equal(verification.retryAfterMs, 3600000);
});

test('Codex session log: windows without minutes are labelled "limit"; invalid ones are dropped; a plan comes from the record', async (t) => {
  const sessions = sessionRoot(t);
  writeLog(sessions, 'a.jsonl', record('2026-10-11T08:00:00Z', { used_percent: 150 }, { used_percent: 'x', window_minutes: 60 }, { plan_type: 'plus' }) + '\n');
  const usage = ok(await live.fetchCodexUsageFromSessionLog());
  assert.deepEqual(usage.windows, [{ label: 'limit', usedPercent: 100, resetsAt: undefined }]);
  assert.equal(usage.plan, 'plus');
});

test('Codex session log: a record whose windows are all unusable is an error', async (t) => {
  const sessions = sessionRoot(t);
  writeLog(sessions, 'a.jsonl', record('2026-10-11T08:00:00Z', { used_percent: null }, { window_minutes: 60 }) + '\n');
  assert.deepEqual(await live.fetchCodexUsageFromSessionLog(), {
    kind: 'error', provider: 'codex', title: 'Codex', message: 'Codex session log record had no usable windows.'
  });
});

test('Codex session log: only the last 512 KiB of a big log is scanned and a cut first line is tolerated', async (t) => {
  const sessions = sessionRoot(t);
  const old = record('2026-10-01T00:00:00Z', { used_percent: 1, window_minutes: 300 });
  const filler = JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'y'.repeat(2000) } });
  const tail = record('2026-10-11T08:00:00Z', { used_percent: 33, window_minutes: 300 });
  const body = [old, ...Array(300).fill(filler), tail].join('\n') + '\n';
  assert.ok(body.length > 512 * 1024);
  writeLog(sessions, 'big.jsonl', body);
  assert.equal(ok(await live.fetchCodexUsageFromSessionLog()).windows[0].usedPercent, 33);
  // With the recent record removed the old one is beyond the window and nothing is found.
  writeLog(sessions, 'big.jsonl', [old, ...Array(300).fill(filler)].join('\n') + '\n');
  assert.equal((await live.fetchCodexUsageFromSessionLog()).kind, 'error');
});

// --- app-server CLI ---------------------------------------------------------------------------

const limits = (extra = {}) => ({
  rateLimits: {
    primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1791730800 },
    secondary: { usedPercent: 60.5, windowDurationMins: 10080, resetsAt: 1792250400 },
    planType: 'pro'
  },
  ...extra
});

test('Codex CLI: parses app-server rate limits, plan and reset credits', async (t) => {
  const root = temporary(t);
  const home = codexHome(root);
  const cli = fakeCodex(root, { 'account/rateLimits/read': limits({ rateLimitResetCredits: {
    availableCount: 2, credits: [
      { status: 'available', expiresAt: 1792000000 }, { status: 'available', expiresAt: 1791800000 },
      { status: 'used', expiresAt: 1700000000 }, { status: 'available', expiresAt: null }] } }) });
  const usage = ok(await live.fetchCodexUsageCli(cli, home));
  assert.deepEqual(usage.windows.map((w) => [w.label, w.usedPercent, w.resetsAt.toISOString()]), [
    ['5h', 25, '2026-10-11T15:00:00.000Z'], ['7d', 60.5, '2026-10-17T15:20:00.000Z']]);
  assert.equal(usage.plan, 'pro');
  assert.deepEqual(usage.resetCredits, { availableCount: 2, totalCount: 2, earliestExpiresAt: 1791800000 });
  assert.deepEqual(usage.details, ['Source: Codex CLI (app-server)']);
});

test('Codex CLI: plan falls back to the auth token; no credit info leaves resetCredits undefined', async (t) => {
  const root = temporary(t);
  const home = codexHome(root);
  const cli = fakeCodex(root, { 'account/rateLimits/read': { rateLimits: { primary: { usedPercent: 3 } } } });
  const usage = ok(await live.fetchCodexUsageCli(cli, home));
  assert.equal(usage.plan, 'team');
  assert.equal(usage.resetCredits, undefined);
  assert.deepEqual(usage.windows, [{ label: 'limit', usedPercent: 3, resetsAt: undefined }]);
});

test('Codex CLI: unavailable without auth, error when the binary is missing', async (t) => {
  const root = temporary(t);
  assert.deepEqual(await live.fetchCodexUsageCli('codex', codexHome(root, null)), { kind: 'unavailable', provider: 'codex' });
  const result = await live.fetchCodexUsageCli(path.join(root, 'nope'), codexHome(root));
  assert.match(result.message, /^Codex CLI ".*nope" not found\. Set aiUsage\.codex\.cliPath/);
});

test('Codex CLI: no windows in the answer is a non-transient error', async (t) => {
  const root = temporary(t);
  const cli = fakeCodex(root, { 'account/rateLimits/read': { rateLimits: null } });
  assert.deepEqual(await live.fetchCodexUsageCli(cli, codexHome(root)), {
    kind: 'error', provider: 'codex', title: 'Codex', message: 'Codex CLI returned no rate-limit windows.'
  });
});

test('Codex CLI: an RPC error, an early exit and a missing result are transient errors', async (t) => {
  const root = temporary(t);
  const home = codexHome(root);
  const failing = await live.fetchCodexUsageCli(fakeCodex(root, { 'account/rateLimits/read': { error: 'not signed in' } }), home);
  assert.equal(failing.message, 'Codex CLI: account/rateLimits/read failed: not signed in');
  assert.equal(failing.transient, true);
  const exits = await live.fetchCodexUsageCli(fakeCodex(root, {}, { exitOn: 'account/rateLimits/read' }), home);
  assert.equal(exits.message, 'Codex CLI: codex app-server exited (3): boom');
  // A `result: null` answer is treated as an empty object: no windows rather than a crash.
  const empty = await live.fetchCodexUsageCli(fakeCodex(root, { 'account/rateLimits/read': null }), home);
  assert.equal(empty.message, 'Codex CLI returned no rate-limit windows.');
});

test('Codex CLI: initialize failure names the failing step', async (t) => {
  const root = temporary(t);
  const cli = require('./fixtures/live/helpers').fakeCli(root, `
require('readline').createInterface({ input: process.stdin }).on('line', (line) => {
  console.log(JSON.stringify({ id: JSON.parse(line).id, error: {} }));
});`, 'bad-init');
  const result = await live.fetchCodexUsageCli(cli, codexHome(root));
  assert.equal(result.message, 'Codex CLI: initialize failed: unknown error');
});

test('Codex CLI: an app-server that closes its input fails the reading instead of crashing the service', { skip: process.platform === 'win32' }, async (t) => {
  const root = temporary(t);
  // Answers `initialize` after closing stdin, so the next request is written into a closed pipe (EPIPE),
  // and stays alive so the pipe error, not the exit, ends the call. An unhandled EPIPE used to kill the service.
  const cli = path.join(root, 'closed-input');
  fs.writeFileSync(cli, `#!/bin/sh\nread line\nexec 0<&-\necho '{"id":1,"result":{}}'\nsleep 5\n`, { mode: 0o755 });
  const result = await live.fetchCodexUsageCli(cli, codexHome(root));
  assert.match(result.message, /^Codex CLI: codex app-server closed its input \(.*EPIPE.*\)/);
  assert.equal(result.transient, true);
});

const creditCases = [
  ['zero available', { availableCount: 0 }, { availableCount: 0 }],
  ['one available has no total', { availableCount: 1, credits: [{ status: 'available', expiresAt: 5 }] }, { availableCount: 1, earliestExpiresAt: 5 }],
  ['several available report a total equal to the count', { availableCount: 3 }, { availableCount: 3, totalCount: 3 }],
  ['non-available and non-numeric expiries are ignored', { availableCount: 1, credits: [{ status: 'expired', expiresAt: 1 }, { status: 'available', expiresAt: 'soon' }] }, { availableCount: 1 }],
  ['null credits list', { availableCount: 2, credits: null }, { availableCount: 2, totalCount: 2 }],
  ['negative count is not trusted', { availableCount: -1 }, undefined],
  ['fractional count is not trusted', { availableCount: 1.5 }, undefined],
  ['missing count is not trusted', { credits: [] }, undefined],
  ['null block', null, undefined]
];
for (const [name, block, expected] of creditCases) {
  test(`Codex reset credits: ${name}`, async (t) => {
    const root = temporary(t);
    const cli = fakeCodex(root, { 'account/rateLimits/read': limits({ rateLimitResetCredits: block }) });
    const usage = ok(await live.fetchCodexUsageCli(cli, codexHome(root)));
    assert.deepEqual(usage.resetCredits, expected);
  });
}

test('fetchCodexResetCreditsCli: reads credits, and swallows every failure as undefined', async (t) => {
  const root = temporary(t);
  const home = codexHome(root);
  const cli = fakeCodex(root, { 'account/rateLimits/read': limits({ rateLimitResetCredits: { availableCount: 1, credits: [{ status: 'available', expiresAt: 42 }] } }) });
  assert.deepEqual(await live.fetchCodexResetCreditsCli(cli, home), { availableCount: 1, earliestExpiresAt: 42 });
  assert.equal(await live.fetchCodexResetCreditsCli(cli, codexHome(temporary(t), null)), undefined);
  assert.equal(await live.fetchCodexResetCreditsCli(path.join(root, 'missing'), home), undefined);
  assert.equal(await live.fetchCodexResetCreditsCli(fakeCodex(root, { 'account/rateLimits/read': { error: 'x' } }), home), undefined);
});

test('formatEarnedResets: observed totals only count when they exceed one and cover the available count', () => {
  assert.equal(live.formatEarnedResets(undefined), undefined);
  assert.equal(live.formatEarnedResets({ availableCount: 2 }), '2 available');
  assert.equal(live.formatEarnedResets({ availableCount: 2, totalCount: 3 }), '2 of 3 observed available');
  assert.equal(live.formatEarnedResets({ availableCount: 2 }, 4), '2 of 4 observed available');
  assert.equal(live.formatEarnedResets({ availableCount: 3 }, 2), '3 available');
  assert.equal(live.formatEarnedResets({ availableCount: 1, totalCount: 1 }), '1 available');
  assert.equal(live.formatEarnedResets({ availableCount: 0, totalCount: 2 }), '0 of 2 observed available');
});

test('consumeCodexResetCredit: maps every known outcome and rejects unknown ones', async (t) => {
  const root = temporary(t);
  for (const outcome of ['reset', 'alreadyRedeemed', 'nothingToReset', 'noCredit']) {
    const cli = fakeCodex(root, { 'account/rateLimitResetCredit/consume': { outcome } });
    assert.equal(await live.consumeCodexResetCredit(cli, codexHome(root), process.env, 'key-1'), outcome);
  }
  const odd = fakeCodex(root, { 'account/rateLimitResetCredit/consume': { outcome: 'exploded' } });
  await assert.rejects(live.consumeCodexResetCredit(odd, codexHome(root), process.env, 'key-1'), /Unexpected Codex reset outcome: exploded/);
  const failing = fakeCodex(root, { 'account/rateLimitResetCredit/consume': { error: 'denied' } });
  await assert.rejects(live.consumeCodexResetCredit(failing, codexHome(root), process.env, 'key-1'), /account\/rateLimitResetCredit\/consume failed: denied/);
});

// --- login verification ------------------------------------------------------------------------

const idToken = (claims) => jwt(claims);
const authClaims = (id) => ({ 'https://api.openai.com/auth': { chatgpt_account_id: id } });

const compareCases = [
  ['no login at all', {}, {}, 'mismatch', /no login/],
  ['api key expected and reported', { OPENAI_API_KEY: 'sk-fake' }, { authMethod: 'apikey' }, 'match', /API-key login, as the profile stores/],
  ['api key expected, chatgpt reported', { OPENAI_API_KEY: 'sk-fake' }, { authMethod: 'chatgpt' }, 'mismatch', /chatgpt login, but the profile stores an API key only/],
  ['chatgpt expected, api key reported', { tokens: { access_token: 'a' } }, { authMethod: 'apikey' }, 'mismatch', /stores a ChatGPT login/],
  ['same account id (explicit vs token)', { tokens: { account_id: 'acct-1', access_token: 'a' } }, { authMethod: 'chatgpt', authToken: jwt(authClaims('acct-1')) }, 'match', /account acct-1/],
  ['different account id', { tokens: { account_id: 'acct-1', access_token: 'a' } }, { authMethod: 'chatgpt', authToken: jwt(authClaims('acct-2')) }, 'mismatch', /account acct-2, expected acct-1/],
  ['id taken from the stored id_token', { tokens: { id_token: idToken(authClaims('acct-9')) } }, { authMethod: 'chatgpt', authToken: jwt(authClaims('acct-9')) }, 'match', /acct-9/],
  ['id taken from the stored access token', { tokens: { access_token: jwt(authClaims('acct-7')) } }, { authMethod: 'chatgpt', authToken: jwt(authClaims('acct-7')) }, 'match', /acct-7/],
  ['emails compared case-insensitively', { tokens: { id_token: idToken({ email: 'User1@Example.com' }) } }, { account: { type: 'chatgpt', email: 'user1@example.COM' } }, 'match', /login user1@example\.COM/],
  ['different email', { tokens: { id_token: idToken({ email: 'user1@example.com' }) } }, { account: { type: 'chatgpt', email: 'user2@example.com' } }, 'mismatch', /expected user1@example\.com/],
  ['nothing comparable', { tokens: { access_token: 'opaque' } }, { authMethod: 'chatgpt' }, 'unverified', /neither an account id nor an email/]
];
for (const [name, expected, status, outcome, detail] of compareCases) {
  test(`compareCodexAccount: ${name}`, () => {
    const result = live.compareCodexAccount(expected, status);
    assert.equal(result.status, outcome);
    assert.match(result.detail, detail);
  });
}

test('verifyCodexNativeAccount: uses getAuthStatus, falls back to account/read, reports failures', async (t) => {
  const root = temporary(t);
  const home = codexHome(root);
  const expected = { tokens: { account_id: 'acct-1', access_token: 'a' } };
  const viaStatus = fakeCodex(root, { getAuthStatus: { authMethod: 'chatgpt', authToken: jwt(authClaims('acct-1')) } });
  assert.equal((await live.verifyCodexNativeAccount(expected, viaStatus, home)).status, 'match');

  // An empty getAuthStatus answer triggers the account/read fallback, which only has an email.
  const fallback = fakeCodex(root, { getAuthStatus: {}, 'account/read': { account: { type: 'chatgpt', email: 'user1@example.com' } } });
  const emailExpected = { tokens: { id_token: jwt({ email: 'user1@example.com' }) } };
  assert.equal((await live.verifyCodexNativeAccount(emailExpected, fallback, home)).status, 'match');

  const bothFail = fakeCodex(root, { getAuthStatus: { error: 'no' }, 'account/read': { error: 'still no' } });
  const failed = await live.verifyCodexNativeAccount(expected, bothFail, home);
  assert.equal(failed.status, 'unverified');
  assert.match(failed.detail, /login verification failed: getAuthStatus failed: no/);

  const missing = await live.verifyCodexNativeAccount(expected, path.join(root, 'nope'), home);
  assert.equal(missing.status, 'unverified');
  assert.match(missing.detail, /not found; the switch could not be verified/);
});

test('refreshCodexNativeLogin: true when the app-server answers, false otherwise', async (t) => {
  const root = temporary(t);
  const home = codexHome(root);
  assert.equal(await live.refreshCodexNativeLogin(fakeCodex(root, { getAuthStatus: {} }), home), true);
  assert.equal(await live.refreshCodexNativeLogin(fakeCodex(root, { getAuthStatus: { error: 'x' } }), home), false);
  assert.equal(await live.refreshCodexNativeLogin(path.join(root, 'nope'), home), false);
});
