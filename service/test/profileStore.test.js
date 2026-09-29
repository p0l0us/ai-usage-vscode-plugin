const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ProfileStore, validateName } = require('../out/profileStore');

const claudeLogin = (token) => ({ claudeAiOauth: { accessToken: token, refreshToken: `r-${token}`, expiresAt: 9999999999999 } });
const codexLogin = (account) => ({ auth_mode: 'chatgpt', tokens: { access_token: `t-${account}`, refresh_token: `r-${account}`, account_id: account }, last_refresh: '2026-09-29T00:00:00Z' });

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-usage-store-'));
  const claudeHome = path.join(root, 'claude');
  const codexHome = path.join(root, 'codex');
  fs.mkdirSync(claudeHome); fs.mkdirSync(codexHome);
  const env = { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, CODEX_HOME: process.env.CODEX_HOME };
  process.env.CLAUDE_CONFIG_DIR = claudeHome;
  process.env.CODEX_HOME = codexHome;
  t.after(() => {
    for (const [key, value] of Object.entries(env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const nativeClaude = path.join(claudeHome, '.credentials.json');
  const nativeCodex = path.join(codexHome, 'auth.json');
  fs.writeFileSync(nativeClaude, JSON.stringify({ ...claudeLogin('a'), mcpOAuth: { keep: true } }));
  fs.writeFileSync(nativeCodex, JSON.stringify(codexLogin('acc-x')));
  const logs = [];
  // Identities come from the token: "a" → a@example.com; unknown tokens have none.
  const identities = { a: { email: 'a@example.com', accountId: 'account-a' }, b: { email: 'b@example.com', accountId: 'account-b' }, ...options.identities };
  const identityOf = async (provider, credential) => {
    if (provider === 'codex') { const id = credential.tokens?.account_id; return { email: id ? `${id}@example.com` : undefined, accountId: id }; }
    return identities[credential.claudeAiOauth?.accessToken] ?? {};
  };
  const store = new ProfileStore(path.join(root, 'profiles.json'), (message) => logs.push(message), identityOf);
  return { root, store, logs, nativeClaude, nativeCodex, claudeHome, readNative: (file) => JSON.parse(fs.readFileSync(file, 'utf8')) };
}

test('saving the native login creates an active profile with its identity, and the file is private', async (t) => {
  const f = fixture(t);
  const outcome = await f.store.saveNative('claude', { name: 'Work' });
  assert.equal(outcome.status, 'saved');
  assert.equal(outcome.profile.email, 'a@example.com');
  assert.equal(outcome.profile.accountId, 'account-a');
  assert.equal(f.store.activeProfileId('claude'), outcome.profile.id);
  assert.equal(f.store.activeProfileName('claude'), 'Work');
  assert.equal(f.store.profileCount('claude'), 1);
  assert.ok(f.store.hasCredential('claude', outcome.profile.id));
  assert.equal(f.store.profiles('claude')[0].credential, undefined, 'metadata never carries the login');
  if (process.platform !== 'win32') { assert.equal(fs.statSync(path.join(f.root, 'profiles.json')).mode & 0o777, 0o600); }
  assert.equal(validateName(''), 'Enter a profile name.');
  assert.equal(validateName('   '), 'Enter a profile name.');
  assert.equal(validateName('x'.repeat(61)), 'Use 60 characters or fewer.');
  await assert.rejects(f.store.saveNative('claude', { name: 'work' }), /already exists/);
});

test('a login that is already saved is reported as a duplicate unless a copy is allowed', async (t) => {
  const f = fixture(t);
  await f.store.saveNative('claude', { name: 'Work' });
  const duplicate = await f.store.saveNative('claude', { name: 'Again' });
  assert.equal(duplicate.status, 'duplicate');
  assert.equal(duplicate.twin.name, 'Work');
  assert.match(duplicate.warning, /already saved as “Work”/);
  const copy = await f.store.saveNative('claude', { name: 'Again', allowDuplicate: true });
  assert.equal(copy.status, 'saved');
  assert.equal(f.store.profileCount('claude'), 2);
});

test('importing a credential saves it without activating; activating writes the native file and keeps MCP entries', async (t) => {
  const f = fixture(t);
  const work = await f.store.saveNative('claude', { name: 'Work' });
  const imported = await f.store.importCredential('claude', 'Backup', claudeLogin('b'));
  assert.equal(imported.status, 'saved');
  assert.equal(f.store.activeProfileId('claude'), work.profile.id);
  assert.equal(f.readNative(f.nativeClaude).claudeAiOauth.accessToken, 'a');
  const outcome = await f.store.activateProfile('claude', imported.profile.id);
  assert.equal(outcome.level, 'info');
  assert.equal(outcome.accountChanged, true);
  assert.match(outcome.message, /Claude switched to “Backup”/);
  assert.equal(f.store.activeProfileId('claude'), imported.profile.id);
  const native = f.readNative(f.nativeClaude);
  assert.equal(native.claudeAiOauth.accessToken, 'b');
  assert.deepEqual(native.mcpOAuth, { keep: true });
  // Re-activating the same profile is not an account change.
  assert.equal((await f.store.activateProfile('claude', imported.profile.id)).accountChanged, false);
});

test('the verifier decides what the outcome says, and a Claude mismatch of account ids is reported as an error', async (t) => {
  const f = fixture(t);
  const work = await f.store.saveNative('claude', { name: 'Work' });
  f.store.verifyActivation = async () => ({ status: 'unverified', detail: 'rate limited' });
  assert.equal((await f.store.activateProfile('claude', work.profile.id)).level, 'warning');
  f.store.verifyActivation = async () => ({ status: 'match', detail: 'ok', email: 'other@example.com', accountId: 'account-other' });
  const mismatch = await f.store.activateProfile('claude', work.profile.id);
  assert.equal(mismatch.level, 'error');
  assert.match(mismatch.message, /reports a different login/);
  // A match with a new account id upgrades legacy metadata instead.
  const imported = await f.store.importCredential('claude', 'Legacy', claudeLogin('legacy'));
  assert.equal(imported.profile.accountId, undefined);
  f.store.verifyActivation = async () => ({ status: 'match', detail: 'ok', email: 'legacy@example.com', accountId: 'account-legacy' });
  const upgraded = await f.store.activateProfile('claude', imported.profile.id);
  assert.equal(upgraded.level, 'info');
  assert.equal(f.store.profile('claude', imported.profile.id).accountId, 'account-legacy');
});

test('a native login switched outside the service makes its saved profile active; an unsaved one leaves no number', async (t) => {
  const f = fixture(t);
  const work = await f.store.saveNative('claude', { name: 'Work' });
  const backup = await f.store.importCredential('claude', 'Backup', claudeLogin('b'));
  fs.writeFileSync(f.nativeClaude, JSON.stringify(claudeLogin('b')));
  assert.equal(await f.store.followNative('claude'), true);
  assert.equal(f.store.activeProfileId('claude'), backup.profile.id);
  assert.equal(f.store.activeProfileNumber('claude'), 2);
  assert.equal(await f.store.followNative('claude'), false, 'an unchanged file is not checked again');
  fs.writeFileSync(f.nativeClaude, JSON.stringify(claudeLogin('stranger')));
  assert.equal(await f.store.followNative('claude'), false);
  assert.equal(f.store.activeProfileId('claude'), backup.profile.id, 'the active profile is kept');
  assert.equal(f.store.activeProfileNumber('claude'), undefined);
  assert.equal(f.store.nativeIsUnsaved('claude'), true);
  assert.ok(f.logs.some((line) => /not one of the saved profiles/.test(line)));
  assert.equal(await f.store.matchesNative('claude', work.profile.id), false);
});

test('refreshed tokens are written back only while the stored and native logins are still the ones that were read', async (t) => {
  const f = fixture(t);
  const work = await f.store.saveNative('claude', { name: 'Work' });
  const before = await f.store.credential('claude', work.profile.id);
  const after = claudeLogin('a-refreshed');
  await f.store.refreshedCredential('claude', work.profile.id, before, after);
  assert.equal(f.readNative(f.nativeClaude).claudeAiOauth.accessToken, 'a-refreshed');
  assert.deepEqual(await f.store.credential('claude', work.profile.id), after);
  // Someone else changed the native login meanwhile: the stale refresh is dropped.
  fs.writeFileSync(f.nativeClaude, JSON.stringify(claudeLogin('manual')));
  await f.store.refreshedCredential('claude', work.profile.id, after, claudeLogin('late'));
  assert.equal(f.readNative(f.nativeClaude).claudeAiOauth.accessToken, 'manual');
});

test('rename, delete and resolve by name, number, id or email', async (t) => {
  const f = fixture(t);
  const work = await f.store.saveNative('claude', { name: 'Work' });
  const backup = await f.store.importCredential('claude', 'Backup', claudeLogin('b'));
  assert.equal(f.store.resolve('claude', 'backup').id, backup.profile.id);
  assert.equal(f.store.resolve('claude', '#1').id, work.profile.id);
  assert.equal(f.store.resolve('claude', '2').id, backup.profile.id);
  assert.equal(f.store.resolve('claude', work.profile.id).id, work.profile.id);
  assert.equal(f.store.resolve('claude', 'B@example.com').id, backup.profile.id);
  assert.equal(f.store.resolve('claude', 'nobody'), undefined);
  assert.equal(f.store.rename('claude', backup.profile.id, 'Spare').name, 'Spare');
  assert.throws(() => f.store.rename('claude', backup.profile.id, 'work'), /already exists/);
  const deleted = f.store.delete('claude', work.profile.id);
  assert.equal(deleted.wasActive, true);
  assert.equal(f.store.activeProfileId('claude'), undefined);
  assert.deepEqual(f.store.profiles('claude').map((profile) => profile.name), ['Spare']);
  assert.equal(f.readNative(f.nativeClaude).claudeAiOauth.accessToken, 'a', 'the native login stays until the next switch');
});

test('export and import move profiles between stores, restore a missing login and activate nothing', async (t) => {
  const f = fixture(t);
  await f.store.saveNative('claude', { name: 'Work' });
  const codex = await f.store.saveNative('codex', { name: 'Main' });
  const { entries, missing } = f.store.exportEntries();
  assert.deepEqual(entries.map((entry) => [entry.provider, entry.name]), [['claude', 'Work'], ['codex', 'Main']]);
  assert.deepEqual(missing, []);
  const other = new ProfileStore(path.join(f.root, 'other.json'), () => undefined, async () => ({}));
  const plans = other.planImport(entries);
  assert.deepEqual(plans.map((plan) => plan.kind), ['new', 'new']);
  const outcome = await other.applyImport(plans);
  assert.equal(outcome.imported, 2);
  assert.match(outcome.summary, /2 added/);
  assert.deepEqual(other.profiles('codex').map((profile) => profile.id), [codex.profile.id]);
  assert.equal(other.activeProfileId('claude'), undefined);
  // A profile whose login was lost gets it back from the export.
  const damaged = JSON.parse(fs.readFileSync(path.join(f.root, 'other.json'), 'utf8'));
  delete damaged.codex.profiles[0].credential;
  fs.writeFileSync(path.join(f.root, 'other.json'), JSON.stringify(damaged));
  assert.equal(other.hasCredential('codex', codex.profile.id), false);
  const again = other.planImport(entries);
  assert.deepEqual(again.map((plan) => plan.kind), ['same', 'restore']);
  await other.applyImport(again.filter((plan) => plan.kind === 'restore'));
  assert.equal(other.hasCredential('codex', codex.profile.id), true);
});

test('replacing the login of the active profile replaces the native login as well', async (t) => {
  const f = fixture(t);
  const main = await f.store.saveNative('codex', { name: 'Main' });
  assert.equal(await f.store.replaceCredential('codex', main.profile.id, codexLogin('acc-new')), true);
  assert.equal(f.readNative(f.nativeCodex).tokens.account_id, 'acc-new');
  assert.equal(f.store.profile('codex', main.profile.id).accountId, 'acc-new');
  const spare = await f.store.importCredential('codex', 'Spare', codexLogin('acc-spare'));
  assert.equal(await f.store.replaceCredential('codex', spare.profile.id, codexLogin('acc-spare-2')), false);
  assert.equal(f.readNative(f.nativeCodex).tokens.account_id, 'acc-new');
});
