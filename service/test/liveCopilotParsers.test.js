const assert = require('node:assert/strict');
const test = require('node:test');
const live = require('../out/live');
const { fixture, stubFetch, reply } = require('./fixtures/live/helpers');

const accounts = (...logins) => async () => logins.map((login) => ({ login, token: `tok-${login}` }));
const optionsFor = (extra = {}) => ({ workspaceOwners: [], ...extra });
const userBody = () => JSON.parse(fixture('copilotUser.json'));

/** Routes by URL; `perToken` maps a token to the Copilot user response it should get. */
function routes(t, { perToken = {}, status = {}, org = {} } = {}) {
  return stubFetch(t, (url, init) => {
    const token = init.headers.Authorization.replace('token ', '');
    if (url.endsWith('/copilot_internal/user')) {
      const forced = status[token];
      if (forced) { return reply(forced.status, forced.body ?? '', forced.headers); }
      return reply(200, perToken[token] ?? userBody());
    }
    if (url.includes('/copilot/billing')) { return org.billing ?? reply(404, ''); }
    if (url.includes('/premium_request/usage')) { return org.premium ?? reply(403, ''); }
    throw new Error(`unexpected ${url}`);
  });
}

test('Copilot: fixture maps quotas to used percent with the billing reset date, skipping unlimited ones', async (t) => {
  routes(t);
  const logs = [];
  const result = await live.fetchCopilotUsage(accounts('user1'), optionsFor({ log: (m) => logs.push(m) }));
  assert.equal(result.kind, 'ok');
  const usage = result.usage;
  assert.deepEqual(usage.windows.map((w) => [w.label, w.usedPercent, w.resetsAt.toISOString()]), [
    ['month', 19.5, '2026-11-01T00:00:00.000Z'],
    ['completions', 40, '2026-11-01T00:00:00.000Z']
  ]);
  assert.equal(usage.plan, 'business');
  assert.equal(usage.subtitle, 'acme-example', 'a business seat with one org is billed to it');
  assert.deepEqual(usage.details.slice(0, 3), [
    'Account: user1', 'Premium requests: 59 of 300', 'Billed to organization: acme-example'
  ]);
  assert.ok(logs.some((line) => /plan=business .*chat=unlimited/.test(line)), logs.join('\n'));
});

test('Copilot: org details add seat counts and premium request cost, or the admin hint', async (t) => {
  routes(t, { org: {
    billing: reply(200, { seat_breakdown: { total: 12, active_this_cycle: 9 }, plan_type: 'business' }),
    premium: reply(200, { usageItems: [{ grossQuantity: 100.4, grossAmount: 4, netAmount: 1.5 }, { quantity: 20, grossAmount: 1, netAmount: 0 }] })
  } });
  const withOrg = await live.fetchCopilotUsage(accounts('user1'), optionsFor());
  assert.deepEqual(withOrg.usage.details.slice(3), [
    'Org seats: 12, 9 active this cycle (business)',
    'Org premium requests this month: 120, $1.50 billed of $5.00 gross'
  ]);
  routes(t);
  const denied = await live.fetchCopilotUsage(accounts('user1'), optionsFor());
  assert.deepEqual(denied.usage.details.slice(3), ['Org-wide usage report needs organization admin access.']);
});

test('Copilot: no accounts, or accounts throwing, is unavailable', async (t) => {
  const calls = routes(t);
  const logs = [];
  const none = await live.fetchCopilotUsage(accounts(), optionsFor({ log: (m) => logs.push(m) }));
  assert.deepEqual(none, { kind: 'unavailable', provider: 'copilot', reason: 'No GitHub sign-in is visible to this extension.' });
  const thrown = await live.fetchCopilotUsage(async () => { throw new Error('no session'); }, optionsFor());
  assert.equal(thrown.kind, 'unavailable');
  assert.equal(calls.length, 0);
  assert.match(logs[0], /no GitHub session available/);
});

test('Copilot: account choice prefers the configured login, then the workspace org, then the owner login', async (t) => {
  const plain = (extra) => ({ ...userBody(), organization_login_list: [], access_type_sku: 'individual', copilot_plan: 'individual', ...extra });
  routes(t, { perToken: {
    'tok-alice': plain({ quota_snapshots: { premium_interactions: { percent_remaining: 90 } } }),
    'tok-Bob': plain({ organization_login_list: ['team-org'], quota_snapshots: { premium_interactions: { percent_remaining: 50 } } }),
    'tok-carol': plain({ quota_snapshots: { premium_interactions: { percent_remaining: 10 } } })
  } });
  const used = async (options) => (await live.fetchCopilotUsage(accounts('alice', 'Bob', 'carol'), optionsFor(options))).usage.windows[0].usedPercent;
  assert.equal(await used({}), 10, 'default: first ok account');
  assert.equal(await used({ preferredLogin: 'CAROL' }), 90, 'preferred login is case-insensitive');
  assert.equal(await used({ preferredLogin: 'nobody' }), 10);
  assert.equal(await used({ workspaceOwners: ['TEAM-org'] }), 50, 'workspace org membership');
  assert.equal(await used({ workspaceOwners: ['carol'] }), 90, 'owner login match');
});

