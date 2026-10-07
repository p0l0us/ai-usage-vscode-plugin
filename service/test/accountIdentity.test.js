const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { codexCredentialEmail, claudeAccountFileEmail, fetchClaudeProfileEmail, fetchClaudeProfileResult, parseRetryAfterMs,
  resolveCredentialEmail, syncClaudeAccountFile, replaceStaleClaudeAccount, activateClaudeAccountMetadata,
  claudeAccountFileConfirms } = require('../out/accountIdentity');

const jwt = claims => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;

test('Codex email comes from the id token claim only', () => {
  assert.equal(codexCredentialEmail({ tokens: { id_token: jwt({ email: 'user@example.com' }), access_token: jwt({}) } }), 'user@example.com');
  assert.equal(codexCredentialEmail({ tokens: { access_token: jwt({ email: 'x@y.z' }) } }), undefined);
  assert.equal(codexCredentialEmail({ OPENAI_API_KEY: 'sk-test' }), undefined);
  assert.equal(codexCredentialEmail({ tokens: { id_token: 'not-a-jwt' } }), undefined);
});

test('Claude account file email is used only for the matching account UUID', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-identity-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, '.claude.json');
  fs.writeFileSync(file, JSON.stringify({ oauthAccount: { accountUuid: 'account-1', emailAddress: 'me@example.com', organizationUuid: 'org-1' } }));
  assert.equal(claudeAccountFileEmail({ claudeAiOauth: {}, accountUuid: 'account-1' }, file), 'me@example.com');
  assert.equal(claudeAccountFileEmail({ claudeAiOauth: {}, accountUuid: 'account-2' }, file), undefined);
  assert.equal(claudeAccountFileEmail({ claudeAiOauth: {}, organizationUuid: 'org-1' }, file), undefined);
  assert.equal(claudeAccountFileEmail({ claudeAiOauth: {} }, path.join(dir, 'missing.json')), undefined);
});

test('Claude profile endpoint is asked with the access token and tolerates failures', async () => {
  const calls = [];
  const ok = async (url, init) => { calls.push([url, init.headers.Authorization]); return { status: 200, json: async () => ({ account: { uuid: 'account-live', email: 'live@example.com' } }) }; };
  assert.equal(await fetchClaudeProfileEmail({ claudeAiOauth: { accessToken: 'tok' } }, ok), 'live@example.com');
  assert.deepEqual(calls, [['https://api.anthropic.com/api/oauth/profile', 'Bearer tok']]);
  assert.equal(await fetchClaudeProfileEmail({ claudeAiOauth: { accessToken: 'tok' } }, async () => ({ status: 401, json: async () => ({}) })), undefined);
  assert.equal(await fetchClaudeProfileEmail({ claudeAiOauth: { accessToken: 'tok' } }, async () => { throw new Error('offline'); }), undefined);
  assert.equal(await fetchClaudeProfileEmail({ claudeAiOauth: {} }, ok), undefined);
});

test('Claude account synchronization replaces identity, clears account caches and preserves settings', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-identity-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, '.claude.json');
  fs.writeFileSync(file, JSON.stringify({ theme: 'dark', oauthAccount: { accountUuid: 'old', emailAddress: 'old@example.com' },
    cachedUsageUtilization: { five_hour: 99 }, modelAccessCache: { old: true } }));
  syncClaudeAccountFile({
    account: { uuid: 'new', email: 'new@example.com', display_name: 'New User', full_name: 'New User', created_at: '2026-01-01' },
    organization: { uuid: 'org', name: 'Team', organization_type: 'claude_team', rate_limit_tier: 'tier', seat_tier: 'seat' }
  }, file, 1234);
  const result = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(result.theme, 'dark');
  assert.deepEqual(result.oauthAccount, {
    accountUuid: 'new', emailAddress: 'new@example.com', organizationUuid: 'org', accountCreatedAt: '2026-01-01',
    seatTier: 'seat', displayName: 'New User', fullName: 'New User', profileFetchedAt: 1234,
    organizationName: 'Team', organizationType: 'claude_team', organizationRateLimitTier: 'tier'
  });
  assert.equal(result.cachedUsageUtilization, undefined);
  assert.equal(result.modelAccessCache, undefined);
});

test('resolveCredentialEmail never throws for unusable credentials', async () => {
  assert.equal(await resolveCredentialEmail('codex', {}), undefined);
});

test('Retry-After is read as a delay in seconds or as a date', () => {
  assert.equal(parseRetryAfterMs('30'), 30_000);
  assert.equal(parseRetryAfterMs(' 0 '), 0);
  assert.equal(parseRetryAfterMs(undefined), undefined);
  assert.equal(parseRetryAfterMs('soon'), undefined);
  assert.equal(parseRetryAfterMs('Fri, 18 Sep 2026 12:00:30 GMT', Date.parse('Fri, 18 Sep 2026 12:00:00 GMT')), 30_000);
});

