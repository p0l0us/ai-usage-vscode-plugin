const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeJsonAtomically, isSameCredentialOwner } = require('../out/authFiles');

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-files-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

// Codex reloads auth.json on its request path, so it must only ever see complete documents and the
// stored last_refresh must survive unchanged; this is the Stage A contract of the running-session switch.
test('atomic write replaces the file whole, keeps key order and leaves no temporary behind', t => {
  const root = temporary(t);
  const file = path.join(root, 'nested', 'auth.json');
  const document = { auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: { id_token: 'i', access_token: 'a', refresh_token: 'r', account_id: 'acc' }, last_refresh: '2026-09-17T06:02:49Z' };
  writeJsonAtomically(file, document);
  writeJsonAtomically(file, { ...document, tokens: { ...document.tokens, access_token: 'b' } });
  const text = fs.readFileSync(file, 'utf8');
  assert.equal(text, `${JSON.stringify({ ...document, tokens: { ...document.tokens, access_token: 'b' } }, null, 2)}\n`);
  assert.deepEqual(Object.keys(JSON.parse(text)), ['auth_mode', 'OPENAI_API_KEY', 'tokens', 'last_refresh']);
  assert.equal(JSON.parse(text).last_refresh, document.last_refresh);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['auth.json']);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  }
});

test('a failed write leaves the previous document untouched', t => {
  const root = temporary(t);
  const file = path.join(root, 'auth.json');
  writeJsonAtomically(file, { version: 1 });
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(() => writeJsonAtomically(file, cyclic));
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { version: 1 });
  assert.deepEqual(fs.readdirSync(root), ['auth.json']);
});

// Claude Code rotates the refresh token whenever it refreshes the access token, so the stored copy of the
// active profile must be recognised by the organization it belongs to or it is never updated again.
test('a refreshed Claude login with a rotated refresh token still belongs to the same organization', () => {
  const stored = { claudeAiOauth: { accessToken: 'a1', refreshToken: 'r1', expiresAt: 1 }, organizationUuid: 'org-1' };
  const rotated = { claudeAiOauth: { accessToken: 'a2', refreshToken: 'r2', expiresAt: 2 }, organizationUuid: 'org-1' };
  const otherOrganization = { claudeAiOauth: { accessToken: 'a3', refreshToken: 'r3', expiresAt: 3 }, organizationUuid: 'org-2' };
  assert.equal(isSameCredentialOwner('claude', stored, rotated), true);
  assert.equal(isSameCredentialOwner('claude', stored, otherOrganization), false);
  // Same refresh token is still enough when an imported document carries no organization.
  const imported = { claudeAiOauth: { accessToken: 'a1', refreshToken: 'r1' } };
  assert.equal(isSameCredentialOwner('claude', imported, { claudeAiOauth: { accessToken: 'a9', refreshToken: 'r1' }, organizationUuid: 'org-1' }), true);
  assert.equal(isSameCredentialOwner('claude', imported, { claudeAiOauth: { accessToken: 'a9', refreshToken: 'r9' }, organizationUuid: 'org-1' }), false);
});

test('Codex owners are matched by account id before the refresh token', () => {
  const stored = { tokens: { access_token: 'a', refresh_token: 'r1', account_id: 'acc' } };
  assert.equal(isSameCredentialOwner('codex', stored, { tokens: { access_token: 'b', refresh_token: 'r2', account_id: 'acc' } }), true);
  assert.equal(isSameCredentialOwner('codex', stored, { tokens: { access_token: 'b', refresh_token: 'r1', account_id: 'other' } }), false);
});