test('Copilot: 403 and 404 mean no seat; the reason names every account tried', async (t) => {
  routes(t, { status: { 'tok-a': { status: 403 }, 'tok-b': { status: 404 } } });
  assert.deepEqual(await live.fetchCopilotUsage(accounts('a', 'b'), optionsFor()), {
    kind: 'unavailable', provider: 'copilot', reason: 'No Copilot seat found on a, b.'
  });
});

const errorCases = [
  ['401 rejects the token', { status: 401 }, 'a: GitHub token rejected. Sign in to GitHub again.', 401, undefined, undefined],
  ['429 with Retry-After', { status: 429, headers: { 'retry-after': '45' } }, 'a: Rate limited by GitHub.', 429, true, 45_000],
  ['500 is transient', { status: 500 }, 'a: Unexpected response (HTTP 500).', 500, true, undefined],
  ['418 is not', { status: 418 }, 'a: Unexpected response (HTTP 418).', 418, false, undefined],
  ['200 with a non-object body', { status: 200, body: '"hello"' }, 'a: Unexpected response (HTTP 200).', 200, false, undefined]
];
for (const [name, forced, message, status, transient, retryAfterMs] of errorCases) {
  test(`Copilot: ${name}`, async (t) => {
    routes(t, { status: { 'tok-a': forced } });
    assert.deepEqual(await live.fetchCopilotUsage(accounts('a'), optionsFor()), {
      kind: 'error', provider: 'copilot', title: 'Copilot', message, status, transient, retryAfterMs
    });
  });
}

test('Copilot: a network failure is transient; a healthy account beats a failing one', async (t) => {
  stubFetch(t, (url, init) => {
    if (init.headers.Authorization === 'token tok-a') { throw new Error('ETIMEDOUT'); }
    return reply(200, userBody());
  });
  const down = await live.fetchCopilotUsage(accounts('a'), optionsFor());
  assert.deepEqual(down, { kind: 'error', provider: 'copilot', title: 'Copilot', message: 'a: Request failed: ETIMEDOUT',
    status: undefined, transient: true, retryAfterMs: undefined });
  const mixed = await live.fetchCopilotUsage(accounts('a', 'b'), optionsFor());
  assert.equal(mixed.kind, 'ok');
  assert.equal(mixed.usage.details[0], 'Account: b');
});

test('Copilot: when every quota is unlimited the result is unavailable with the plan in the reason', async (t) => {
  routes(t, { perToken: { 'tok-a': { copilot_plan: 'enterprise', access_type_sku: 'x', organization_login_list: ['corp'],
    quota_snapshots: { premium_interactions: { unlimited: true }, chat: { unlimited: true } } } } });
  assert.deepEqual(await live.fetchCopilotUsage(accounts('a'), optionsFor({ workspaceOwners: ['corp'] })), {
    kind: 'unavailable', provider: 'copilot', reason: 'a (corp): every Copilot quota is unlimited on the enterprise plan.'
  });
});

test('Copilot: billing org only when the workspace owns it or a business seat has exactly one', async (t) => {
  const body = (extra) => ({ copilot_plan: 'individual', access_type_sku: 'plan', organization_login_list: ['o1', 'o2'],
    quota_snapshots: { premium_interactions: { percent_remaining: 70 } }, ...extra });
  routes(t, { perToken: { 'tok-a': body() } });
  const none = await live.fetchCopilotUsage(accounts('a'), optionsFor());
  assert.equal(none.usage.subtitle, 'a');
  assert.ok(!none.usage.details.some((line) => line.startsWith('Billed to')));
  const owned = await live.fetchCopilotUsage(accounts('a'), optionsFor({ workspaceOwners: ['O2'] }));
  assert.equal(owned.usage.subtitle, 'o2');
  routes(t, { perToken: { 'tok-a': body({ copilot_plan: 'business', organization_login_list: ['o1', 'o2'] }) } });
  const ambiguous = await live.fetchCopilotUsage(accounts('a'), optionsFor());
  assert.equal(ambiguous.usage.subtitle, 'a', 'two orgs and no workspace owner is ambiguous');
});

test('Copilot: premium request details use credits_used when present and need a positive entitlement', async (t) => {
  const premium = (extra) => ({ copilot_plan: 'individual', quota_snapshots: { premium_interactions: { percent_remaining: 50, ...extra } } });
  routes(t, { perToken: { 'tok-a': premium({ entitlement: 1500, credits_used: 1234.6 }) } });
  assert.equal((await live.fetchCopilotUsage(accounts('a'), optionsFor())).usage.details[1], 'Premium requests: 1,235 of 1,500');
  routes(t, { perToken: { 'tok-a': premium({ entitlement: 0, remaining: 0 }) } });
  assert.deepEqual((await live.fetchCopilotUsage(accounts('a'), optionsFor())).usage.details, ['Account: a']);
});

test('Copilot: percent_remaining outside 0-100 is clamped; a quota without it is skipped; no reset date means no resetsAt', async (t) => {
  routes(t, { perToken: { 'tok-a': { copilot_plan: 'individual', quota_snapshots: {
    premium_interactions: { percent_remaining: 120 }, chat: { percent_remaining: -4 }, completions: {} } } } });
  const { usage } = await live.fetchCopilotUsage(accounts('a'), optionsFor());
  assert.deepEqual(usage.windows, [
    { label: 'month', usedPercent: 0, resetsAt: undefined },
    { label: 'chat', usedPercent: 100, resetsAt: undefined }
  ]);
});