test('a failed profile lookup reports why, so 401 and 429 are not the same log line', async () => {
  const rateLimited = await fetchClaudeProfileResult({ claudeAiOauth: { accessToken: 'tok' } },
    async () => ({ status: 429, headers: { get: name => (name === 'retry-after' ? '12' : null) }, json: async () => ({}) }));
  assert.equal(rateLimited.status, 429);
  assert.equal(rateLimited.retryAfterMs, 12_000);
  assert.match(rateLimited.error, /HTTP 429/);
  const unauthorized = await fetchClaudeProfileResult({ claudeAiOauth: { accessToken: 'tok' } }, async () => ({ status: 401, json: async () => ({}) }));
  assert.match(unauthorized.error, /HTTP 401/);
  assert.equal(unauthorized.retryAfterMs, undefined);
  const offline = await fetchClaudeProfileResult({ claudeAiOauth: { accessToken: 'tok' } }, async () => { throw new Error('offline'); });
  assert.match(offline.error, /could not be reached: offline/);
  assert.match((await fetchClaudeProfileResult({ claudeAiOauth: {} })).error, /no access token/);
});

function accountFile(t, document) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-identity-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, '.claude.json');
  fs.writeFileSync(file, JSON.stringify(document));
  return file;
}

test('a stale account identity is replaced by what the activated profile is known to hold', t => {
  const file = accountFile(t, { theme: 'dark', oauthAccount: { accountUuid: 'old', emailAddress: 'old@example.com', seatTier: 'seat' },
    cachedUsageUtilization: { five_hour: 99 }, modelAccessCache: { old: true } });
  assert.equal(replaceStaleClaudeAccount({ accountId: 'new', email: 'new@example.com' }, file), 'replaced');
  const result = JSON.parse(fs.readFileSync(file, 'utf8'));
  // Only the identity is asserted; the rest is left for Claude Code to fetch, which profileFetchedAt's absence invites.
  assert.deepEqual(result.oauthAccount, { accountUuid: 'new', emailAddress: 'new@example.com' });
  assert.equal(result.cachedUsageUtilization, undefined);
  assert.equal(result.modelAccessCache, undefined);
  assert.equal(result.theme, 'dark');
});

test('a stale account identity is removed when nothing is known about the activated profile', t => {
  const file = accountFile(t, { oauthAccount: { accountUuid: 'old', emailAddress: 'old@example.com' }, hasAvailableSubscription: true });
  assert.equal(replaceStaleClaudeAccount({}, file), 'removed');
  const result = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(result.oauthAccount, undefined);
  assert.equal(result.hasAvailableSubscription, undefined);
});

test('the account file is left alone when it already names the activated login', t => {
  const rich = { accountUuid: 'new', emailAddress: 'new@example.com', seatTier: 'seat', profileFetchedAt: 7 };
  const file = accountFile(t, { oauthAccount: rich, cachedUsageUtilization: { five_hour: 1 } });
  assert.equal(replaceStaleClaudeAccount({ accountId: 'new', email: 'new@example.com' }, file), 'kept');
  const result = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(result.oauthAccount, rich);
  assert.deepEqual(result.cachedUsageUtilization, { five_hour: 1 });
  assert.equal(replaceStaleClaudeAccount({ accountId: 'new' }, path.join(path.dirname(file), 'missing.json')), 'kept');
});

test('an activation the profile endpoint cannot confirm still stops Claude reporting the previous account', async t => {
  const file = accountFile(t, { oauthAccount: { accountUuid: 'old', emailAddress: 'old@example.com' }, cachedUsageUtilization: { five_hour: 99 } });
  const outcome = await activateClaudeAccountMetadata({ claudeAiOauth: { accessToken: 'tok' } }, { accountId: 'new', email: 'new@example.com' },
    async () => ({ status: 429, headers: { get: name => (name === 'retry-after' ? '12' : null) }, json: async () => ({}) }), file);
  assert.equal(outcome.status, 'unconfirmed');
  assert.equal(outcome.retryAfterMs, 12_000);
  assert.match(outcome.detail, /HTTP 429/);
  assert.deepEqual(outcome.identity, { accountId: 'new', email: 'new@example.com' });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).oauthAccount, { accountUuid: 'new', emailAddress: 'new@example.com' });
});

test('a confirmed activation writes the live profile the token belongs to', async t => {
  const file = accountFile(t, { oauthAccount: { accountUuid: 'old', emailAddress: 'old@example.com' } });
  const outcome = await activateClaudeAccountMetadata({ claudeAiOauth: { accessToken: 'tok' } }, { accountId: 'guess', email: 'guess@example.com' },
    async () => ({ status: 200, json: async () => ({ account: { uuid: 'live', email: 'live@example.com' }, organization: { uuid: 'org' } }) }), file);
  assert.equal(outcome.status, 'synced');
  assert.deepEqual(outcome.identity, { accountId: 'live', email: 'live@example.com' });
  const account = JSON.parse(fs.readFileSync(file, 'utf8')).oauthAccount;
  assert.equal(account.accountUuid, 'live');
  assert.equal(account.emailAddress, 'live@example.com');
  assert.equal(account.organizationUuid, 'org');
});

test('a fetched identity for the activated account ends the background retry', t => {
  const file = accountFile(t, { oauthAccount: { accountUuid: 'new', emailAddress: 'new@example.com', profileFetchedAt: 7 } });
  assert.equal(claudeAccountFileConfirms({ accountId: 'new', email: 'new@example.com' }, file), true);
  assert.equal(claudeAccountFileConfirms({ accountId: 'other' }, file), false);
  // An identity AI Usage wrote itself carries no profileFetchedAt, so it is not treated as confirmed.
  const written = accountFile(t, { oauthAccount: { accountUuid: 'new', emailAddress: 'new@example.com' } });
  assert.equal(claudeAccountFileConfirms({ accountId: 'new' }, written), false);
  assert.equal(claudeAccountFileConfirms({ email: 'new@example.com' }, file), false);
});
