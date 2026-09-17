const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { codexCredentialEmail, claudeAccountFileEmail, fetchClaudeProfileEmail, resolveCredentialEmail } = require('../out/accountIdentity');

const jwt = claims => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;

test('Codex email comes from the id token claim only', () => {
  assert.equal(codexCredentialEmail({ tokens: { id_token: jwt({ email: 'user@example.com' }), access_token: jwt({}) } }), 'user@example.com');
  assert.equal(codexCredentialEmail({ tokens: { access_token: jwt({ email: 'x@y.z' }) } }), undefined);
  assert.equal(codexCredentialEmail({ OPENAI_API_KEY: 'sk-test' }), undefined);
  assert.equal(codexCredentialEmail({ tokens: { id_token: 'not-a-jwt' } }), undefined);
});

test('Claude account file email is used only for the matching organization', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-identity-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, '.claude.json');
  fs.writeFileSync(file, JSON.stringify({ oauthAccount: { emailAddress: 'me@example.com', organizationUuid: 'org-1' } }));
  assert.equal(claudeAccountFileEmail({ claudeAiOauth: {}, organizationUuid: 'org-1' }, file), 'me@example.com');
  assert.equal(claudeAccountFileEmail({ claudeAiOauth: {}, organizationUuid: 'org-2' }, file), undefined);
  assert.equal(claudeAccountFileEmail({ claudeAiOauth: {} }, file), 'me@example.com');
  assert.equal(claudeAccountFileEmail({ claudeAiOauth: {} }, path.join(dir, 'missing.json')), undefined);
});

test('Claude profile endpoint is asked with the access token and tolerates failures', async () => {
  const calls = [];
  const ok = async (url, init) => { calls.push([url, init.headers.Authorization]); return { status: 200, json: async () => ({ account: { email: 'live@example.com' } }) }; };
  assert.equal(await fetchClaudeProfileEmail({ claudeAiOauth: { accessToken: 'tok' } }, ok), 'live@example.com');
  assert.deepEqual(calls, [['https://api.anthropic.com/api/oauth/profile', 'Bearer tok']]);
  assert.equal(await fetchClaudeProfileEmail({ claudeAiOauth: { accessToken: 'tok' } }, async () => ({ status: 401, json: async () => ({}) })), undefined);
  assert.equal(await fetchClaudeProfileEmail({ claudeAiOauth: { accessToken: 'tok' } }, async () => { throw new Error('offline'); }), undefined);
  assert.equal(await fetchClaudeProfileEmail({ claudeAiOauth: {} }, ok), undefined);
});

test('resolveCredentialEmail never throws for unusable credentials', async () => {
  assert.equal(await resolveCredentialEmail('codex', {}), undefined);
});
