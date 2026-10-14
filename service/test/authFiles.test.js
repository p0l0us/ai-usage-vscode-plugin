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

// An organization UUID identifies a Team, not one user. Rotated tokens need a live account-UUID comparison.
test('Claude credential ownership never conflates users in the same organization', () => {
  const stored = { claudeAiOauth: { accessToken: 'a1', refreshToken: 'r1', expiresAt: 1 }, organizationUuid: 'org-1' };
  const rotated = { claudeAiOauth: { accessToken: 'a2', refreshToken: 'r2', expiresAt: 2 }, organizationUuid: 'org-1' };
  const otherOrganization = { claudeAiOauth: { accessToken: 'a3', refreshToken: 'r3', expiresAt: 3 }, organizationUuid: 'org-2' };
  assert.equal(isSameCredentialOwner('claude', stored, rotated), false);
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

/** An in-memory macOS Keychain, so no test touches the real login. */
function fakeKeychain(t, items = new Map()) {
  const { setClaudeKeychain } = require('../out/authFiles');
  const writes = [];
  setClaudeKeychain({
    read: (service, account) => items.get(`${service}|${account}`),
    write: (service, account, text) => { writes.push(service); items.set(`${service}|${account}`, text); }
  });
  t.after(() => setClaudeKeychain(undefined));
  return { items, writes };
}

function claudeHome(t) {
  const root = temporary(t);
  const previous = { dir: process.env.CLAUDE_CONFIG_DIR, user: process.env.USER };
  process.env.CLAUDE_CONFIG_DIR = root;
  process.env.USER = 'tester';
  t.after(() => {
    for (const [key, value] of [['CLAUDE_CONFIG_DIR', previous.dir], ['USER', previous.user]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  return root;
}

test('the Claude Keychain item follows Claude Code: plain name by default, a config-dir hash with CLAUDE_CONFIG_DIR', t => {
  const { claudeKeychainItem } = require('../out/authFiles');
  const root = claudeHome(t);
  const hash = require('node:crypto').createHash('sha256').update(root.normalize('NFC')).digest('hex').slice(0, 8);
  assert.deepEqual(claudeKeychainItem(), { service: `Claude Code-credentials-${hash}`, account: 'tester' });
  delete process.env.CLAUDE_CONFIG_DIR;
  assert.deepEqual(claudeKeychainItem(), { service: 'Claude Code-credentials', account: 'tester' });
  process.env.USER = 'not valid';
  assert.equal(claudeKeychainItem().account, 'claude-code-user');
});

test('the native Claude login is read from the Keychain first and saved back there, keeping MCP entries', t => {
  const { readNativeCredential, writeNativeCredential, nativeCredentialLocation, claudeKeychainItem } = require('../out/authFiles');
  const root = claudeHome(t);
  const { service, account } = claudeKeychainItem();
  const { items, writes } = fakeKeychain(t);
  const file = path.join(root, '.credentials.json');
  fs.writeFileSync(file, JSON.stringify({ claudeAiOauth: { accessToken: 'stale-file' } }));
  items.set(`${service}|${account}`, JSON.stringify({ claudeAiOauth: { accessToken: 'keychain', refreshToken: 'r1' }, organizationUuid: 'org-old', mcpOAuth: { server: { token: 'keep' } } }));
  assert.deepEqual(readNativeCredential('claude'), { claudeAiOauth: { accessToken: 'keychain', refreshToken: 'r1' }, organizationUuid: 'org-old' });
  assert.equal(nativeCredentialLocation('claude'), `the macOS Keychain (${service})`);
  writeNativeCredential('claude', { claudeAiOauth: { accessToken: 'switched', refreshToken: 'r2' } });
  assert.deepEqual(writes, [service]);
  assert.deepEqual(JSON.parse(items.get(`${service}|${account}`)), { claudeAiOauth: { accessToken: 'switched', refreshToken: 'r2' }, mcpOAuth: { server: { token: 'keep' } } });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { claudeAiOauth: { accessToken: 'stale-file' } }, 'the file Claude Code ignores is left alone');
});

test('without a Keychain item (or Keychain) the native Claude login stays in .credentials.json, as on Linux', t => {
  const { readNativeCredential, writeNativeCredential, nativeCredentialLocation, setClaudeKeychain } = require('../out/authFiles');
  const root = claudeHome(t);
  const file = path.join(root, '.credentials.json');
  const { writes } = fakeKeychain(t);
  assert.throws(() => readNativeCredential('claude'), /No Claude login was found in the macOS Keychain \(Claude Code-credentials-[0-9a-f]{8}\) or at .*\.credentials\.json\./);
  fs.writeFileSync(file, JSON.stringify({ claudeAiOauth: { accessToken: 'file' }, mcpOAuth: { x: 1 } }));
  assert.deepEqual(readNativeCredential('claude'), { claudeAiOauth: { accessToken: 'file' } });
  writeNativeCredential('claude', { claudeAiOauth: { accessToken: 'next' } });
  assert.deepEqual(writes, [], 'no Keychain item is created');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { claudeAiOauth: { accessToken: 'next' }, mcpOAuth: { x: 1 } });
  setClaudeKeychain(null);
  assert.equal(nativeCredentialLocation('claude'), file);
  fs.rmSync(file);
  assert.throws(() => readNativeCredential('claude'), new RegExp(`^Error: No Claude login was found at ${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.$`));
});

test('an unreadable Keychain falls back to the file, and refuses a switch only when there is no file', t => {
  const { readNativeCredential, writeNativeCredential, setClaudeKeychain } = require('../out/authFiles');
  const root = claudeHome(t);
  const file = path.join(root, '.credentials.json');
  setClaudeKeychain({ read: () => { throw new Error('exit 36'); }, write: () => assert.fail('nothing is written to a locked Keychain') });
  t.after(() => setClaudeKeychain(undefined));
  assert.throws(() => readNativeCredential('claude'), /The Keychain could not be read: exit 36/);
  assert.throws(() => writeNativeCredential('claude', { claudeAiOauth: { accessToken: 'a' } }), /Could not read the Claude login in the macOS Keychain .*: exit 36/);
  fs.writeFileSync(file, JSON.stringify({ claudeAiOauth: { accessToken: 'file' } }));
  assert.deepEqual(readNativeCredential('claude'), { claudeAiOauth: { accessToken: 'file' } });
  writeNativeCredential('claude', { claudeAiOauth: { accessToken: 'b' } });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).claudeAiOauth.accessToken, 'b');
});
